# README claims inventory

This is a **living document**. Every capability claim the top-level `README.md` makes about the
dashboard is listed here alongside the evidence that it is still true in this checkout, and the date
it was last verified. It exists because this backlog landed a large number of dashboard changes at
once, and a README that quietly drifts ahead of (or behind) the code is the same failure mode the
[enforcement-scope rule](./enforcement-scope.md) guards against, one layer up.

**Upkeep rule (also stated in [`CONTRIBUTING.md`](../CONTRIBUTING.md)):** when you change README
behaviour — add, rename, or remove a screen, panel, script, or capability bullet — update the
matching row here in the same commit, and refresh its `Last verified` date. A row that has not been
re-verified since its feature last changed is not evidence.

- Statuses: **PASS** = verified true, no change needed. **FIXED** = was stale/wrong or missing and
  was corrected in the same PR as this sweep. **HISTORICAL** = a frozen record of a past run, not a
  claim about current behaviour. **EXTERNAL** = verifiable only outside this repository (npm, GitHub
  settings, a sibling repo).
- Method: each row was checked against the file or test named in the Evidence column. Entries are
  `path` (or `path:line`) references; run the test named in the Evidence column to re-verify the
  behavioural rows mechanically.

Last full sweep: **2026-09-29** (branch `chore/dashboard-repo-hygiene-topics-ci-spec-claims-46-47-49-51`,
based on `main` @ `b8d1cbe`).

## 1. Header, badges, and positioning

| #   | README claim (section)                                                                                                                       | Evidence                                                                                                                                                                                                                 | Status    | Last verified |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- |
| 1   | CI status badge points at a real workflow                                                                                                    | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)                                                                                                                                                                | PASS      | 2026-09-29    |
| 2   | MIT license badge                                                                                                                            | [`LICENSE`](../LICENSE)                                                                                                                                                                                                  | PASS      | 2026-09-29    |
| 3   | "next.js-16" badge                                                                                                                           | `package.json` → `"next": "^16.3.5"`                                                                                                                                                                                     | PASS      | 2026-09-29    |
| 4   | "node-24+" badge                                                                                                                             | `package.json` → `engines.node: ">=24.0.0"`                                                                                                                                                                              | PASS      | 2026-09-29    |
| 5   | "Client-side operator console … deploy smart accounts, configure spending guardrails, monitor live telemetry, and trigger emergency freezes" | [`app/page.tsx`](../app/page.tsx), [`app/configure/page.tsx`](../app/configure/page.tsx), [`components/PanicPanel.tsx`](../components/PanicPanel.tsx), [`components/TelemetryFeed.tsx`](../components/TelemetryFeed.tsx) | PASS      | 2026-09-29    |
| 6   | "pure client-side Next.js interface for Freighter wallets"                                                                                   | [`lib/guard/wallet.ts`](../lib/guard/wallet.ts), [`lib/guard/walletConnector.ts`](../lib/guard/walletConnector.ts), [`components/WalletBar.tsx`](../components/WalletBar.tsx)                                            | PASS      | 2026-09-29    |
| 7   | "Holds no secrets and has no server component"                                                                                               | No `app/**/route.ts` and no `middleware.ts` in the repo (see §3 existence proof in [`SPEC.md`](../SPEC.md))                                                                                                              | PASS      | 2026-09-29    |
| 8   | "Consumes the SDK as a vendored package tarball"                                                                                             | `package-lock.json` → `node_modules/stellar-agent-guard-sdk` resolves `file:vendor/stellar-agent-guard-sdk-0.1.1.tgz`                                                                                                    | PASS      | 2026-09-30    |
| 9   | "…pending registry publish authorization" — contradicted the Phase 2 table below it, which states the SDK **is** published to npm            | `package.json` `description`/`version`, Phase 2 table row "SDK published to npm — **met**"                                                                                                                               | **FIXED** | 2026-09-29    |

## 2. Phase 2 exit-status table and "Verified against live testnet" table

These rows are point-in-time records. They are **HISTORICAL**: they document a run that happened,
and are not re-verified on every sweep. The README now frames the on-chain table as a dated record.

| #   | README claim                                                | Evidence                                                                                            | Status     | Last verified |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- | ------------- |
| 10  | SDK published to npm (`npm view` output quoted)             | npm registry (EXTERNAL)                                                                             | HISTORICAL | 2026-09-29    |
| 11  | CI green on `main` (run `35063436332`)                      | GitHub Actions (EXTERNAL)                                                                           | HISTORICAL | 2026-09-29    |
| 12  | Real integration tests against testnet (SDK repo, 5/5 live) | `stellar-agent-guard-sdk` repo (EXTERNAL)                                                           | HISTORICAL | 2026-09-29    |
| 13  | Phase 2 merged (PR #2, commit `897708a`)                    | SDK repo history (EXTERNAL)                                                                         | HISTORICAL | 2026-09-29    |
| 14  | Every transaction hash in the testnet proof table           | [`tests/fixtures/phase3-proof.json`](../tests/fixtures/phase3-proof.json) (`ranAt`, `passed: true`) | HISTORICAL | 2026-09-29    |
| 15  | Pinned bytecode hash `f47919…` (39673 bytes)                | [`lib/guard/network.ts`](../lib/guard/network.ts) → `PHASE1_ARTIFACT`                               | PASS       | 2026-09-29    |

## 3. "What makes this different" and "What it does"

| #   | README claim                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                | Status                      | Last verified |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------- |
| 16  | Zero-backend client security                                                                                                                                           | No route handlers / middleware (glob `**/route.{ts,tsx,js}`, `**/middleware.{ts,js}` → 0 files)                                                                                                                                                                                                                                                                         | PASS                        | 2026-09-29    |
| 17  | On-chain bytecode verification before deploy                                                                                                                           | [`lib/guard/wasmInspector.ts`](../lib/guard/wasmInspector.ts), [`components/DeployPanel.tsx`](../components/DeployPanel.tsx)                                                                                                                                                                                                                                            | PASS                        | 2026-09-29    |
| 18  | Address prediction pre-signing                                                                                                                                         | [`lib/guard/saltGenerator.ts`](../lib/guard/saltGenerator.ts), `tests/unit/saltGenerator.test.ts`                                                                                                                                                                                                                                                                       | PASS                        | 2026-09-29    |
| 19  | Re-read deployed contract to confirm execution integrity                                                                                                               | `components/DeployPanel.tsx`, `lib/guard/guardOps.ts`                                                                                                                                                                                                                                                                                                                   | PASS                        | 2026-09-29    |
| 20  | Explicit dual-freeze semantics (admin freeze vs dead-man switch)                                                                                                       | [`components/StatusPanel.tsx`](../components/StatusPanel.tsx), `lib/guard/chain.ts`                                                                                                                                                                                                                                                                                     | PASS                        | 2026-09-29    |
| 21  | "No mock state" — never a silent zero on a failed read                                                                                                                 | `lib/guard/chain.ts` (`ReadResult<T>`), [`components/bits.tsx`](../components/bits.tsx), `tests/unit/demoFixtures.test.ts`                                                                                                                                                                                                                                              | PASS                        | 2026-09-29    |
| 22  | No-code configurator on `/configure` (caps, window, allowlists, windows, pause, DMS)                                                                                   | [`components/PolicyForm.tsx`](../components/PolicyForm.tsx), `lib/guard/policyForm.ts`, `tests/unit/policyForm.test.ts`                                                                                                                                                                                                                                                 | PASS                        | 2026-09-29    |
| 23  | `policyToScVal` encode + `set_policy` execution                                                                                                                        | `lib/guard/scval.ts`, `lib/guard/guardOps.ts`, `tests/unit/scval.test.ts`                                                                                                                                                                                                                                                                                               | PASS                        | 2026-09-29    |
| 24  | Artifact-verified deploy from verified WASM                                                                                                                            | `components/DeployPanel.tsx`, `lib/guard/guardOps.ts`                                                                                                                                                                                                                                                                                                                   | PASS                        | 2026-09-29    |
| 25  | Panic button: two-step confirm → `freeze()` → mandatory `status()` re-read → `unfreeze()`                                                                              | [`components/PanicPanel.tsx`](../components/PanicPanel.tsx)                                                                                                                                                                                                                                                                                                             | PASS                        | 2026-09-29    |
| 26  | Telemetry feed: cursor-based polling of `event_auth_checked` over an operator-chosen multi-guard tail                                                                  | [`lib/guard/telemetry.ts`](../lib/guard/telemetry.ts), `lib/guard/feedSelection.ts`, `tests/unit/feedSelection.test.ts`                                                                                                                                                                                                                                                 | PASS                        | 2026-10-21    |
| 27  | Installable PWA shell; worker hard-bypasses RPC/Horizon                                                                                                                | [`public/sw.js`](../public/sw.js), [`public/manifest.json`](../public/manifest.json), `lib/guard/pwa.ts`, `tests/unit/pwa.test.ts`                                                                                                                                                                                                                                      | PASS                        | 2026-09-29    |
| 28  | Cross-tab lockstep via `BroadcastChannel` + `localStorage` fallback                                                                                                    | [`lib/guard/tabSync.ts`](../lib/guard/tabSync.ts), `tests/unit/tabSync.test.ts`                                                                                                                                                                                                                                                                                         | PASS                        | 2026-09-29    |
| 29  | (Missing) multi-wallet connectors — Freighter/Albedo/xBull                                                                                                             | [`lib/guard/walletConnector.ts`](../lib/guard/walletConnector.ts), `tests/unit/walletConnector.test.ts`                                                                                                                                                                                                                                                                 | **FIXED** (added to README) | 2026-09-29    |
| 30  | (Missing) opt-in audit/security alerts (audio + notification)                                                                                                          | [`lib/guard/audioAlert.ts`](../lib/guard/audioAlert.ts), [`components/TelemetryAlerts.tsx`](../components/TelemetryAlerts.tsx), `tests/unit/audioAlert.test.ts`                                                                                                                                                                                                         | **FIXED** (added to README) | 2026-09-29    |
| 31  | (Missing) network-switch prompt + observer (wallet-less read-only) mode                                                                                                | `lib/guard/networkSwitch.ts`, `lib/guard/observerMode.ts`, `tests/unit/networkSwitch.test.ts`, `tests/unit/observerMode.test.ts`                                                                                                                                                                                                                                        | **FIXED** (added to README) | 2026-09-29    |
| 32  | (Missing) command palette, theme switcher, transaction history, multisig tracker, fleet view, migration wizard, address book, dashboard grid, print report, XDR export | `components/CommandPalette.tsx`, `components/ThemeProvider.tsx`, `components/TxHistoryTable.tsx`, `components/MultisigTracker.tsx`, [`components/FleetTable.tsx`](../components/FleetTable.tsx), `components/MigrationWizard.tsx`, `components/AddressBookModal.tsx`, `components/DashboardGrid.tsx`, `lib/guard/printReport.ts`, `components/SubmitSignedXDRPanel.tsx` | **FIXED** (added to README) | 2026-09-29    |

## 4. Quick Start, Verification, Screens & Actions

| #   | README claim                                                       | Evidence                                                                                                 | Status                      | Last verified |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------- | ------------- |
| 33  | `npm ci` / `npm run dev` quick start                               | `package.json` `scripts.dev`                                                                             | PASS                        | 2026-09-29    |
| 34  | Demo mode via `NEXT_PUBLIC_DEMO_MODE=true` and `?demo=true`        | `package.json` `scripts.dev:demo`, `lib/guard/useDemoMode.ts`, `tests/unit/demoFixtures.test.ts`         | PASS                        | 2026-09-29    |
| 35  | `npm test # unit tests (31/31 passing)` — the count was stale      | Actual suite: **448 tests / 50 suites, 0 failures** on this branch; the README now states no fixed count | **FIXED**                   | 2026-09-29    |
| 36  | `npm run inspect` read-only state dump                             | [`scripts/inspect-instance.ts`](../scripts/inspect-instance.ts)                                          | PASS                        | 2026-09-29    |
| 37  | `/` Console Overview screen                                        | [`app/page.tsx`](../app/page.tsx)                                                                        | PASS                        | 2026-09-29    |
| 38  | `/configure` Policy Configurator screen                            | [`app/configure/page.tsx`](../app/configure/page.tsx)                                                    | PASS                        | 2026-09-29    |
| 39  | `/fleet` Fleet Overview screen — was omitted from the Screens list | [`app/fleet/page.tsx`](../app/fleet/page.tsx), `components/FleetTable.tsx`                               | **FIXED** (added to README) | 2026-09-29    |
| 40  | `DeployPanel`                                                      | `components/DeployPanel.tsx`                                                                             | PASS                        | 2026-09-29    |
| 41  | `PolicyForm`                                                       | `components/PolicyForm.tsx`                                                                              | PASS                        | 2026-09-29    |
| 42  | `PanicPanel`                                                       | `components/PanicPanel.tsx`                                                                              | PASS                        | 2026-09-29    |
| 43  | `TelemetryFeed`                                                    | `components/TelemetryFeed.tsx`                                                                           | PASS                        | 2026-09-29    |
| 44  | `WalletBar`                                                        | `components/WalletBar.tsx`                                                                               | PASS                        | 2026-09-29    |

## 5. Runbooks, Architecture, and policy sections

| #   | README claim                                                                   | Evidence                                                                    | Status                 | Last verified |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------- | ------------- |
| 45  | Emergency Freeze runbook link                                                  | [`docs/runbooks/emergency-freeze.md`](./runbooks/emergency-freeze.md)       | PASS                   | 2026-09-29    |
| 46  | Routine Policy Updates runbook link                                            | [`docs/runbooks/policy-updates.md`](./runbooks/policy-updates.md)           | PASS                   | 2026-09-29    |
| 47  | Three-repository architecture diagram + repo table                             | `README.md`, [`docs/architecture.md`](./architecture.md)                    | PASS                   | 2026-09-29    |
| 48  | Architecture section links the normative internal spec — was missing           | [`SPEC.md`](../SPEC.md)                                                     | **FIXED** (link added) | 2026-09-29    |
| 49  | Honest limitations (wallet dependency, static deploy, arbitrary-call boundary) | `README.md`; enforcement-scope statement                                    | PASS                   | 2026-09-29    |
| 50  | Enforcement-scope statement matches code + SPEC word for word                  | [`tests/unit/scopeStatement.test.ts`](../tests/unit/scopeStatement.test.ts) | PASS                   | 2026-09-29    |
| 51  | Project structure row claims `lib/guard/` is the tested surface                | `tests/unit/*.test.ts` exercise `lib/guard/*`; see `SPEC.md` §9             | PASS                   | 2026-09-29    |
| 52  | Topics/keyword section — did not exist (issue #51)                             | `README.md` "Topics" section                                                | **FIXED** (added)      | 2026-09-29    |
| 53  | Export scope is stated before a download, and matches the exported rows        | `lib/guard/exportScope.ts`, `tests/unit/exportScope.test.ts`                | **FIXED** (added)      | 2026-10-21    |
| 54  | Poll health is reported apart from event activity                              | `lib/guard/feedHealth.ts`, `tests/unit/feedHealth.test.ts`                  | **FIXED** (added)      | 2026-10-21    |

## 6. Timing, retries, and input validation (issues #389, #386, #384, #394)

| #   | README claim                                                                                                                                                   | Evidence                                                                                                                                                                                                                                                    | Status | Last verified |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| 53  | A dead-man countdown from a read more than a minute old is labelled stale rather than presented as current                                                     | [`lib/guard/ledgerTime.ts`](../lib/guard/ledgerTime.ts) (`resolveReferenceTime`), [`lib/guard/dmsAlert.ts`](../lib/guard/dmsAlert.ts) (`projectDmsAlert`), [`components/StatusPanel.tsx`](../components/StatusPanel.tsx), `tests/unit/dmsStaleRead.test.ts` | PASS   | 2026-10-20    |
| 54  | Each failed read carries its own retry that re-reads only that field, bound to the current guard/network, with late responses after a context change discarded | [`components/GuardProvider.tsx`](../components/GuardProvider.tsx) (`retryRead`), `tests/unit/panelRetry.test.ts`, `tests/unit/retryableRead.test.ts`                                                                                                        | PASS   | 2026-10-20    |
| 55  | Checklist read failures retry read-only, never replaying `initialize` or the policy submission                                                                 | [`components/SetupWizard.tsx`](../components/SetupWizard.tsx), `tests/unit/setupWizard.test.ts`                                                                                                                                                             | PASS   | 2026-10-20    |
| 56  | Address-book nicknames and imported names reject invisible/control characters with a field-level error, preserving international text                          | [`lib/guard/inputSanitizer.ts`](../lib/guard/inputSanitizer.ts) (`validateLabel`), [`lib/guard/addressBook.ts`](../lib/guard/addressBook.ts), `tests/unit/inputSanitizer.test.ts`                                                                           | PASS   | 2026-10-20    |

## Named-entity existence proof

Every component, route, and script name the README mentions must exist at the path it says. This is
the mechanical half of the sweep: a name that does not resolve is a stale claim by definition.

| Entity                                 | Kind      | Resolves to                            | Grep basis                                    |
| -------------------------------------- | --------- | -------------------------------------- | --------------------------------------------- |
| `/`                                    | route     | `app/page.tsx`                         | `app/page.tsx` exists                         |
| `/configure`                           | route     | `app/configure/page.tsx`               | `app/configure/page.tsx` exists               |
| `/fleet`                               | route     | `app/fleet/page.tsx`                   | `app/fleet/page.tsx` exists                   |
| `DeployPanel`                          | component | `components/DeployPanel.tsx`           | file exists                                   |
| `PolicyForm`                           | component | `components/PolicyForm.tsx`            | file exists                                   |
| `PanicPanel`                           | component | `components/PanicPanel.tsx`            | file exists                                   |
| `TelemetryFeed`                        | component | `components/TelemetryFeed.tsx`         | file exists                                   |
| `WalletBar`                            | component | `components/WalletBar.tsx`             | file exists                                   |
| `ScopeNotice`                          | component | `components/bits.tsx`                  | exported and rendered in `app/page.tsx`       |
| `lib/guard/demoFixtures.ts`            | module    | `lib/guard/demoFixtures.ts`            | file exists                                   |
| `npm run prove:phase3`                 | script    | `scripts/prove-phase3.ts`              | `package.json` `scripts["prove:phase3"]`      |
| `npm run prove:phase3:emit`            | script    | `scripts/prove-phase3.ts`              | `package.json` `scripts["prove:phase3:emit"]` |
| `npm run prove:phase3:diff`            | script    | `scripts/compare-proof-run.ts`         | `package.json` `scripts["prove:phase3:diff"]` |
| `npm run inspect`                      | script    | `scripts/inspect-instance.ts`          | `package.json` `scripts.inspect`              |
| `tests/fixtures/phase3-proof.json`     | fixture   | `tests/fixtures/phase3-proof.json`     | file exists                                   |
| `tests/fixtures/phase3-proof.run.json` | fixture   | `tests/fixtures/phase3-proof.run.json` | file exists                                   |
| `tests/fixtures/README.md`             | doc       | `tests/fixtures/README.md`             | file exists                                   |

## Repository metadata (outside-repo checklist — maintainer-applied)

The **About** description and the topic list are GitHub repository settings, not files in this tree,
so they cannot be diffed by CI. They are recorded here so the intended state is visible and
re-appliable, and both are marked **pending maintainer** because only someone with write access to the
upstream repository can change them.

Current upstream state, read back via the API on 2026-09-29:

- **Description:** `Operator interface for Stellar Agent Guard: no-code guardrail configuration, real-time event telemetry, and panic-button freeze. Pure client-side React/Next.js console powered by stellar-agent-guard-sdk.`
- **Topics:** `dashboard`, `nextjs`, `operator-console`, `soroban`, `stellar`, `wallet-security`, `web3`

The topic list in the README's [Topics](../README.md#topics) section adds `typescript`, `ai-agents`
and `guardrails` to the seven already set — every addition maps to a README section, per the
anti-stuffing rule. To apply both (maintainer, run against the upstream repo):

```bash
# About description
gh repo edit Stellar-Agent-Guard/stellar-agent-guard-dashboard \
  --description "Operator interface for Stellar Agent Guard: no-code guardrail configuration, real-time event telemetry, and panic-button freeze. Pure client-side React/Next.js console powered by stellar-agent-guard-sdk."

# Topics (PUT replaces the whole set — include every topic you want to keep)
gh api --method PUT repos/Stellar-Agent-Guard/stellar-agent-guard-dashboard/topics \
  -f 'names[]=stellar' -f 'names[]=soroban' -f 'names[]=dashboard' \
  -f 'names[]=operator-console' -f 'names[]=nextjs' -f 'names[]=typescript' \
  -f 'names[]=wallet-security' -f 'names[]=web3' -f 'names[]=ai-agents' -f 'names[]=guardrails'
```

**Status: pending maintainer** for both rows. This PR cannot apply them; it records the exact commands
so the gap is visible rather than assumed done.

## Evidence-section framing decision

The README's "Verified against live testnet" table quotes a run from the Phase 3 proof. That content
is a **historical record**, not a claim that those hashes are re-verified on every build, and the
README now says so in the section lead-in. The framing follows the evidence-freshness discipline: a
recorded run is frozen evidence, while the enforcement-scope statement it embeds is the live,
drift-guarded claim. Both are honest; conflating them is not.
