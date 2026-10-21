import { getCachedByteLength, getCachedHash, setCachedHash } from "./bytecodeCache.ts";
/**
 * Read-only access to a guard deployment, straight off Soroban RPC.
 *
 * Everything here is a simulation or a ledger read: nothing in this module can
 * mutate state, which is why the dashboard is willing to call it on every render
 * and on a polling interval. Bytes and hashes are handled with `Uint8Array` and
 * Web Crypto only, so the same code runs in the browser and in Node.
 */

import {
  Account,
  Address,
  Asset,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type xdr as Xdr,
} from "@stellar/stellar-sdk";
import { NETWORK, PHASE1_ARTIFACT, READ_SOURCE_FALLBACK } from "./network.ts";
import { guardStorageLedgerKeys, hashToHex, ledgerKeyId, sha256, sha256Hex } from "./scval.ts";
import { parseContractSpec, type ContractSpecResult } from "./contractSpecParser.ts";
import {
  absentStorageEntry,
  decodeStorageEntry,
  storageKeyLabel,
  type RawLedgerEntry,
  type StorageEntryView,
} from "./storage.ts";
import {
  GUARD_STORAGE_KEYS,
  type GuardStatus,
  type PolicyConfig,
  decodePolicy,
} from "stellar-agent-guard-sdk";
import { withTimeout, DashboardReadError } from "./timeout.ts";
import { buildReadDiagnostic, redactDiagnosticText } from "../rpc/timeouts.ts";

export function createServer(rpcUrl: string = NETWORK.rpcUrl): rpc.Server {
  return new rpc.Server(rpcUrl);
}

/**
 * A read succeeded, or it produced a real error. There is deliberately no third
 * case. A failure may carry a safe diagnostic (issue #347): the operation,
 * endpoint origin, network and time, with signed payloads and credentials
 * removed, ready to copy into a report.
 */
export type ReadResult<T> =
  { ok: true; value: T } | { ok: false; error: string; diagnostic?: string };

/** The endpoint a server was constructed with, for diagnostics. */
function endpointOf(server: rpc.Server): string {
  const endpoint = (server as unknown as { serverURL?: URL | string }).serverURL;
  return endpoint instanceof URL ? endpoint.toString() : String(endpoint ?? "");
}

/**
 * Turn a failed read into a `ReadResult` failure with a safe, copyable
 * diagnostic. The error text is redacted as well, because the panel may show
 * it and an RPC or wallet error can echo a signed payload or a URL token.
 */
function readFailure(
  server: rpc.Server,
  operation: string,
  error: unknown,
): { ok: false; error: string; diagnostic: string } {
  const detail =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: redactDiagnosticText(detail),
    diagnostic: buildReadDiagnostic({
      operation,
      endpoint: endpointOf(server),
      network: NETWORK.name,
    }).text,
  };
}

/**
 * Run a read-only contract function and decode its return value.
 *
 * Uses `Operation.invokeContractFunction` with pre-encoded `ScVal` arguments
 * rather than a spec-typed `Contract.call`, so a struct argument (the policy)
 * crosses the boundary exactly as `policyToScVal` built it.
 *
 * `decode` defaults to `scValToNative` — a struct caller with no SDK decoder of
 * its own — and a caller that has one passes it instead, so the decoding rule
 * lives with the type it belongs to rather than being re-stated here.
 */
export async function readContract<T = unknown>(
  server: rpc.Server,
  contractId: string,
  fn: string,
  args: Xdr.ScVal[] = [],
  source: string = READ_SOURCE_FALLBACK,
  decode: (retval: Xdr.ScVal) => T = (retval) => scValToNative(retval) as T,
): Promise<ReadResult<T>> {
  try {
    return await withTimeout(async () => {
      const account = new Account(source, "0");
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: NETWORK.passphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({ contract: contractId, function: fn, args }),
        )
        .setTimeout(30)
        .build();
      const simulation = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation)) {
        return readFailure(server, `${fn}()`, stringifyError(simulation.error));
      }
      const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
      const retval = success.result?.retval;
      if (retval === undefined) {
        return readFailure(server, `${fn}()`, `simulation returned no value`);
      }
      return { ok: true, value: decode(retval) };
    });
  } catch (error) {
    if (error instanceof DashboardReadError) throw error;
    return readFailure(server, `${fn}()`, error);
  }
}

export async function readStatus(
  server: rpc.Server,
  guard: string,
  source?: string,
): Promise<ReadResult<GuardStatus>> {
  return await withTimeout(async () => {
    return readContract<GuardStatus>(server, guard, "status", [], source);
  });
}

/**
 * The installed policy, or `null` for the contract's default-deny state.
 *
 * The retval goes through the SDK's `decodePolicy` — the same strict decoder the
 * SDK validates policy XDR with — rather than an unchecked native cast that
 * would hand the console a half-filled object. The one shape kept here is the
 * console's own: default-deny reads as `null`, not as a failed read.
 */
export function readPolicy(
  server: rpc.Server,
  guard: string,
  source?: string,
): Promise<ReadResult<PolicyConfig | null>> {
  return readContract<PolicyConfig | null>(server, guard, "policy", [], source, (retval) =>
    retval.type === "scvVoid" ? null : decodePolicy(retval),
  );
}

/**
 * One of the guard's own persistent storage entries (e.g. the rolling `Window`).
 *
 * The ledger-entry lookup and its decode belong to the SDK's
 * `readPersistentEntry`; the only thing this wrapper adds is the console's
 * `ReadResult` shape, because every read surface here reports success-or-error
 * instead of throwing at the caller.
 */
export async function readPersistentEntry<T = unknown>(
  server: rpc.Server,
  contractId: string,
  dataKeyName: string,
): Promise<ReadResult<T | null>> {
  try {
    return await withTimeout(async () => {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contractId).toScAddress(),
          key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]),
          durability: xdr.ContractDataDurability.persistent,
        }),
      );
      const response = await server.getLedgerEntries(key);
      const entry = response.entries?.[0] as unknown as
        | {
            val?: { contractData?: { val?: Xdr.ScVal } | (() => { val?: () => Xdr.ScVal }) };
          }
        | undefined;
      if (!entry?.val) return { ok: true, value: null };
      // The decoded XDR wrapper exposes `contractData` as a plain property in this
      // SDK build, but keep the callable shape working too rather than pinning to
      // one internal representation.
      const contractData =
        typeof entry.val.contractData === "function"
          ? entry.val.contractData()
          : entry.val.contractData;
      const scval =
        typeof contractData?.val === "function" ? contractData.val() : contractData?.val;
      if (!scval) return { ok: true, value: null };
      return { ok: true, value: scValToNative(scval) as T };
    });
  } catch (error) {
    if (error instanceof DashboardReadError) throw error;
    return readFailure(server, `getLedgerEntries(${dataKeyName})`, error);
  }
}

/**
 * Every storage entry the guard contract holds, decoded for the storage
 * explorer (issue #150).
 *
 * Soroban RPC has no "list this contract's keys" call: `getLedgerEntries` takes
 * the keys to look up, so the set queried here is the contract-instance entry
 * plus the SDK's declared `DataKey` vocabulary in both durabilities. Keys outside
 * that vocabulary would not be found, which is why the explorer's copy says the
 * list is the guard's own storage rather than claiming to be exhaustive.
 *
 * A key the ledger does not hold still gets a row (from `absentStorageEntry`),
 * because "there is no policy stored" is a fact the operator needs to read, and
 * an omitted key would render as a gap in the list rather than as an answer.
 */
export async function readContractStorage(
  server: rpc.Server,
  guard: string,
): Promise<ReadResult<StorageEntryView[]>> {
  try {
    return await withTimeout(async () => {
      const scAddress = new Address(guard).toScAddress();
      // The contract-instance entry is itself a contract-data key whose ScVal is
      // `LedgerKey::ContractInstance`; the host stores it under `persistent`.
      const instanceKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: scAddress,
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent,
        }),
      );
      const keys = [
        instanceKey,
        ...guardStorageLedgerKeys(guard),
        ...guardedTemporaryLedgerKeys(guard),
      ];

      const response = await server.getLedgerEntries(...keys);
      const latestLedger = response.latestLedger ?? null;
      const byKeyId = new Map<string, StorageEntryView>();
      for (const entry of response.entries ?? []) {
        const raw = entry as unknown as RawLedgerEntry;
        if (!raw?.key) continue;
        const decoded = decodeStorageEntry(raw, latestLedger);
        byKeyId.set(decoded.id, decoded);
      }

      const views: StorageEntryView[] = [];
      for (const key of keys) {
        const id = ledgerKeyId(key);
        const found = byKeyId.get(id);
        if (found) {
          views.push(found);
          continue;
        }
        // Every key in `keys` was built as `LedgerKey::ContractData`, so the
        // arm is known; the SDK's union type cannot see that. This build exposes
        // the arm's fields as plain properties, which `storage.ts` reads the
        // same tolerant way.
        const contractData = (key as unknown as { contractData: xdr.LedgerKeyContractData })
          .contractData;
        views.push(absentStorageEntry(id, storageKeyLabel(contractData.key)));
      }
      return { ok: true, value: views };
    });
  } catch (error) {
    if (error instanceof DashboardReadError) throw error;
    return readFailure(server, "getLedgerEntries(storage)", error);
  }
}

/**
 * The guard's declared keys under the `temporary` durability.
 *
 * The guard writes its persistent entries, so these normally come back absent —
 * they are queried so the explorer can show the storage class as unused rather
 * than not mentioning it.
 */
function guardedTemporaryLedgerKeys(guard: string): xdr.LedgerKey[] {
  const scAddress = new Address(guard).toScAddress();
  return GUARD_STORAGE_KEYS.map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddress,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.temporary,
      }),
    ),
  );
}

/** The rolling-window spend ledger. No read function exposes it; it is internal accounting. */
export interface WindowState {
  total: bigint;
  entries: Array<{ ts: bigint; amount: bigint }>;
}

export async function readWindow(
  server: rpc.Server,
  guard: string,
): Promise<ReadResult<WindowState | null>> {
  const raw = await readPersistentEntry<WindowState>(server, guard, "Window");
  if (!raw.ok) return raw;
  if (raw.value === null || raw.value === undefined) return { ok: true, value: null };
  return { ok: true, value: raw.value };
}

/**
 * The guard's live XLM balance, in stroops.
 *
 * This is the balance source for the freeze-confirmation threshold (issue
 * #15, consumed by `requiresFreezeChallenge` in `lib/guard/freezeChallenge.ts`),
 * so it must be a live number, never a cached or derived one: it reads the
 * native Stellar Asset Contract's persistent `Balance` ledger entry for the
 * guard's address straight from Soroban RPC. The SDK's
 * `Server.getAssetBalance(address, Asset.native(), passphrase)` resolves
 * exactly that key — the same value a simulation of the SAC `balance(holder)`
 * view returns, which is the balance source SPEC §8 classifies — and unlike
 * `Server.getAccountEntry` it works for the guard's contract (`C…`) address,
 * not just `G…` accounts.
 *
 * Absence is a real answer, not a failure: the SAC keeps no `Balance` entry
 * for an address holding no XLM (the SDK documents `balanceEntry` as present
 * only when there is one), so a successful lookup with no entry reads as
 * `0n`. Everything else — transport error, HTTP 429, unparseable amount — is
 * an error, and callers must fail safe on it (escalate the freeze challenge)
 * rather than treat uncertainty as a small balance.
 */
export async function readNativeXlmBalance(
  server: rpc.Server,
  guard: string,
  passphrase: string = NETWORK.passphrase,
): Promise<ReadResult<bigint>> {
  try {
    const response = await server.getAssetBalance(guard, Asset.native(), passphrase);
    const entry = response.balanceEntry;
    if (!entry) return { ok: true, value: 0n };
    return { ok: true, value: BigInt(entry.amount) };
  } catch (error) {
    return readFailure(server, "getAssetBalance(native XLM)", error);
  }
}

export interface WasmIdentity {
  /** The hash the ledger reports for the contract's instance. */
  reportedWasmHash: string | null;
  /** SHA-256 recomputed over the bytecode fetched from the chain. */
  fetchedSha256: string;
  bytes: number;
  /** True when the ledger's declared hash and the fetched bytes agree. */
  match: boolean;
}

/**
 * The cache namespace for a server. `rpc.Server` exposes its endpoint as a
 * `URL`, so it has to be stringified before it can be inspected.
 */
function networkCacheKey(server: rpc.Server): string {
  const endpoint = (server as unknown as { serverURL?: URL | string }).serverURL;
  const text = endpoint instanceof URL ? endpoint.toString() : String(endpoint ?? "");
  return text.includes("testnet") ? "testnet" : "public";
}

/**
 * Verify that a deployed contract really runs the bytecode the ledger claims.
 *
 * `getContractWasmByContractId` returns the stored code; hashing it here is an
 * independent check, because the ledger keys `ContractCode` by the hash of the
 * uploaded bytes. This is the check that makes "we deployed the proven artifact"
 * a fact rather than an assertion.
 */
export async function verifyWasmIdentity(
  server: rpc.Server,
  contractId: string,
): Promise<WasmIdentity> {
  return await withTimeout(async () => {
    const instance = (await server.getContractInstance(contractId)) as unknown as {
      executable?: { wasmHash?: unknown };
    };
    const reportedWasmHash = hashToHex(instance.executable?.wasmHash);

    // Contract code is immutable, so an unchanged instance lets us skip the
    // (large) WASM download and the SHA-256 over it.
    const networkKey = networkCacheKey(server);
    const cachedHash = getCachedHash(networkKey, contractId);

    if (cachedHash) {
      return {
        reportedWasmHash,
        fetchedSha256: cachedHash,
        bytes: getCachedByteLength(networkKey, contractId) ?? 0,
        match: reportedWasmHash === cachedHash,
      };
    }

    const wasm = await server.getContractWasmByContractId(contractId);
    const bytes = toBytes(wasm);
    const fetchedSha256 = await sha256Hex(bytes);
    setCachedHash(networkKey, contractId, fetchedSha256, bytes.length);

    return {
      reportedWasmHash,
      fetchedSha256,
      bytes: bytes.length,
      match: reportedWasmHash === fetchedSha256,
    };
  });
}

/** The exact bytecode of a deployed contract, fetched from the chain. */
export async function fetchContractWasm(
  server: rpc.Server,
  contractId: string,
): Promise<Uint8Array> {
  return await withTimeout(async () => {
    return toBytes(await server.getContractWasmByContractId(contractId));
  });
}

/**
 * The deployed contract's bytes, or why they could not be read.
 *
 * Fetching a protocol contract's code can fail for reasons that are not the
 * contract's fault — a Wrong-Chain contract id, an RPC outage — so the caller
 * gets a typed failure it can show, rather than a throw it must catch.
 */
export type ContractWasmResult = { ok: true; wasm: Uint8Array } | { ok: false; error: string };

/**
 * Fetch a contract's WASM and extract its exported functions from the embedded
 * spec, for the policy form's per-function allowlist picker.
 *
 * A read failure and a missing spec are reported through the same envelope so
 * the form can fall back to manual entry in both cases; `reason` distinguishes
 * a contract that genuinely has no spec (see `SpecMissingReason`) from a chain
 * error.
 */
export async function readContractSpec(
  server: rpc.Server,
  contractId: string,
): Promise<ContractSpecResult | { ok: false; reason: "fetch"; error: string }> {
  try {
    const wasm = await fetchContractWasm(server, contractId);
    return parseContractSpec(wasm);
  } catch (error) {
    return {
      ok: false,
      reason: "fetch",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  const candidate = value as { buffer?: unknown };
  if (candidate?.buffer) return new Uint8Array(candidate.buffer as ArrayBuffer);
  throw new Error("RPC returned contract bytecode in an unrecognised shape");
}

/**
 * The address `create_custom_contract` will produce for a given deployer and
 * salt: `sha256(HashIdPreimage::ContractId { network_id, preimage })`.
 *
 * Computing it locally means the operator is told the guard's address *before*
 * signing the deploy, and the address is then confirmed by reading the instance
 * back off the ledger — so a deploy cannot silently land somewhere unexpected.
 */
export async function predictContractId(params: {
  deployerPublicKey: string;
  salt: Uint8Array;
  passphrase?: string;
}): Promise<string> {
  const passphrase = params.passphrase ?? NETWORK.passphrase;
  const networkId = await sha256(new TextEncoder().encode(passphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(params.deployerPublicKey).toScAddress(),
          salt: params.salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(await sha256(new Uint8Array(preimage.toXDR())));
}

/** Does the contract's own storage say `initialize` has already run? */
export async function isInitialized(server: rpc.Server, guard: string): Promise<boolean> {
  return await withTimeout(async () => {
    const instance = await server.getContractInstance(guard);
    const decoded = JSON.parse(JSON.stringify(instance)) as {
      storage?: Array<{ key?: { vec?: Array<{ symbol?: string; sym?: string }> }; val?: unknown }>;
    };
    for (const item of decoded.storage ?? []) {
      const first = item.key?.vec?.[0];
      if ((first?.symbol ?? first?.sym) !== "Initialized") continue;
      const value = item.val as { bool?: boolean } | string | undefined;
      if (typeof value === "string") return value.includes("true");
      return value?.bool === true;
    }
    return false;
  });
}

/** True when a contract call failed because `initialize` had already run (#2). */
export function isAlreadyInitializedError(detail: string): boolean {
  return /Error\(Contract, #2\)/.test(detail) || detail.includes("error code: 2");
}

/** The SDK's `Contract` helper, for callers that want spec-typed reads. */
export function contractAt(contractId: string): Contract {
  return new Contract(contractId);
}

/**
 * The build's own commitment to the artifact it deploys: the bytes Phase 1
 * proved. Used by the deploy flow as an assertion, and by tests as a constant.
 */
export function pinnedArtifact() {
  return { ...PHASE1_ARTIFACT };
}

export { stringifyError };

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
