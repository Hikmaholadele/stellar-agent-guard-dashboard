# stellar-agent-guard-dashboard — architecture and consumer contract

This document is the console's design record: what it is allowed to do, what it is deliberately not
allowed to do, and how each claim it makes is checked. It is written to be read alongside the
contracts repo's `SPEC.md`, which owns the on-chain design; nothing here restates or extends that.

---

## 1. Position in the system

The dashboard is the **third** consumer of the guard contract, after the contract itself and the SDK.
It is a pure consumer: it introduces no new on-chain mechanism, no new policy semantics, and no new
signing path the other two repos did not already define.

```
contracts repo   ── defines the account, the policy engine and the event vocabulary
      │
sdk repo         ── answers "may this agent make this call", signs as the agent, reads events
      │
dashboard (here) ── configures the account, shows its state, freezes it. As the ADMIN, not the agent.
```

That asymmetry is the single most important thing to hold onto: the SDK acts as the **agent** (the
smart account authorizing its own outbound calls, via `__check_auth`), while the dashboard acts as the
**admin** (a plain account calling `set_policy`, `freeze`, `unfreeze`). The two therefore share the
policy vocabulary and the event vocabulary, and share nothing about signing.

---

## 2. Enforcement scope — the boundary this interface must not blur

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and
automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose
arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by
the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window
and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained
enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

**This is the required framing, and it is quoted here verbatim from the single shared constant in
`lib/guard/network.ts`.** Three consequences are enforced by construction:

1. The console renders the statement wherever enforcement is described (`ScopeNotice`), so the
   interface cannot claim more than the contract does.
2. `tests/unit/scopeStatement.test.ts` asserts that this document, the README and the constant all
   carry the identical wording, and that the statement still contains its limitation half. The
   failure mode being guarded against is a capability claim quietly outgrowing the enforcement.
3. The statement is never split: the capability and its limitation live in one paragraph, so the
   boundary cannot be read past as a footnote.

**Where the console is silent is also part of the contract.** The console does not offer an
"enforce this arbitrary call" control, because the platform cannot yet enforce one. Offering the
control and documenting the caveat would be the overclaim in a different costume.

**Canonical policy, not a second copy.** The normative statement of _what the contract enforces_ lives
in the contracts repository's [`SPEC.md`](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md).
This document and the README reproduce the shared wording above as the interface's own drift-guard, but
the contracts `SPEC.md` remains the single source of truth for the enforcement policy. If that document
changes its boundary text, this one and the constant in `lib/guard/network.ts` must be re-synced in the
same change — `tests/unit/scopeStatement.test.ts` fails otherwise, which is the mechanism that keeps
the copies honest.

---

## 3. Trust model

| Asset                                | Where it lives                        | Who can use it                                                       |
| ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| Admin secret key                     | The operator's Freighter wallet       | Nobody else. Never in this repo, never in a server, never in a build |
| Agent secret key                     | The agent runtime, via the SDK        | Not this console. The console cannot act as the agent                |
| Policy, freeze state, rolling window | Guard contract storage on Stellar     | Read by anyone; written by the admin                                 |
| Pinned Phase 1 bytecode              | Fetched from the chain at deploy time | Hashed and compared before any signature is requested                |

There is **no server component**, and that is an architectural decision rather than an omission:

- Soroban RPC serves `access-control-allow-origin: *`, so the browser can talk to it directly. A
  proxy would exist only to hold something, and there is nothing to hold.
- An API route that signs on the operator's behalf would have to custody an admin key, which would
  contradict the non-custodial property the whole product is built on. A console that can move funds
  without the operator approving each action is a worse console, not a more convenient one.

**Network pinning.** Freighter may be pointed at any network. `connectWallet()` reads the wallet's
network and refuses to proceed if it does not match this deployment's passphrase, because a signature
produced for a different network id cannot authorize a call on this one — failing at connection is
better than failing after an approval the operator cannot understand.

**Zero-backend, mechanically.** "No server component" is not a promise, it is checked. `app/`
contains no `route.ts` (no Next.js API route) and the repository contains no `middleware.ts`:

```
$ find app \( -name 'route.ts' -o -name 'route.tsx' \) | wc -l
0
$ find . -path ./node_modules -prune -o -name 'middleware.ts' -print | wc -l
0
```

Both are empty, so there is no request handler in this codebase that could sign, hold a key, or proxy
the RPC. Re-confirming those two greps still return nothing is part of reviewing any change to `app/`.

CI enforces the same boundary mechanically. `npm run check:no-server` fails on any
`app/**/route.ts(x)` or repository `middleware.ts`, prints the offending paths, and links
[the zero-server ADR](./docs/adr/001-zero-server-architecture.md), so an API surface cannot be
introduced without deliberately changing this decision and the review checklist.

---

## 4. Read path

Every number the console displays comes from one of these, on every refresh:

| Value             | Source                                                             | Failure behaviour                         |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `status()`        | `simulateTransaction`, read-only                                   | renders an error block                    |
| `policy()`        | `simulateTransaction`, read-only                                   | renders an error block                    |
| Rolling window    | `getLedgerEntries` on `DataKey::Window`                            | renders an error block                    |
| Artifact identity | `getContractInstance` + `getContractWasmByContractId` + local hash | renders an error block                    |
| Events            | `getEvents`, cursor-polled                                         | surfaces the poll error, keeps the cursor |
| `check()`         | `simulateTransaction`, read-only replica of the decision path      | shows the contract's own verdict          |

**No default-on-failure.** `GuardSnapshot` carries a `ReadResult<T>` per field, and `Read<T>` renders
either the value or an error. There is deliberately no third branch. A dashboard that shows `0` when
the RPC is unreachable is displaying mock state that is indistinguishable from real state, which is
the single most dangerous thing this interface could do — an operator would read "no spending" from a
page that has no idea.

The rolling window is read straight from the ledger because no read function exposes it: it is the
account's internal spend accounting, and it is the only way to see how much of the rolling cap is
currently consumed.

---

## 5. Write path

Every write follows the sequence the Stellar host requires, and none of them broadcast before an
enforced simulation passes:

```
build probe ──► simulate (recording) ──► N authorizations reported
                                             │
                                             ▼
                              wallet signs each authorization entry
                                             │
                                             ▼
                     simulate again (enforce) ──► runs the REAL __check_auth
                                             │
                              ┌──────────────┴──────────────┐
                        refused                        passes
                     (nothing sent)          assemble ──► wallet signs envelope ──► submit ──► poll
```

Details that are load-bearing rather than incidental:

- **One sequence number per transaction.** `TransactionBuilder` _increments_ the source `Account`
  object on `build()`. The probe and the assembled transaction are therefore each built from a fresh
  `Account` pinned to the same sequence. Sharing one object submits `N+1` while the simulation priced
  `N`, and the network rejects it as `tx_bad_seq` — a bug that presents as a wallet problem and is not
  one. (This was found during the Phase 3 proof and is why the code carries the comment.)
- **Authorization entries are preserved, not dropped.** An operation submitted with an empty auth
  list is treated as a recording-mode request, so the guard would never run and core would reject the
  submission. For contract calls, `invokeWithWallet` attaches exactly the entries the host asked for.
- **`create_contract` needs its recorded authorization.** The narrow `submitOperation` path (deploy,
  upload) goes through the RPC's own prepare step, which attaches the recorded entry. Without it the
  transaction is _included and then rejected_ by the host as `Error(Auth, InvalidAction)` — which
  reads like a permissions surprise and is really a missing entry. Rejections are decoded
  (`describeRejectedResult`) so the host's own reason is shown instead of a bare "trapped".
- **Refusals have no hash by construction.** A refused call was never broadcast, so the console says
  so explicitly rather than showing a blank where a transaction hash would go.

### What the console can and cannot do as admin

| Operation                     | Allowed   | Note                                                                                                                                 |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `set_policy`, `revoke_policy` | yes       | resets the rolling window and restarts the DMS clock                                                                                 |
| `freeze`, `unfreeze`          | yes       | the panic button and its reversal                                                                                                    |
| `rotate_agent_key`            | not wired | holds a key-management decision this console has no UI to make safely                                                                |
| `heartbeat`                   | **no**    | requires the _guard's own_ auth (`current_contract_address().require_auth()`), i.e. the agent's key. It belongs to the SDK's runtime |
| deploy / initialize           | yes       | deploy targets only the pinned artifact                                                                                              |

`heartbeat` being unavailable here is not an omission to fix: the admin key deliberately has no
fund-moving or liveness-forging power. The admin can replace the key the account authenticates
(`rotate_agent_key`) but can never authenticate as the agent.

---

## 6. Deployment invariants

A deploy from this console is only permitted to produce an instance of the artifact Phase 1 proved:

1. Fetch the bytecode currently stored for Phase 1's instance, off the chain.
2. Hash it. Compare against the pinned `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63`
   **and** the pinned byte length. Any mismatch aborts before a wallet is prompted.
3. Confirm the pinned code is still a live `ContractCode` entry, so an expired entry surfaces as a
   clear message rather than a host error mid-signing.
4. Predict the contract address from `(deployer, salt)` and show it to the operator _before_ signing.
5. Create the contract referencing the pinned hash.
6. Read the new instance back and re-verify it runs the pinned hash, then adopt it.

Step 6 is what makes the claim real: without it, "deployed" would mean "a transaction was signed",
which is a different and much weaker statement. If step 6 fails, the console says the instance is
**not** the pinned artifact rather than reporting a successful deploy.

---

## 7. Telemetry semantics

Three facts shape the feed, and each is stated in the UI rather than hidden:

1. **Soroban has no push stream.** "Real time" here means cursor-based `getEvents` polling. The cursor
   is carried forward rather than re-derived from a ledger number, because re-scanning from a ledger
   can skip events that fell outside the window between polls. The honest latency floor is the ledger
   close interval (~5s), not the poll interval.
2. **A refused decision never reaches the ledger.** The guard returns `Err`, which rolls the event
   back, so a listener tailing only committed events would see a contract that approves everything.
   The only refusals this console can show are the ones _it_ produced, decoded from the failed
   enforced simulation's diagnostics and labelled `diagnostic`.

3. **Tailing N guards costs N poll loops.** The SDK's telemetry listener is single-guard (`getEvents` is filtered per contract), so a simultaneous tail is a fan-out of listener instances. The feed therefore supervises at most `FEED_GUARD_CAP` (5) guards at a time; registry entries beyond the cap are named as **not tailed** rather than dropped silently, and the poll load is documented as scaling with the number watched. Listener instances are reconciled (added/removed/stopped) on every registry change, so churn leaves exactly one listener per watched guard and no leak.

An empty feed is therefore **not** evidence that nothing was refused on chain, and the panel says so. Nor is it evidence that _every_ registered guard was watched — when the cap is in force, the panel says which guards are outside it.

---

## 8. State model — derived vs stored

The console's core correctness rule is that anything the contract can answer must be read from the
chain, and only genuinely local data (drafts, preferences, the instance registry) is persisted. A
value _derived_ from the chain may be stale for at most one poll; a value _stored_ locally must never
be presented as though it were chain state. Every state item the console holds is classified here,
with its source, its refresh trigger, and whether it is allowed to be wrong.

| State                                                | Source                                                                                          | Refresh trigger                                              | May it lie (stale)?                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `status()` — freeze flags, heartbeat, dead-man state | chain (read-only `simulateTransaction`)                                                         | mount + poll; re-read after every freeze/unfreeze            | no — a failed read renders an error, never a stale value                                                     |
| `policy()`                                           | chain (`simulateTransaction`)                                                                   | mount + poll; re-read after `set_policy`/`revoke_policy`     | no                                                                                                           |
| Rolling spend window                                 | chain (`getLedgerEntries` on `DataKey::Window`)                                                 | mount + poll                                                 | no                                                                                                           |
| Balance                                              | chain (SAC `balance` via simulation)                                                            | mount + poll                                                 | no                                                                                                           |
| Artifact identity / verification                     | chain (`getContractInstance` + `getContractWasmByContractId`) + local hash                      | on demand, before deploy and in the integrity inspector      | no — a mismatch aborts the deploy                                                                            |
| Telemetry events                                     | chain (`getEvents`, cursor-based)                                                               | continuous polling; cursor carried forward, never re-derived | no — an empty or gapped page is labelled, not smoothed over                                                  |
| Registered guard instances (the fleet)               | **`localStorage`** (`stellar-agent-guard-dashboard.instances.v2.<network>`)                     | user action (add/remove/select)                              | yes, by design — it is an address list, not chain state; every row's live numbers are re-read from the chain |
| Policy form draft                                    | component-local until submit                                                                    | user input                                                   | yes, while editing — never treated as installed until the chain re-read confirms it                          |
| Address book                                         | **`localStorage`** (`…addressBook.v1`)                                                          | user action                                                  | yes — convenience data, carries no fund authority                                                            |
| Transaction history                                  | **`localStorage`** (`…txHistory.v1`)                                                            | after each submission                                        | yes — it records what this browser submitted; the chain is authoritative                                     |
| Layout / theme / alert / idle preferences            | **`localStorage`** (`…layout.v1`, `…namedLayouts.v1`, `theme`, `…idleTimeout.v1`, `…alerts.v1`) | user action                                                  | yes — presentation only                                                                                      |
| Wallet-provider preference                           | **`localStorage`** (`…walletProvider.v1`)                                                       | user action (connector pick)                                 | yes — convenience, carries no authority                                                                      |
| Multisig approval evaluation                         | pasted envelope is component-local; signer weights/thresholds are read live from Horizon        | on paste / on demand                                         | n/a for the pasted envelope; the account's signers are re-read, not cached                                   |
| Tab-sync envelope                                    | **`localStorage`** (`…tab-sync.v1`) when `BroadcastChannel` is unavailable                      | transient                                                    | n/a — a transport, not state; receiving tabs re-read the chain (§7)                                          |
| Active tab / route / modal-open flags                | component-local                                                                                 | user action                                                  | n/a                                                                                                          |

The rule that makes the table enforceable: **a `localStorage` value may only be an input to a chain
read, never a substitute for one.** The instance registry and the address book supply addresses; the
status, policy and balance displayed for those addresses are always re-read. Test coverage for the
persisted helpers lives beside them (`tests/unit/tabSync.test.ts`, `tests/unit/txHistory.test.ts`,
`tests/unit/addressBook.test.ts`, `tests/unit/dashboardGrid.test.ts`, `tests/unit/useIdleTimer.test.ts`).

### Browser persistence inventory

The console exposes **Browser data inventory** beside the contract storage explorer. It lists every
browser persistence key family, its purpose, whether it may contain public operational metadata,
and whether its contents are chain-derived, operator-entered, or presentation-only. The inventory
is backed by the helpers' exported key constants and checked by
`tests/unit/storageInventory.test.ts`; the short-lived bytecode cache and cross-tab transport are
included as well. Registry, address-book, and layout records use explicit schema versions. A
malformed, partial, unknown-future, or unsuccessfully migrated record is left in place for recovery;
it is never used as a substitute for live chain state. Browser storage contains no secret keys.

### Complete write surface

Every path that mutates chain state, and what it does after the write. No write path trusts its own
submission response where the outcome matters.

| Write                                     | Trigger                             | Auth path                                                                           | Re-read after?                                                                     |
| ----------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `set_policy` / `revoke_policy`            | `/configure` form, migration wizard | operator wallet signs auth entries + envelope; enforced simulation before broadcast | **yes** — policy re-read                                                           |
| `freeze` / `unfreeze`                     | `PanicPanel`                        | operator wallet, same enforced-simulation path                                      | **yes, mandatory** — `status()` must report the new flag or the UI reports failure |
| deploy (`create_contract`) + `initialize` | `DeployPanel`                       | operator wallet; `create_contract` uses its recorded authorization                  | **yes** — the new instance is re-read and re-verified against the pinned hash      |
| agent SAC transfers                       | not this console                    | agent key, via the SDK                                                              | n/a — the console is admin, never the agent                                        |

No other write exists. In particular the console never calls `heartbeat` (it needs the guard's own
auth — see §5) and never holds a key that could authorize one.

---

## 9. Evidence

`scripts/prove-phase3.ts` drives the same `lib/guard/*` modules the UI calls, with a keypair-backed
`WalletSigner` in place of Freighter. Results are recorded in
[`tests/fixtures/phase3-proof.json`](./tests/fixtures/phase3-proof.json) and described, including the
limits of what was verified, in [`tests/fixtures/README.md`](./tests/fixtures/README.md).

Notably **not** claimed: that the browser UI itself was driven end to end. This environment has no
browser, so the UI is verified by building and serving it, and the on-chain behaviour is verified by
driving the identical library code headlessly. Files under `lib/guard/` are the tested surface; the
React components are thin over them and are not covered by automated tests.

## 10. Architecture Decision Records

Key architectural decisions are documented as ADRs under [`docs/adr/`](./docs/adr/):

- [ADR 001 — Zero-Server Client-Only Architecture](./docs/adr/001-zero-server-architecture.md)
- [ADR 002 — Diagnostic Simulation for Rejections](./docs/adr/002-diagnostic-simulation-for-rejections.md)
