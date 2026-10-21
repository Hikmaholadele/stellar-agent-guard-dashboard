/**
 * The E2E fixtures are contract tests in both directions.
 *
 * The network-mismatch suite (`tests/e2e/networkMismatch.spec.ts`) serves the
 * chain from `tests/e2e/rpcFixtures.ts`. If a fixture drifted from the response
 * shape Soroban RPC actually serves, the E2E scenario would fail somewhere far
 * from the cause. So the fixture answers are fed through the SDK's own parsers
 * inside a real `rpc.Server` here, with only the transport swapped for the
 * fixture router: if `handleRpcRequest` stops being a valid Soroban RPC, this
 * test fails in the ordinary unit suite instead of in a browser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rpc } from "@stellar/stellar-sdk";
import {
  handleRpcRequest,
  accountLedgerKey,
  contractCodeLedgerKey,
  contractInstanceLedgerKey,
  MOCK_LEDGER,
  WASM_BYTES,
  GUARD,
  OPERATOR_ADDRESS,
} from "../e2e/rpcFixtures.ts";
const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
import { readGuardSnapshot } from "../../lib/guard/guardOps.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

/**
 * A `rpc.Server` whose HTTP client is the fixture router.
 *
 * `httpClient` is readonly by design — the SDK expects it to be configured, not
 * swapped — so replacing it takes a deliberate cast. The payoff is that the
 * fixture answers travel through the SDK's own JSON-RPC request/response parsing
 * instead of a hand-written stand-in, which is the whole point of this test.
 */
function fixtureServer(): rpc.Server {
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const transport = {
    post: async (_url: string, body: unknown) => {
      const response = handleRpcRequest(body);
      return { data: JSON.parse(response.body) as unknown };
    },
  };
  (server as unknown as { httpClient: typeof transport }).httpClient = transport;
  return server;
}

describe("e2e rpc fixtures", () => {
  it("serve an account entry the SDK parses as the funded operator", async () => {
    const account = await fixtureServer().getAccount(OPERATOR_ADDRESS);
    assert.equal(account.accountId(), OPERATOR_ADDRESS);
    assert.equal(account.sequenceNumber(), "100");
  });

  it("serve instance + code entries that re-verify the pinned artifact", async () => {
    const server = fixtureServer();
    const identity = await server.getContractWasmByContractId(GUARD);
    assert.equal(identity.length, WASM_BYTES);
    const instance = (await server.getContractInstance(GUARD)) as unknown as {
      executable?: { wasmHash?: { value?: unknown } };
    };
    const reportedHash = bytesToHex(
      new Uint8Array(instance.executable?.wasmHash?.value as ArrayBufferLike),
    );
    assert.equal(reportedHash, PHASE1_ARTIFACT.wasmHash);
    // The committed wasm fixture must still be the pinned artifact, byte for
    // byte: the E2E identity panel is only honest if these bytes are real.
    const { sha256Hex } = await import("../../lib/guard/scval.ts");
    assert.equal(await sha256Hex(new Uint8Array(identity)), PHASE1_ARTIFACT.wasmHash);
  });

  it("serve a snapshot the console's own read path accepts", async () => {
    const snapshot = await readGuardSnapshot(fixtureServer(), GUARD, OPERATOR_ADDRESS);
    assert.equal(snapshot.status.ok, true);
    if (snapshot.status.ok) {
      assert.equal(snapshot.status.value.admin_frozen, false);
      assert.equal(snapshot.status.value.has_policy, false);
      assert.equal(snapshot.status.value.last_heartbeat, 0n);
    }
    assert.equal(snapshot.identity.ok, true);
    if (snapshot.identity.ok) {
      assert.equal(snapshot.identity.value.bytes, WASM_BYTES);
      assert.equal(snapshot.identity.value.match, true);
      assert.equal(snapshot.identity.value.fetchedSha256, PHASE1_ARTIFACT.wasmHash);
      assert.equal(snapshot.identity.value.reportedWasmHash, PHASE1_ARTIFACT.wasmHash);
    }
    assert.equal(snapshot.policy.ok, true);
    if (snapshot.policy.ok) {
      assert.equal(snapshot.policy.value, null);
    }
    assert.equal(snapshot.window.ok, true);
  });

  it("answer every key the console asks for with the entry for that key", async () => {
    const server = fixtureServer();
    const response = await server.getLedgerEntries(
      accountLedgerKey(),
      contractInstanceLedgerKey(),
      contractCodeLedgerKey(),
    );
    assert.equal(response.latestLedger, MOCK_LEDGER);
    assert.equal(response.entries.length, 3);
  });

  it("reject unhandled methods with a JSON-RPC error", () => {
    const response = handleRpcRequest({ method: "sendTransaction" });
    const parsed = JSON.parse(response.body) as { error?: { code?: number } };
    assert.ok(parsed.error?.code);
  });
});
