import assert from "node:assert/strict";
import { test } from "node:test";
import { Horizon } from "@stellar/stellar-sdk";
import {
  THRESHOLD_LABELS,
  approvalPercent,
  approvalSummary,
  evaluateApprovalState,
  pendingSigners,
  remainingWeightSummary,
  signerRuleChanges,
  type MultisigSigner,
  type MultisigThresholds,
} from "../../lib/guard/multisig.ts";
import {
  defaultSignerLabel,
  matchEnvelopeSignatures,
  readEnvelopeSignatures,
  signerHint,
  signerKind,
  unmatchedSignatures,
} from "../../lib/guard/multisigRead.ts";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const ADMIN_1 = "GC7CKKC2QRWJ3DPVNJKGJSDIQLT2WCY5V2G2SWJADAVDWDKYZB4BQKQV";
const ADMIN_2 = "GAXGJECHBVKN2SXTBWKTWAK5DABQ7AX7VACXZYPV5XJDNG5XLLH5JHOG";
const ADMIN_3 = "GDJ6UXKHZ2KRXPLLTSDA3AUWZJSHVRLW4XTWCH7KGD5DJHQNSDSVDOIT";
const VALID_ADMIN_1 = Keypair.random().publicKey();
const VALID_ADMIN_2 = Keypair.random().publicKey();
const THRESHOLDS: MultisigThresholds = { low_threshold: 0, med_threshold: 20, high_threshold: 30 };

function signers(): MultisigSigner[] {
  return [
    { key: ADMIN_1, weight: 10, label: "Admin 1" },
    { key: ADMIN_2, weight: 10, label: "Admin 2" },
    { key: ADMIN_3, weight: 10, label: "Admin 3" },
  ];
}

test("evaluating a partially signed envelope reports collected vs required weight", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(state.collectedWeight, 10);
  assert.equal(state.requiredWeight, 20);
  assert.equal(state.ready, false);
  assert.deepEqual(
    state.signers.map((signer) => `${signer.label} ${signer.status}`),
    ["Admin 1 signed", "Admin 2 pending", "Admin 3 pending"],
  );
});

test("an envelope meeting the threshold is ready to submit", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_2 }],
  });
  assert.equal(state.collectedWeight, 20);
  assert.equal(state.ready, true);
});

test("signatures from keys that are no longer account signers contribute nothing", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [
      { signer: ADMIN_1 },
      { signer: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ" },
    ],
  });
  assert.equal(state.collectedWeight, 10);
  assert.equal(state.ready, false);
});

test("a zero-weight (disabled) signer cannot move the state towards ready", () => {
  const disabledKey = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const account = [...signers(), { key: disabledKey, weight: 0, label: "Disabled" }];
  const state = evaluateApprovalState({
    signers: account,
    thresholds: THRESHOLDS,
    signatures: [{ signer: disabledKey }],
  });
  assert.equal(state.collectedWeight, 0);
  assert.equal(state.ready, false);
  // A disabled signer that "signed" is still shown, with no weight contributed.
  const disabled = state.signers.find((signer) => signer.label === "Disabled");
  assert.equal(disabled?.weight, 0);
  assert.equal(disabled?.status, "signed");
});

test("the med threshold governs by default, and low/high can be selected", () => {
  const base = { signers: signers(), signatures: [{ signer: ADMIN_1 }] };
  assert.equal(evaluateApprovalState({ ...base, thresholds: THRESHOLDS }).requiredWeight, 20);
  assert.equal(
    evaluateApprovalState({ ...base, thresholds: THRESHOLDS, thresholdLevel: "low" })
      .requiredWeight,
    0,
  );
  assert.equal(
    evaluateApprovalState({ ...base, thresholds: THRESHOLDS, thresholdLevel: "high" })
      .requiredWeight,
    30,
  );
});

test("a zero threshold makes any envelope ready — the account authorizes on source alone", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    signatures: [],
  });
  assert.equal(state.requiredWeight, 0);
  assert.equal(state.ready, true);
});

test("pendingSigners names the smallest set of co-signers that reaches the threshold", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [],
  });
  assert.deepEqual(pendingSigners(state), [ADMIN_1, ADMIN_2]);

  const oneShort = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_2 }],
  });
  assert.deepEqual(pendingSigners(oneShort), [ADMIN_1]);

  const ready = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_3 }],
  });
  assert.deepEqual(pendingSigners(ready), []);
});

test("the summary line renders collected, required and per-signer status", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(
    approvalSummary(state),
    "Collected weight 10 of 20 required (Admin 1 [Signed], Admin 2 [Pending], Admin 3 [Pending])",
  );
});

test("progress percentage caps at 100 and reads 100 for a zero threshold", () => {
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: THRESHOLDS,
        signatures: [{ signer: ADMIN_1 }],
      }),
    ),
    50,
  );
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: THRESHOLDS,
        signatures: signers().map((signer) => ({ signer: signer.key })),
      }),
    ),
    100,
  );
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        signatures: [],
      }),
    ),
    100,
  );
});

test("envelope signatures are read from the XDR and matched to signers by hint", () => {
  const keypair = Keypair.random();
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: keypair.publicKey() }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);

  const decoded = readEnvelopeSignatures(tx.toXDR(), Networks.TESTNET);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.length, 1);

  // The envelope carries only a hint; the account signer's own hint matches it.
  const envelopeSigner = decoded.value[0]!.signer;
  assert.match(envelopeSigner, /^hint:[0-9a-f]{8}$/);
  assert.equal(`hint:${signerHint(keypair.publicKey())}`, envelopeSigner);
  assert.deepEqual(
    unmatchedSignatures(decoded.value, [{ key: keypair.publicKey(), weight: 1, label: "A" }]),
    [],
  );

  // Matching turns the hint back into the account identity; no ambiguity here.
  const matched = matchEnvelopeSignatures(decoded.value, [
    { key: keypair.publicKey(), weight: 1, label: "A" },
  ]);
  assert.deepEqual(matched.signatures, [{ signer: keypair.publicKey() }]);
  assert.deepEqual(matched.ambiguousHints, []);
});

test("a malformed envelope is an error, not a silent empty signature list", () => {
  const decoded = readEnvelopeSignatures("not-an-envelope");
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.match(decoded.error, /./);
});

test("signerHint rejects non-Ed25519 keys instead of throwing", () => {
  assert.equal(signerHint("CATL3S2VZ3LHDSWQKCTOSJORT5HLIhiTLRIQOXKZFEA34DLYJHY777"), null);
  assert.equal(signerHint(""), null);
});

test("default signer labels are stable and one-based", () => {
  assert.equal(defaultSignerLabel(0), "Signer 1");
  assert.equal(defaultSignerLabel(9), "Signer 10");
});

test("readAccountSigners maps Horizon's record into tracker inputs and reports failures", async () => {
  const record = {
    signers: [
      { key: VALID_ADMIN_1, weight: 10, type: "ed25519_public_key" },
      { key: VALID_ADMIN_2, weight: 10, type: "ed25519_public_key" },
      {
        key: "TBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F",
        weight: 5,
        type: "sha256_hash",
      },
    ],
    thresholds: THRESHOLDS,
  };
  const fakeServer = {
    accounts: () => ({
      accountId: () => ({
        call: async () => record,
      }),
    }),
  } as unknown as Horizon.Server;

  const ok = await readAccountSignersForTest(fakeServer, ADMIN_1);
  assert.ok(ok.ok);
  assert.equal(ok.value.signers.length, 3);
  assert.equal(ok.value.signers[0]?.label, "Signer 1");
  assert.equal(ok.value.signers[0]?.kind, "ed25519");
  assert.equal(ok.value.signers[2]?.kind, "hash");
  assert.equal(ok.value.thresholds?.med_threshold, 20);
  assert.ok(Number.isFinite(Date.parse(ok.value.observedAt)));
  assert.deepEqual(ok.value.incompleteReasons, []);

  const failing = {
    accounts: () => ({
      accountId: () => ({
        call: async () => {
          throw new Error("404 not found");
        },
      }),
    }),
  } as unknown as Horizon.Server;
  const failed = await readAccountSignersForTest(failing, ADMIN_1);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /404/);
});

test("a partial Horizon record is distinct from a complete signer read", async () => {
  const partialServer = {
    accounts: () => ({
      accountId: () => ({
        call: async () => ({
          signers: [
            { key: VALID_ADMIN_1, weight: 10, type: "ed25519_public_key" },
            { key: VALID_ADMIN_2, type: "ed25519_public_key" },
          ],
          thresholds: { low_threshold: 0, med_threshold: 20 },
        }),
      }),
    }),
  } as unknown as Horizon.Server;
  const result = await readAccountSignersForTest(partialServer, ADMIN_1);
  assert.ok(result.ok);
  assert.equal(result.value.signers.length, 1);
  assert.equal(result.value.thresholds, null);
  assert.match(result.value.incompleteReasons.join(" "), /incomplete signer data/);
  assert.match(result.value.incompleteReasons.join(" "), /all valid account thresholds/);
});

test("invalid thresholds or duplicate signer records stay incomplete", () => {
  const invalidThresholds = evaluateApprovalState({
    signers: signers(),
    thresholds: { low_threshold: 0, med_threshold: 300, high_threshold: 30 },
    signatures: signers().map((signer) => ({ signer: signer.key })),
  });
  assert.equal(invalidThresholds.evaluationStatus, "incomplete");
  assert.equal(invalidThresholds.ready, false);
  assert.equal(invalidThresholds.requiredWeight, null);

  const duplicateSigner = signers()[0]!;
  const duplicateRecords = evaluateApprovalState({
    signers: [duplicateSigner, { ...duplicateSigner, weight: 20 }],
    thresholds: THRESHOLDS,
    signatures: [{ signer: duplicateSigner.key }],
  });
  assert.equal(duplicateRecords.evaluationStatus, "incomplete");
  assert.equal(duplicateRecords.ready, false);
  assert.match(duplicateRecords.evaluationReasons.join(" "), /duplicate signer keys/);
});

test("remaining weight is calculated separately for every threshold", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(state.remainingWeight, 10, "the governing medium threshold is 10 short");
  assert.deepEqual(
    state.thresholds.map((threshold) => [
      threshold.level,
      threshold.requiredWeight,
      threshold.collectedWeight,
      threshold.remainingWeight,
      threshold.met,
    ]),
    [
      ["low", 0, 10, 0, true],
      ["med", 20, 10, 10, false],
      ["high", 30, 10, 20, false],
    ],
  );
});

test("threshold boundaries: exact weight is ready, one below is one short", () => {
  const exact = evaluateApprovalState({
    signers: signers(),
    thresholds: { low_threshold: 0, med_threshold: 10, high_threshold: 30 },
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(exact.ready, true);
  assert.equal(exact.remainingWeight, 0);
  assert.equal(exact.thresholds[1]?.met, true);

  const oneShort = evaluateApprovalState({
    signers: signers(),
    thresholds: { low_threshold: 0, med_threshold: 11, high_threshold: 30 },
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(oneShort.ready, false);
  assert.equal(oneShort.remainingWeight, 1);
  assert.equal(oneShort.thresholds[1]?.remainingWeight, 1);
  assert.equal(oneShort.thresholds[1]?.met, false);
});

test("a removed signer's signature cannot reduce the remaining weight", () => {
  const state = evaluateApprovalState({
    // ADMIN_1 is no longer in the account's signer set, but the envelope still
    // carries their signature.
    signers: signers().slice(1),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(state.collectedWeight, 0);
  assert.equal(state.remainingWeight, 20);
  assert.deepEqual(
    state.signers.map((signer) => signer.status),
    ["pending", "pending"],
  );
});

test("duplicate signatures are counted once and reported", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_1 }, { signer: ADMIN_2 }],
  });
  assert.equal(state.collectedWeight, 20, "a repeated signature adds no weight");
  assert.equal(state.ready, true);
  assert.equal(state.remainingWeight, 0);
  assert.deepEqual(state.duplicateSignatures, [ADMIN_1]);
});

test("unsupported signer data cannot produce a ready or met threshold", () => {
  const state = evaluateApprovalState({
    signers: [
      { key: ADMIN_1, weight: 10, label: "Admin 1", kind: "ed25519" },
      {
        key: "TBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F",
        weight: 30,
        label: "Hash signer",
        kind: "hash",
      },
    ],
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(state.evaluationStatus, "unsupported");
  assert.equal(state.ready, false);
  assert.equal(state.coverage, "unknown");
  assert.equal(state.remainingWeight, null, "a lower bound is not a definite shortfall");
  assert.equal(state.thresholds[1]?.remainingWeight, null);
  assert.equal(state.thresholds[0]?.remainingWeight, null);
  assert.equal(
    state.thresholds.some((threshold) => threshold.met),
    false,
  );
  assert.equal(state.unattributableSigners.length, 1);
  assert.equal(state.unattributableSigners[0]?.label, "Hash signer");
  assert.match(remainingWeightSummary(state), /Threshold status is unsupported/);

  // A lower bound above the threshold is still not a verdict when the account
  // includes signers whose contributions cannot be identified.
  const alreadyMet = evaluateApprovalState({
    signers: [
      { key: ADMIN_1, weight: 10, label: "Admin 1", kind: "ed25519" },
      {
        key: "TBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F",
        weight: 30,
        label: "Hash signer",
        kind: "hash",
      },
    ],
    thresholds: { low_threshold: 0, med_threshold: 10, high_threshold: 30 },
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(alreadyMet.evaluationStatus, "unsupported");
  assert.equal(alreadyMet.ready, false);
  assert.equal(alreadyMet.thresholds[1]?.met, false);
  assert.equal(alreadyMet.remainingWeight, null);
});

test("ambiguous signature matching is reported as unknown coverage", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
    signatureDataComplete: false,
  });
  assert.equal(state.evaluationStatus, "incomplete");
  assert.equal(state.ready, false);
  assert.equal(state.coverage, "unknown");
  assert.equal(state.remainingWeight, null);
  assert.match(remainingWeightSummary(state), /do not uniquely identify/);
});

test("refreshing account rules reports signer and threshold changes and recalculates readiness", () => {
  const previous = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_2 }],
  });
  assert.equal(previous.ready, true);

  const current = evaluateApprovalState({
    signers: [
      { key: ADMIN_2, weight: 5, label: "Signer 2" },
      { key: ADMIN_3, weight: 10, label: "Signer 3" },
    ],
    thresholds: { low_threshold: 0, med_threshold: 25, high_threshold: 30 },
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_2 }],
  });
  assert.equal(current.ready, false);
  assert.equal(current.collectedWeight, 5);
  assert.equal(current.requiredWeight, 25);

  const changes = signerRuleChanges(previous, current);
  assert.ok(changes.some((change) => change.includes("Admin 1") && change.includes("removed")));
  assert.ok(changes.some((change) => change.includes("weight changed from 10 to 5")));
  assert.ok(changes.some((change) => change.includes("Medium threshold changed from 20 to 25")));
});

test("the remaining-weight summary never renders an unknown value as zero", () => {
  const partial = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(THRESHOLD_LABELS.med, "Medium threshold");
  assert.equal(
    remainingWeightSummary(partial),
    "10 more signer weight is required at the medium threshold.",
  );
  assert.equal(
    remainingWeightSummary(
      evaluateApprovalState({
        signers: signers(),
        thresholds: THRESHOLDS,
        signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_2 }],
      }),
    ),
    "No further signer weight is required at the medium threshold.",
  );
});

test("Horizon signer types map onto tracker signer kinds", () => {
  assert.equal(signerKind(undefined), "ed25519");
  assert.equal(signerKind("ed25519_public_key"), "ed25519");
  assert.equal(signerKind("sha256_hash"), "hash");
  assert.equal(signerKind("preauth_tx"), "preauth");
  assert.equal(signerKind("ed25519_signed_payload"), "signed_payload");
  assert.equal(signerKind("something_new"), "unknown");
});

/** Indirection so the test imports the real function while keeping the fake server type honest. */
async function readAccountSignersForTest(
  server: Horizon.Server,
  accountId: string,
): Promise<
  | {
      ok: true;
      value: {
        signers: MultisigSigner[];
        thresholds: MultisigThresholds | null;
        observedAt: string;
        incompleteReasons: string[];
      };
    }
  | { ok: false; error: string }
> {
  const mod = await import("../../lib/guard/multisigRead.ts");
  return mod.readAccountSigners(server, accountId);
}
