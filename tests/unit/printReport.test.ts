import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  compileDeploymentReceipt,
  compilePrintReport,
  deploymentReceiptFilename,
  formatDeploymentReceipt,
  DEPLOYMENT_RECEIPT_DISCLAIMER,
  DEPLOYMENT_RECEIPT_SCHEMA_VERSION,
  type DeploymentReceiptInput,
} from "../../lib/guard/printReport.ts";
import type { InvokeResult } from "../../lib/guard/submit.ts";
import type { WasmIdentity } from "../../lib/guard/chain.ts";

test("compilePrintReport extracts correct fields from snapshot", () => {
  const mockSnapshot = {
    guard: "CABC123...",
    fetchedAt: "2026-09-25",
    status: {
      ok: true,
      value: {
        heartbeat_expired: false,
        admin_frozen: false,
        has_policy: true,
        last_heartbeat: 0n,
      },
    },
    policy: {
      ok: true,
      value: {
        per_tx_cap: 100n,
        window_cap: 1000n,
        window_secs: 60n,
        assets: ["A1"],
        recipients: ["R1"],
        protocols: [],
        paused: false,
        active_from: 0n,
        active_until: 0n,
        allow_any_recipient: false,
      },
    },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: "hash123", fetchedSha256: "hash123", bytes: 1000 },
    },
  } as any;

  const report = compilePrintReport(mockSnapshot, "Testnet", "GADMIN...", {
    networkPassphrase: "Test SDF Network ; September 2015",
    capturedAt: "2026-09-25T12:00:00.000Z",
  });

  assert.equal(report.contractId, "CABC123...");
  assert.equal(report.bytecodeHash, "hash123");
  assert.equal(report.adminKey, "GADMIN...");
  assert.equal(report.network, "Testnet");
  assert.equal(report.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(report.capturedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(report.dmsStatus, "OK");
  assert.equal(report.allowlists.state, "read");
  assert.equal(report.allowlists.assets?.[0], "A1");
  assert.deepEqual(
    report.reads.map((read) => [read.key, read.state, read.readAt]),
    [
      ["status", "read", "2026-09-25"],
      ["policy", "read", "2026-09-25"],
      ["window", "empty", "2026-09-25"],
      ["identity", "read", "2026-09-25"],
    ],
  );
});

/** A snapshot whose four sections can each succeed or fail independently. */
function reportSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    guard: "CABC123...",
    fetchedAt: "2026-10-21T10:00:00.000Z",
    status: {
      ok: true,
      value: {
        heartbeat_expired: false,
        admin_frozen: false,
        has_policy: true,
        last_heartbeat: 0n,
        now: 1n,
      },
      readAt: "2026-10-21T10:00:01.000Z",
    },
    policy: {
      ok: true,
      value: {
        per_tx_cap: 100n,
        window_cap: 1000n,
        window_secs: 60n,
        assets: ["A1"],
        recipients: ["R1"],
        protocols: [],
        paused: false,
        active_from: 0n,
        active_until: 0n,
        allow_any_recipient: false,
        dms_grace_secs: 0n,
      },
      readAt: "2026-10-21T10:00:02.000Z",
    },
    window: { ok: true, value: { total: 0n, entries: [] }, readAt: "2026-10-21T10:00:03.000Z" },
    identity: {
      ok: true,
      value: { reportedWasmHash: "hash123", fetchedSha256: "hash123", bytes: 1000 },
      readAt: "2026-10-21T10:00:04.000Z",
    },
    ...overrides,
  } as any;
}

test("a complete report carries network, guard, capture time and per-section read times", () => {
  const report = compilePrintReport(reportSnapshot(), "testnet", "GADMIN...", {
    networkPassphrase: "Test SDF Network ; September 2015",
    capturedAt: "2026-10-21T10:05:00.000Z",
  });

  assert.equal(report.contractId, "CABC123...");
  assert.equal(report.network, "testnet");
  assert.equal(report.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(report.capturedAt, "2026-10-21T10:05:00.000Z");
  assert.deepEqual(
    report.reads.map((read) => [read.key, read.state, read.readAt]),
    [
      ["status", "read", "2026-10-21T10:00:01.000Z"],
      ["policy", "read", "2026-10-21T10:00:02.000Z"],
      ["window", "read", "2026-10-21T10:00:03.000Z"],
      ["identity", "read", "2026-10-21T10:00:04.000Z"],
    ],
  );
  assert.ok(report.reads.every((read) => read.detail === null));
  assert.deepEqual(report.allowlists.assets, ["A1"]);
  assert.deepEqual(report.allowlists.recipients, ["R1"]);
});

test("a failed policy read is printed as unavailable, not as an empty policy", () => {
  const report = compilePrintReport(
    reportSnapshot({
      policy: { ok: false, error: "RPC timed out while reading policy()" },
    }),
    "testnet",
    "GADMIN...",
    { capturedAt: "2026-10-21T10:05:00.000Z" },
  );

  assert.equal(report.policyRules, "Unavailable — the policy read failed");
  assert.equal(report.allowlists.state, "failed");
  assert.equal(report.allowlists.assets, null);
  assert.equal(report.allowlists.recipients, null);
  assert.equal(report.allowlists.protocols, null);
  assert.ok(
    !JSON.stringify(report).includes("No policy installed"),
    "a failed read must never be rendered as default-deny",
  );

  const policyRead = report.reads.find((read) => read.key === "policy");
  assert.equal(policyRead?.state, "failed");
  assert.equal(policyRead?.readAt, null);
  assert.match(policyRead?.detail ?? "", /RPC timed out/);
});

test("a failed status read is unavailable, never UNKNOWN-as-a-value or a default", () => {
  const report = compilePrintReport(
    reportSnapshot({ status: { ok: false, error: "status() simulation failed" } }),
    "testnet",
    "GADMIN...",
  );
  assert.equal(report.dmsStatus, "Unavailable — the status read failed");
  const status = report.reads.find((read) => read.key === "status");
  assert.equal(status?.state, "failed");
  assert.match(status?.detail ?? "", /simulation failed/);
});

test("a failed identity read prints unavailable rather than a dash", () => {
  const report = compilePrintReport(
    reportSnapshot({ identity: { ok: false, error: "ledger entry unavailable" } }),
    "testnet",
    "GADMIN...",
  );
  assert.match(report.bytecodeHash, /Unavailable/);
  assert.match(report.bytecodeHash, /identity read failed/);
  assert.equal(report.reads.find((read) => read.key === "identity")?.state, "failed");
});

test("a successful read with no policy is explicit default-deny, not a failure", () => {
  const report = compilePrintReport(
    reportSnapshot({
      policy: { ok: true, value: null, readAt: "2026-10-21T10:00:02.000Z" },
    }),
    "testnet",
    "GADMIN...",
  );
  assert.equal(report.policyRules, "No policy installed (default-deny)");
  assert.equal(report.allowlists.state, "read");
  assert.deepEqual(report.allowlists.assets, []);
  const policyRead = report.reads.find((read) => read.key === "policy");
  assert.equal(policyRead?.state, "empty");
  assert.equal(policyRead?.readAt, "2026-10-21T10:00:02.000Z");
  assert.match(policyRead?.detail ?? "", /read succeeded/i);
});

// ── Deployment verification receipt (#396, #397) ───────────────────────────

/** A syntactically valid contract address, for the prediction check. */
const PREDICTED = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const PINNED_HASH = "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63";
const PINNED_BYTES = 39673;
const CAPTURED_AT = "2026-10-20T10:11:12.000Z";

function submitted(hash: string, ledger: number | null): InvokeResult {
  return { kind: "submitted", hash, status: "SUCCESS", ledger, events: [] };
}

function matchingIdentity(overrides: Partial<WasmIdentity> = {}): WasmIdentity {
  return {
    reportedWasmHash: PINNED_HASH,
    fetchedSha256: PINNED_HASH,
    bytes: PINNED_BYTES,
    match: true,
    ...overrides,
  };
}

function baseInput(overrides: Partial<DeploymentReceiptInput> = {}): DeploymentReceiptInput {
  return {
    network: { name: "testnet", passphrase: "Test SDF Network ; September 2015" },
    predictedAddress: PREDICTED,
    deployedAddress: PREDICTED,
    pinned: { hash: PINNED_HASH, bytes: PINNED_BYTES },
    read: { ok: true, value: matchingIdentity() },
    steps: [
      { label: "upload_contract_wasm (39673 bytes)", result: submitted("aa11", 100) },
      {
        label: `create_custom_contract (wasm ${PINNED_HASH.slice(0, 12)}…) → ${PREDICTED}`,
        result: submitted("bb22", 101),
      },
    ],
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe("deployment verification receipt", () => {
  test("a successful deploy is verified only from the live read, and carries the inputs", () => {
    const receipt = compileDeploymentReceipt(baseInput());

    assert.equal(receipt.kind, "stellar-agent-guard.deployment-receipt");
    assert.equal(receipt.schemaVersion, DEPLOYMENT_RECEIPT_SCHEMA_VERSION);
    assert.equal(receipt.generator.provenance, "client-generated");
    assert.equal(receipt.disclaimer, DEPLOYMENT_RECEIPT_DISCLAIMER);
    assert.equal(receipt.capturedAt, CAPTURED_AT);
    assert.equal(receipt.network.name, "testnet");
    assert.equal(receipt.network.passphrase, "Test SDF Network ; September 2015");
    assert.equal(receipt.addresses.predicted, PREDICTED);
    assert.equal(receipt.addresses.deployed, PREDICTED);

    assert.equal(receipt.artifact.pinnedHash, PINNED_HASH);
    assert.equal(receipt.artifact.pinnedBytes, PINNED_BYTES);
    assert.equal(receipt.artifact.observedSha256, PINNED_HASH);
    assert.equal(receipt.artifact.observedBytes, PINNED_BYTES);
    assert.equal(receipt.artifact.reportedWasmHash, PINNED_HASH);

    assert.equal(receipt.verification.status, "verified");
    assert.equal(receipt.verification.verified, true);
    assert.deepEqual(
      receipt.verification.checks.map((entry) => entry.status),
      ["verified", "verified", "verified", "verified", "verified", "verified"],
    );

    // Every transaction reference is the deploy's own, in order.
    assert.deepEqual(
      receipt.transactions.map((entry) => [
        entry.operation.split(" ")[0],
        entry.hash,
        entry.ledger,
      ]),
      [
        ["upload_contract_wasm", "aa11", 100],
        ["create_custom_contract", "bb22", 101],
      ],
    );
  });

  test("a read that returns the wrong bytecode is a failure, never a success claim", () => {
    const receipt = compileDeploymentReceipt(
      baseInput({
        read: {
          ok: true,
          value: matchingIdentity({
            fetchedSha256: "deadbeef",
            bytes: 12,
            reportedWasmHash: "deadbeef",
            match: false,
          }),
        },
      }),
    );

    assert.equal(receipt.verification.status, "failed");
    assert.equal(receipt.verification.verified, false);
    assert.match(receipt.verification.summary, /does not match the pinned artifact/);

    const byId = new Map(receipt.verification.checks.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("live-read")?.status, "verified");
    assert.equal(byId.get("artifact-hash")?.status, "failed");
    assert.equal(byId.get("artifact-length")?.status, "failed");
    assert.equal(byId.get("ledger-hash")?.status, "failed");
    assert.match(byId.get("artifact-hash")?.detail ?? "", /deadbeef/);
  });

  test("a failed post-deploy read is recorded explicitly and marks the receipt unavailable", () => {
    const receipt = compileDeploymentReceipt(
      baseInput({ read: { ok: false, error: "RPC timed out" } }),
    );

    assert.equal(receipt.verification.status, "unavailable");
    assert.equal(receipt.verification.verified, false);
    assert.equal(receipt.artifact.observedSha256, null);
    assert.equal(receipt.artifact.observedBytes, null);
    assert.equal(receipt.artifact.reportedWasmHash, null);

    const byId = new Map(receipt.verification.checks.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("live-read")?.status, "failed");
    assert.match(byId.get("live-read")?.detail ?? "", /RPC timed out/);
    assert.equal(byId.get("artifact-hash")?.status, "unavailable");
    assert.equal(byId.get("artifact-length")?.status, "unavailable");
    assert.equal(byId.get("ledger-hash")?.status, "unavailable");
  });

  test("an instance that reports no ledger hash does not manufacture one", () => {
    const receipt = compileDeploymentReceipt(
      baseInput({ read: { ok: true, value: matchingIdentity({ reportedWasmHash: null }) } }),
    );

    const ledgerHash = receipt.verification.checks.find((entry) => entry.id === "ledger-hash");
    assert.equal(ledgerHash?.status, "unavailable");
    assert.equal(receipt.artifact.reportedWasmHash, null);
    // Hash and length still matched the pin, so the read remains the evidence.
    assert.equal(receipt.verification.status, "verified");
  });

  test("a refused create never reads as verified, even though an address was predicted", () => {
    const receipt = compileDeploymentReceipt(
      baseInput({
        read: null,
        deployedAddress: null,
        steps: [
          {
            label: `create_custom_contract (wasm ${PINNED_HASH.slice(0, 12)}…) → ${PREDICTED}`,
            result: {
              kind: "refused",
              stage: "enforcement",
              detail: "host error: auth invalid",
              diagnosticEvents: [],
            },
          },
        ],
      }),
    );

    assert.equal(receipt.verification.status, "failed");
    assert.equal(receipt.verification.verified, false);
    assert.equal(receipt.transactions.length, 1);
    assert.equal(receipt.transactions[0]?.outcome, "refused");
    assert.equal(receipt.transactions[0]?.hash, null);
    assert.match(receipt.transactions[0]?.detail ?? "", /enforcement/);

    const byId = new Map(receipt.verification.checks.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("contract-created")?.status, "failed");
    assert.equal(byId.get("live-read")?.status, "unavailable");
    assert.equal(byId.get("artifact-hash")?.status, "unavailable");
  });

  test("a deploy that stops before the read is unavailable, not verified", () => {
    const receipt = compileDeploymentReceipt(
      baseInput({
        read: null,
        steps: [{ label: "upload_contract_wasm (39673 bytes)", result: submitted("aa11", 100) }],
      }),
    );

    assert.equal(receipt.verification.status, "unavailable");
    assert.equal(receipt.verification.verified, false);
    assert.match(receipt.verification.summary, /no verification is claimed/);
  });

  test("redacts secret-like sentinels and never serialises signed XDR", () => {
    const SECRET_SEED = "SDBQH7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ";
    const SIGNED_XDR = "AAAAAgAAAABzaWduZWQtZW52ZWxvcGUtc2VudGluZWw=";
    const SESSION_TOKEN = "freighter-session-token-sentinel";

    const input = {
      ...baseInput({
        steps: [
          { label: "upload_contract_wasm (39673 bytes)", result: submitted("aa11", 100) },
          {
            label: `create_custom_contract (wasm ${PINNED_HASH.slice(0, 12)}…) → ${PREDICTED}`,
            result: {
              kind: "exported",
              xdr: SIGNED_XDR,
              detail: "unsigned envelope exported for an external signer",
            },
          },
        ],
      }),
      // The receipt type has no field for any of these. They are attached here
      // the way a careless caller might attach their whole session, to prove the
      // compiler's whitelist is not bypassed by a spread.
      secretKey: SECRET_SEED,
      signedXdr: SIGNED_XDR,
      wallet: { provider: "freighter", address: PREDICTED, sessionToken: SESSION_TOKEN },
    } as unknown as DeploymentReceiptInput;

    const receipt = compileDeploymentReceipt(input);
    const serialised = formatDeploymentReceipt(receipt);

    assert.ok(!serialised.includes(SECRET_SEED), "a secret seed must never be serialised");
    assert.ok(
      !serialised.includes(SIGNED_XDR),
      "signed or unsigned envelope XDR must not be included",
    );
    assert.ok(!serialised.includes(SESSION_TOKEN), "wallet session details must not be included");
    assert.ok(
      !serialised.toLowerCase().includes("freighter"),
      "the wallet provider is not part of the record",
    );
    assert.ok(!("secretKey" in receipt));
    assert.ok(!("signedXdr" in receipt));
    assert.ok(!("wallet" in receipt));

    // The exported step is kept as an explicit "nothing was broadcast" fact.
    const exported = receipt.transactions.at(-1);
    assert.equal(exported?.outcome, "exported");
    assert.equal(exported?.hash, null);
    assert.match(exported?.detail ?? "", /exported/);
  });

  test("redacts secrets and credentials from error diagnostics and failure details", () => {
    const SECRET_KEY = "SCRUPLHP7D3DLRMTWVZUIVPHFQGSX45IXGG62LDNY2RJ4M24D4CRBYDV";
    const API_URL = "https://soroban-rpc.testnet.stellar.org?apiKey=supersecretkey123";

    const input = baseInput({
      steps: [
        {
          label: "create_custom_contract",
          result: {
            kind: "failed",
            hash: "abcd",
            detail: `Failed connecting to ${API_URL} using key ${SECRET_KEY}`,
            diagnosticEvents: [],
          },
        },
      ],
      read: {
        ok: false,
        error: `Authentication failed at https://user:secretpass@stellar.org for ${SECRET_KEY}`,
      },
    });

    const receipt = compileDeploymentReceipt(input);
    const serialised = formatDeploymentReceipt(receipt);

    assert.ok(!serialised.includes(SECRET_KEY), "secret key must not appear in receipt");
    assert.ok(
      !serialised.includes("supersecretkey123"),
      "api key query must not appear in receipt",
    );
    assert.ok(!serialised.includes("secretpass"), "url password must not appear in receipt");
    assert.ok(serialised.includes("[REDACTED]"), "redacted placeholders must be present");
  });

  test("the serialised document is stable, labelled and parseable", () => {
    const receipt = compileDeploymentReceipt(baseInput());
    const serialised = formatDeploymentReceipt(receipt);

    assert.ok(serialised.endsWith("\n"));
    const parsed = JSON.parse(serialised) as Record<string, unknown>;
    assert.equal(parsed.kind, "stellar-agent-guard.deployment-receipt");
    assert.equal(parsed.schemaVersion, DEPLOYMENT_RECEIPT_SCHEMA_VERSION);
    assert.deepEqual(parsed.generator, {
      name: "stellar-agent-guard-dashboard",
      provenance: "client-generated",
    });
    assert.match(String(parsed.disclaimer), /not a signed credential/);
    assert.match(String(parsed.disclaimer), /client-generated/i);
  });

  test("the filename identifies the network, address and capture day", () => {
    const receipt = compileDeploymentReceipt(baseInput());
    assert.equal(
      deploymentReceiptFilename(receipt),
      `deployment-receipt-testnet-${PREDICTED.slice(0, 12)}-2026-10-20.json`,
    );

    const unreached = compileDeploymentReceipt(baseInput({ read: null, deployedAddress: null }));
    assert.match(
      deploymentReceiptFilename(unreached),
      /deployment-receipt-testnet-CAYJZT4XH5SW-2026-10-20\.json/,
    );
  });
});
