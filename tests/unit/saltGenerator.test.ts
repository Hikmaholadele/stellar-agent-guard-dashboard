import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { StrKey } from "@stellar/stellar-sdk";
import { NETWORK, PHASE1_ARTIFACT, SALT_BYTES } from "../../lib/guard/network.ts";
import {
  contractAlreadyDeployed,
  createSaltAddressPredictor,
  deployPredictionChanges,
  deployPredictionKey,
  deployPredictionProblem,
  describeDeployPrediction,
  expectedAttemptsFor,
  formatExpectedAttempts,
  formatSalt,
  isContractAddress,
  parseSalt,
  predictSaltAddress,
  randomSalt,
  searchVanitySalt,
  validateVanityPattern,
  type DeployPredictionInputs,
  type RandomFiller,
  type VanityProgress,
} from "../../lib/guard/saltGenerator.ts";
import { predictContractId } from "../../lib/guard/chain.ts";

const DEPLOYER = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";
const OTHER_DEPLOYER = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const HEX_SALT = "0123456789abcdef".repeat(4); // exactly 64 characters

/** A filler that writes a fixed byte each time, so "random" is reproducible. */
function constantFiller(byte: number): RandomFiller {
  return (target) => target.fill(byte);
}

function hexPair(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The address a Soroban deploy from `DEPLOYER` with `salt` produces, assembled
 * straight from the XDR layout in the protocol spec rather than through the SDK:
 *
 *   sha256( ENVELOPE_TYPE_CONTRACT_ID(8) ++ networkId ++ FROM_ADDRESS(0)
 *           ++ SC_ADDRESS_TYPE_ACCOUNT(0) ++ ed25519 key type(0) ++ pubkey
 *           ++ salt )
 *
 * Hashing is Node's own SHA-256, not the browser's, so this is an independent
 * second opinion about what `predictContractId` should return.
 */
function contractIdPerSpec(deployer: string, salt: Uint8Array, passphrase: string): string {
  const u32 = (value: number): number[] => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  const hash = (bytes: Uint8Array): Uint8Array =>
    new Uint8Array(createHash("sha256").update(bytes).digest());

  const pubkey = StrKey.decodeEd25519PublicKey(deployer);
  const networkId = hash(new TextEncoder().encode(passphrase));
  const preimage = new Uint8Array(4 + 32 + 4 + 4 + 4 + 32 + 32);
  let at = 0;
  for (const part of [u32(8), networkId, u32(0), u32(0), u32(0), pubkey, salt]) {
    preimage.set(part, at);
    at += part.length;
  }
  return StrKey.encodeContract(hash(preimage));
}

test("a random salt is 32 bytes, and an all-zero one is refused", () => {
  const salt = randomSalt(constantFiller(0x7f));
  assert.equal(salt.length, SALT_BYTES);
  assert.equal(hexPair(salt), "7f".repeat(SALT_BYTES));

  assert.throws(() => randomSalt(constantFiller(0)), /all-zero salt/);
});

test("the real random source is used when none is injected", () => {
  const first = randomSalt();
  const second = randomSalt();
  assert.equal(first.length, SALT_BYTES);
  assert.notEqual(hexPair(first), hexPair(second), "two salts must not repeat");
  assert.ok(first.some((byte) => byte !== 0));
});

test("a hex salt must decode to exactly 32 bytes", () => {
  const parsed = parseSalt(HEX_SALT, "hex");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(hexPair(parsed.bytes), HEX_SALT);
  assert.equal(parsed.paddedBytes, 0);
});

test("0x and upper case are cosmetic, not content", () => {
  const withPrefix = parseSalt(`0x${HEX_SALT.toUpperCase()}`, "hex");
  assert.equal(withPrefix.ok, true);
  if (!withPrefix.ok) return;
  assert.equal(hexPair(withPrefix.bytes), HEX_SALT);
});

test("a short hex salt is a typo, not a hint", () => {
  const short = parseSalt(HEX_SALT.slice(0, 62), "hex");
  assert.equal(short.ok, false);
  if (short.ok) return;
  assert.match(short.message, /exactly 32 bytes/);
  assert.match(short.message, /got 62/);

  const nonHex = parseSalt("zz1122", "hex");
  assert.equal(nonHex.ok, false);
  if (nonHex.ok) return;
  assert.match(nonHex.message, /0-9 and a-f/);
  assert.equal(parseSalt("   ", "hex").ok, false, "blank is not a short salt");
});

test("a text salt is padded on the right, and the padding is reported", () => {
  const parsed = parseSalt("agent-guard", "utf8");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.bytes.length, SALT_BYTES);
  assert.equal(parsed.paddedBytes, SALT_BYTES - "agent-guard".length);
  assert.deepEqual([...parsed.bytes].slice(0, 11), [...new TextEncoder().encode("agent-guard")]);
  assert.deepEqual([...parsed.bytes].slice(11), new Array(SALT_BYTES - 11).fill(0));
});

test("text length is measured in bytes, not characters", () => {
  // "★" is three bytes in UTF-8, so a 12-character name can already be too long.
  const tooLong = parseSalt("★".repeat(11), "utf8");
  assert.equal(tooLong.ok, false);
  if (tooLong.ok) return;
  assert.match(tooLong.message, /33 bytes; the maximum is 32/);

  const exact = parseSalt("a".repeat(32), "utf8");
  assert.equal(exact.ok, true);
  if (!exact.ok) return;
  assert.equal(exact.paddedBytes, 0);
});

test("a parsed salt formats back to the same hex", () => {
  const parsed = parseSalt(HEX_SALT.toUpperCase(), "hex");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(formatSalt(parsed.bytes), HEX_SALT, "display is always lowercase");
  assert.equal(formatSalt(new Uint8Array([0, 1, 255])), "0001ff");
});

test("address derivation matches the Soroban contract-id specification", async () => {
  const salt = parseSalt(HEX_SALT, "hex");
  assert.equal(salt.ok, true);
  if (!salt.ok) return;

  const expected = contractIdPerSpec(DEPLOYER, salt.bytes, NETWORK.passphrase);
  const preview = await predictSaltAddress({ deployerPublicKey: DEPLOYER, salt: salt.bytes });
  assert.equal(preview.ok, true, preview.ok ? "" : preview.message);
  if (!preview.ok) return;
  assert.equal(preview.address, expected);

  // The same value the deploy flow compares against after signing.
  assert.equal(
    await predictContractId({ deployerPublicKey: DEPLOYER, salt: salt.bytes }),
    expected,
  );
});

test("a different salt or network moves the predicted address", async () => {
  const saltA = randomSalt(constantFiller(1));
  const saltB = randomSalt(constantFiller(2));
  const addressA = await predictContractId({ deployerPublicKey: DEPLOYER, salt: saltA });
  const addressB = await predictContractId({ deployerPublicKey: DEPLOYER, salt: saltB });
  assert.notEqual(addressA, addressB);

  const otherNet = contractIdPerSpec(DEPLOYER, saltA, "Test SDF Future Network ; October 2022");
  assert.notEqual(otherNet, addressA, "the passphrase is inside the preimage");
  assert.equal(isContractAddress(otherNet), true);
});

// ── Issue #364: the prediction is bound to deployer, salt and network ───────

function predictionInputs(overrides: Partial<DeployPredictionInputs> = {}): DeployPredictionInputs {
  return {
    deployerPublicKey: DEPLOYER,
    saltHex: HEX_SALT,
    networkName: NETWORK.name,
    networkPassphrase: NETWORK.passphrase,
    ...overrides,
  };
}

test("the same deployer, salt and network are one prediction; changing either input is detected", async () => {
  const base = predictionInputs();
  assert.equal(deployPredictionKey(base), deployPredictionKey({ ...base }));
  assert.deepEqual(deployPredictionChanges(base, { ...base }), []);

  assert.deepEqual(deployPredictionChanges(base, predictionInputs({ saltHex: "11".repeat(32) })), [
    "salt",
  ]);
  assert.deepEqual(
    deployPredictionChanges(base, predictionInputs({ deployerPublicKey: OTHER_DEPLOYER })),
    ["deployer"],
  );
  assert.deepEqual(deployPredictionChanges(base, predictionInputs({ networkName: "futurenet" })), [
    "network",
  ]);
  assert.deepEqual(
    deployPredictionChanges(base, predictionInputs({ networkPassphrase: "another passphrase" })),
    ["network"],
  );

  // Different deployers with the same salt are different addresses; the key
  // change above is not cosmetic.
  const salt = parseSalt(HEX_SALT, "hex");
  assert.equal(salt.ok, true);
  if (!salt.ok) return;
  const addressA = await predictContractId({ deployerPublicKey: DEPLOYER, salt: salt.bytes });
  const addressB = await predictContractId({
    deployerPublicKey: OTHER_DEPLOYER,
    salt: salt.bytes,
  });
  assert.notEqual(addressA, addressB);
});

test("invalid prediction inputs are named before an address is shown", () => {
  assert.match(
    deployPredictionProblem(predictionInputs({ deployerPublicKey: "not-a-key" })) ?? "",
    /deployer is not a valid Stellar account address/,
  );
  assert.match(
    deployPredictionProblem(predictionInputs({ saltHex: "abcd" })) ?? "",
    /exactly 32 bytes/,
  );
  assert.match(
    deployPredictionProblem(predictionInputs({ networkName: "" })) ?? "",
    /network name and passphrase/,
  );
  assert.equal(deployPredictionProblem(predictionInputs()), null);
});

test("the explanation states the derivation and refuses to claim uniqueness", () => {
  const text = describeDeployPrediction(predictionInputs());
  assert.match(text, /sha256\(network id \+ deployer/);
  assert.match(text, /same deployer, salt and network always produce the same address/);
  assert.match(text, /prediction, not a reservation/);
  assert.match(text, /does not claim the address is unique or unused/);
});

test("a derivation failure is shown, not thrown at the operator", async () => {
  const preview = await predictSaltAddress({
    deployerPublicKey: "not-a-key",
    salt: new Uint8Array(SALT_BYTES),
    predict: async () => {
      throw new Error("no longer can be decoded because it has invalid length");
    },
  });
  assert.equal(preview.ok, false);
  if (preview.ok) return;
  assert.match(preview.message, /invalid length/);
});

test("a reusable predictor pins the deployer and varies only the salt", async () => {
  const seen: Array<{ salt: string; deployer: string; passphrase: string | undefined }> = [];
  const predictor = createSaltAddressPredictor({
    deployerPublicKey: DEPLOYER,
    passphrase: "some network",
    predict: async (params) => {
      seen.push({
        salt: hexPair(params.salt),
        deployer: params.deployerPublicKey,
        passphrase: params.passphrase,
      });
      return `C${params.salt[0]}`;
    },
  });
  assert.equal(await predictor(new Uint8Array([7])), "C7");
  assert.equal(await predictor(new Uint8Array([8])), "C8");
  assert.deepEqual(seen, [
    { salt: "07", deployer: DEPLOYER, passphrase: "some network" },
    { salt: "08", deployer: DEPLOYER, passphrase: "some network" },
  ]);
});

test("an unreachable vanity pattern is refused before any attempt is spent", () => {
  assert.equal(validateVanityPattern("CAB", "prefix"), null);
  assert.equal(validateVanityPattern("cab77", "suffix"), null, "case is cosmetic");
  assert.match(validateVanityPattern("  ", "prefix") ?? "", /Enter the text/);
  assert.match(validateVanityPattern("A".repeat(13), "prefix") ?? "", /out of reach/);
  assert.match(
    validateVanityPattern("A".repeat(13), "prefix") ?? "",
    /each character is 1 chance in 32/,
  );
  // Strkey base32 is A-Z plus 2-7: the digits 0, 1, 8 and 9 do not exist in it.
  assert.match(validateVanityPattern("AB08", "prefix") ?? "", /base32/);
  assert.match(validateVanityPattern("A B", "suffix") ?? "", /base32/);
});

test("a vanity search returns the salt whose address really matches", async () => {
  const addresses = ["CX0", "CY0", "CAB77"];
  const progress: VanityProgress[] = [];
  const outcome = await searchVanitySalt({
    pattern: "CAB77",
    position: "prefix",
    fill: cyclingFiller([0x11, 0x22, 0x33]),
    saltAddress: async () => makeAddress(addresses.shift() ?? "CZZZZ"),
    onProgress: (entry) => progress.push(entry),
    maxAttempts: 10,
  });
  assert.equal(outcome.status, "found");
  if (outcome.status !== "found") return;
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.address, makeAddress("CAB77"));
  assert.equal(
    hexPair(outcome.salt),
    "33".repeat(SALT_BYTES),
    "the salt reported is the one that produced the address",
  );
  assert.deepEqual(
    progress.map((entry) => entry.attempts),
    [3],
  );
});

test("a suffix pattern is matched at the end of the address", async () => {
  const queue = ["999", "B77"];
  const outcome = await searchVanitySalt({
    pattern: "B77",
    position: "suffix",
    fill: constantFiller(0x44),
    saltAddress: async () => makeAddress("C222") + (queue.shift() ?? "000"),
    maxAttempts: 5,
  });
  assert.equal(outcome.status, "found");
  if (outcome.status !== "found") return;
  assert.ok(outcome.address.endsWith("B77"));
  assert.equal(outcome.attempts, 2);
});

test("stopping a search stops it, and the attempt count is honest", async () => {
  const signal = { aborted: true };
  const stopped = await searchVanitySalt({
    pattern: "CAB",
    position: "prefix",
    fill: constantFiller(0x01),
    saltAddress: async () => "CNOPE",
    signal,
  });
  assert.deepEqual(stopped, { status: "stopped", attempts: 0, reason: "aborted" });

  const exhausted = await searchVanitySalt({
    pattern: "CAB",
    position: "prefix",
    fill: constantFiller(0x01),
    saltAddress: async () => "CNOPE",
    maxAttempts: 7,
  });
  assert.deepEqual(exhausted, { status: "stopped", attempts: 7, reason: "exhausted" });
});

test("the closest candidate is the best partial match, not the largest string", async () => {
  // "ZZZ.." beats "CQA.." lexically while matching none of the pattern, so a
  // naive comparison would advertise a hopeless address as almost there.
  const queue = ["CQA11", "CXB22", "ZZZ33"];
  const progress: VanityProgress[] = [];
  const outcome = await searchVanitySalt({
    pattern: "CQR",
    position: "prefix",
    fill: constantFiller(0x05),
    saltAddress: async () => makeAddress(queue.shift() ?? "CAA44"),
    onProgress: (entry) => progress.push(entry),
    maxAttempts: 64,
  });
  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.reason, "exhausted");
  assert.equal(progress.length, 1, "progress is reported once per 64 attempts");
  assert.equal(progress[0]?.attempts, 64);
  assert.ok(
    progress[0]?.closest.startsWith("CQA"),
    `expected the 2-character match, got ${progress[0]?.closest}`,
  );
});

test("an invalid pattern never calls the predictor", async () => {
  let calls = 0;
  const outcome = await searchVanitySalt({
    pattern: "AB08",
    position: "prefix",
    saltAddress: async () => {
      calls += 1;
      return "CXXXX";
    },
  });
  assert.equal(outcome.status, "invalid");
  assert.equal(calls, 0);
});

test("the odds are stated in the same base32 the addresses use", () => {
  assert.equal(expectedAttemptsFor(1), 32);
  assert.equal(expectedAttemptsFor(2), 1024);
  assert.equal(formatExpectedAttempts(1), "about 32 tries");
  assert.equal(formatExpectedAttempts(2), "about 1k tries");
  assert.equal(formatExpectedAttempts(5), "about 34M tries");
});

test("a salt reused from an earlier deploy is caught before signing", async () => {
  const guard = PHASE1_ARTIFACT.guard;
  const deployed = await contractAlreadyDeployed(
    { getContractInstance: async () => ({ id: guard }) },
    guard,
  );
  assert.equal(deployed.exists, true);
  assert.match(deployed.detail ?? "", /already lives at this address/);

  const free = await contractAlreadyDeployed(
    {
      getContractInstance: async () => {
        throw new Error("not found");
      },
    },
    guard,
  );
  assert.deepEqual(free, { exists: false, detail: null });
});

test("an address that has not been derived yet is not a collision", async () => {
  let called = false;
  const result = await contractAlreadyDeployed(
    {
      getContractInstance: async () => {
        called = true;
        return {};
      },
    },
    "CAB77",
  );
  assert.equal(result.exists, false);
  assert.equal(called, false, "a placeholder is not worth an RPC call");
  assert.match(result.detail ?? "", /is not a contract address yet/);
});

test("contract addresses are told apart from account addresses", () => {
  assert.equal(isContractAddress(PHASE1_ARTIFACT.guard), true);
  assert.equal(isContractAddress(` ${PHASE1_ARTIFACT.token} `), true);
  assert.equal(isContractAddress(DEPLOYER), false);
  assert.equal(
    isContractAddress("CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU8"),
    false,
  );
});

/** A 56-character strkey-shaped string with the given head. */
function makeAddress(head: string): string {
  return (head + "2".repeat(56)).slice(0, 56);
}

/** Writes a different constant byte per candidate so salts are distinguishable. */
function cyclingFiller(seeds: number[]): RandomFiller {
  let index = 0;
  return (target) => {
    const byte = seeds[index % seeds.length] ?? 0;
    index += 1;
    return target.fill(byte);
  };
}
