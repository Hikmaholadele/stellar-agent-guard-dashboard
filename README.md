<p align="center">
<img src="Gemini_Generated_Image_mvimg2mvimg2mvim.jpeg" alt="Stellar Agent Guard" width="700"/>
</p>
<p align="center">
<a href="https://github.com/aigbagbobila/stellar-agent-guard-dashboard/actions/workflows/ci.yml">
<img src="https://github.com/aigbagbobila/stellar-agent-guard-dashboard/actions/workflows/ci.yml/badge.svg" alt="CI"/>
</a>
<a href="LICENSE">
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"/>
</a>
<a href="https://nextjs.org/">
<img src="https://img.shields.io/badge/next.js-16-black" alt="Next.js 16"/>
</a>
<a href="https://nodejs.org/">
<img src="https://img.shields.io/badge/node-24%2B-blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) -->
</p>

# Stellar Agent Guard — Dashboard

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Client-side operator console for Stellar Agent Guard: deploy smart accounts, configure spending guardrails, monitor live telemetry, and trigger emergency freezes.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and _every_ transaction the account must authorize is intercepted by the contract's `__check_auth` and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This dashboard provides the operator's command console: a pure client-side Next.js interface for Freighter wallets to inspect guard status, deploy and configure account-level spending policies via a no-code form, view live event telemetry, and execute immediate panic-button freezes confirmed directly from the contract.

**Status: Phase 3 built, with Phase 2 publish status honestly disclosed.** Pure consumer of [stellar-agent-guard-sdk](https://github.com/aigbagbobila/stellar-agent-guard-sdk) and Soroban RPC. Holds no secrets and has no server component: every write is signed by the operator's own wallet and broadcast directly to Soroban RPC. Consumes the SDK from a committed vendored tarball (`vendor/stellar-agent-guard-sdk-0.1.1.tgz`, built from the SDK's `main`) so CI and offline builds resolve the exact, reviewable bytes; version 0.1.0 of the package is also published to npm, while the vendored 0.1.1 is not yet published (see the Phase 2 table below).

> **SDK sequence note (2026-09-30).** The vendored tarball moved `0.1.0 → 0.1.1`, built from SDK `main` commit `391546173c40b6c772872fc84c3c84ce42c3147f` (`npm ci && npm run build && npm pack` in the SDK repo). That release is what carries `decodePolicy` / `readPersistentEntry`, which this console's read side now calls; `0.1.1` is not yet published to npm, so the committed tarball — not the registry — is the source of truth for the bytes this build decodes.

> ### Phase 2 Exit Status & Dependency Disclosure
>
> | Phase 2 exit criterion                 | State                                                                                                                                           |
> | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
> | SDK published to npm                   | **met for 0.1.0** — `npm view stellar-agent-guard-sdk` returns version 0.1.0; the vendored 0.1.1 (sequence note above) is ahead of the registry |
> | CI green on `main`                     | **met** — merged and CI green on `main` (GitHub Actions run `35063436332` passed)                                                               |
> | Real integration tests against testnet | **met** — `tests/fixtures/integration-evidence.md` in SDK repo, 5/5 live                                                                        |
> | Phase 2 merged                         | **met** — PR #2 merged into `main` (commit `897708a`)                                                                                           |
>
> **What this means in practice:** The SDK publish criterion is satisfied. This console now vendors 0.1.1, built from the SDK's `main` ahead of its registry publish, so the vendored tarball — not npm — is the source of truth for what this build decodes. Everything claimed about Phase 1 and Phase 3 — the artifact deployed, the policy installed, the freeze confirmed — is proven against real public testnet deployments.
>
> ```bash
> $ npm view stellar-agent-guard-sdk
>
> stellar-agent-guard-sdk@0.1.0 | MIT | deps: 1 | versions: 1
> Integration bridge between AI agent frameworks and stellar-agent-guard smart accounts: pre-flight policy interception, agent-auth transaction signing, cost pre-checks, and on-chain event telemetry. Full recipient/amount enforcement — spend caps, allowlist
> ```

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Zero-backend client security**: The dashboard contains no backend server, no database, and no API routes handling private keys. Every transaction is constructed in the operator's browser, signed via their own Freighter wallet, and broadcast directly to Soroban RPC.
- **On-chain bytecode verification**: When deploying a new guard account, the dashboard fetches the contract bytecode directly off the testnet ledger, verifies its SHA-256 hash against the pinned Phase 1 artifact (`f47919...`), predicts the contract address pre-signing, and re-reads the deployed contract to confirm execution integrity.
- **Explicit dual-freeze semantics**: The console clearly distinguishes between an **admin freeze** (operator panic button, `admin_frozen = true`) and a **dead-man-switch freeze** (agent missed heartbeat grace window, derived from `last_heartbeat`), avoiding operator confusion during emergency triage.
- **No mock state**: Every policy field, balance, and status indicator is read live from Soroban RPC with discrete per-read error reporting. A failed RPC call renders an explicit error — never a silent zero that looks like an empty policy.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **No-code guardrail configurator (`/configure`)**: Interactive form for defining spending policies without writing code: per-transaction cap, rolling-window cap and length, asset allowlists, recipient allowlists, protocol allowlists, active execution windows, pause state, and dead-man switch grace periods. Validates inputs locally before prompting Freighter, encodes via SDK `policyToScVal`, and executes `set_policy`.
- **Artifact-verified guard deployment**: Deploys fresh guard accounts from verified on-chain WASM bytecode with cryptographic address prediction.
- **Deployment verification receipt**: After a deploy, the panel produces a downloadable, client-generated JSON record — capture time, network, predicted and deployed addresses, pinned artifact hash and length, transaction references, and explicit per-check outcomes. It is not a signed credential: the format has no field for a secret key, a signed envelope or wallet session details, and it reports `verified` only when the post-deploy live read matched the pinned bytecode. A refused deploy and a failed or skipped read are recorded as `failed`/`unavailable`, never as success.
- **Emergency panic button (`PanicPanel`)**: Two-step confirmation modal with wallet-signed `freeze()` execution, followed by a mandatory on-chain re-read of `status()` confirming `admin_frozen = true` before updating UI state. Provides matching wallet-signed `unfreeze()` reversal.
- **Live event telemetry feed (`TelemetryFeed`)**: Cursor-based polling of `event_auth_checked` topics from Soroban RPC, decoding contract outcomes and reason codes using the SDK's verified vocabulary. It tails **several guards at once** — one merged feed with a per-row guard-attribution chip and a guard-chip filter — capped at **5** simultaneous guards, and which guards occupy those slots is the operator's choice rather than the first five rows of the registry (see the poll-load clause below). Poll liveness is reported apart from event activity: a quiet guard that is still answering polls reads as healthy, not as failing, and a guard that answers with rows but whose polls have stopped answering reads as overdue.
- **Multi-guard tail with a documented poll budget**: Tailing N guards is N `getEvents` poll loops, because the SDK's telemetry listener is single-guard. The feed therefore watches at most **5** guards at a time, taking the actively-selected guard first and then the operator's tail choices in the order they were chosen, and names any registry entry beyond that cap as _not tailed_ rather than silently multiplying RPC load. **Live multi-tail poll load scales with the number of guards watched**; the cap keeps that bounded. The tail selection is remembered per network in browser storage and is only ever an _input_ to which guards are polled — chain state stays the source of truth for what those guards did, and a stored selection that no longer resolves is dropped rather than trusted. Operators tune the underlying request cost with the SDK's page-size and jitter knobs (see the SDK repo) rather than by adding more guards here.
- **Export scope stated before the download**: The feed's CSV, JSON, NDJSON and audit-log exports are produced from the rows on screen, and the panel prints that scope ahead of the click — the time range, how many of the events in view fall inside it, whether any diagnostic (refused-call) rows are included, the exported fields, and an explicit statement that the decoded event payload is not exported so no wallet material can leak into a downloaded file. Downloads are disabled when the scope is empty, so a previewed file and a delivered file are the same set of rows.
- **Guided post-deploy checklist (`SetupWizard`)**: A four-step tracker — deployed → initialized → policy installed → verified — persisted per guard, with each step actionable inline and a clear dismiss affordance. Every step's state is _derived from a live chain read_, not from a stored completion flag: a step cannot stay green after the chain says otherwise, and dismissing the wizard never conceals the default-deny warning that `StatusPanel` renders from `status()`.
- **Installable PWA shell**: A `manifest.json`, responsive vector icons and a static-shell-only service worker let the console be installed and opened instantly on a phone or after a local network drop. Every `/soroban/rpc` and Horizon request is hard-bypassed — the worker never reads or writes a cache for chain state, so an offline shell can never present a cached balance or freeze flag as if it were live. A new shell is never activated under the operator: it waits, a non-blocking notice offers an explicit reload, and the update is held back while a policy or deployment draft is dirty or a wallet write is in flight.
- **Cross-tab lockstep**: A `BroadcastChannel` coordinator (with a `localStorage` fallback) propagates guard switches, confirmed freezes and policy installs across every open tab. Receiving tabs re-read the chain rather than trusting the broadcast, and never overwrite a form edit in progress.
- **Multi-wallet connectors**: One `WalletConnector` interface over Freighter, Albedo and xBull, with a detection modal that names what the browser found and links to install what it did not. The operator's choice persists so a returning session is not asked again.
- **Observer mode**: With no wallet connected, reads still run by attributing the read-only simulation to a fallback source account. The header says the session is observing, and every write control explains why it is disabled instead of going silently inert.
- **Wallet/network guard**: A detected network mismatch renders as an inline warning bar with a one-click switch request, and a declined request is reported as declined — never as a false breakdown.
- **Opt-in security alerts**: An optional two-beep Web Audio chime and a browser notification when the guard blocks a call, an admin freeze lands, or a policy is revoked. Both channels default off.
- **Operator accelerators**: A `Cmd`/`Ctrl`+`K` command palette, dark/light/high-contrast themes, an address book, a drag-to-reorder dashboard grid, and an unsigned-XDR export/import path for multisig or air-gapped signing.
- **Fleet overview (`/fleet`)**: One table of every registered guard instance with its live on-chain state, so an operator running more than one agent does not have to open them one at a time.
- **Printable compliance report**: A `@media print` stylesheet and a "Print compliance report" action render a clean, paginated summary of the contract id, pinned bytecode hash, active policy and freeze state for auditors.

## Quick Start

### Installation

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-dashboard.git
cd stellar-agent-guard-dashboard
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in a browser with the [Freighter wallet](https://www.freighter.app/) extension installed and switched to **Testnet**.

### Instant demo mode (no wallet, no testnet, no contracts)

To evaluate the interface without a Freighter wallet or a funded testnet account, start the dashboard with pre-populated fixture data:

```bash
npm run dev:demo      # runs next dev with NEXT_PUBLIC_DEMO_MODE=true
```

Then open [http://localhost:3000](http://localhost:3000). You can also opt in per visit, with no script and no rebuild, by adding `?demo=true` to any URL (for example [http://localhost:3000/?demo=true](http://localhost:3000/?demo=true)) against a normal `npm run dev`.

While demo mode is active:

- A top-level badge reads **DEMO MODE — Static Fixture Data**.
- The on-chain state panel shows a realistic, healthy guard: an installed policy, an open active execution window, and a rolling spend window that is under its cap.
- The telemetry feed is seeded and watching immediately, with a synthetic stream of allowed transfers, heartbeats, and blocked (diagnostic) decisions.
- Every value comes from [`lib/guard/demoFixtures.ts`](./lib/guard/demoFixtures.ts) and **no RPC call is made** — it works offline.
- Write actions are disabled with an explanatory error, because there is nothing real to write to.

Demo mode is strictly opt-in. When neither the environment flag nor the query parameter is set, none of the fixture code is reached and the console keeps its **no mock state** guarantee: every number is read live from Soroban RPC, and a failed read is rendered as a failure, never as a zero.

### Copy and confirmation micro-UX

Operator-facing identifiers (guard addresses, transaction hashes, deploy result IDs) render with one-click copy buttons (`components/CopyButton.tsx`) that write the **full** value, swap to `Copied ✓` for two seconds, announce the outcome through the shared announcer, and — when the async Clipboard API is unavailable (insecure-context dev over plain http, or denied permission) — show an inline "select manually" hint instead of failing silently.

### Verification and Development

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # full unit suite (see CI for the current count)
npm run build        # Next.js production build
npm run inspect      # read-only dump of an instance's state
```

### Offline development against a local network

`npm run sandbox` boots a local standalone Soroban network in Docker, deploys the _same_
pinned guard artifact to it, and writes `.env.local` so the console talks to that node
instead of public testnet — no dependency on public RPC nodes, and no wallet needed for
reads or telemetry. See [Local sandbox](CONTRIBUTING.md#local-sandbox) for the startup
steps and for what it does and does not prove.

## Screens & Actions Reference

### Screens

- **`/` (Console Overview)**: Displays connected wallet, active guard address, current balance, policy parameters summary, dead-man switch countdown, live telemetry event stream, and the emergency panic button. Raises a warning-tier banner whenever the guard reports no policy installed — the default-deny state, where every transaction is blocked until one is configured — with a call to action that carries the current guard into the configurator. An unread `status()` is reported as an error, never as "no policy". Each failed read carries its own retry that re-reads only that field — bound to the current guard and network, with late responses after a context change discarded — and a dead-man countdown drawn from a read more than a minute old is labelled stale rather than presented as current.
- **`/` (Console Overview)**: Displays connected wallet, active guard address, current balance, policy parameters summary, dead-man switch countdown, live telemetry event stream, transaction history, multisig approvals, an unsigned-XDR submit panel, and the emergency panic button.
- **`/configure` (Policy Configurator & Deployment)**:
  - Keep the configured network name and RPC hostname visible beside the page title; switching controls remain in the wallet bar.
  - Deploy fresh guard accounts from verified on-chain WASM bytecode.
  - Follow the **post-deploy checklist** (`SetupWizard`): deploy → initialize → install policy → verify, each step derived from a live read, dismissible, and reopenable, with a read-only retry whenever a read fails.
  - Configure spending policy parameters with real-time validation.
  - Sign and submit `set_policy` transactions.
  - Show the same default-deny banner while nothing is installed, and disable the revoke action — the state it would produce is already in force.

### Key Components & Actions

- **`DeployPanel`**: Fetches bytecode, verifies SHA-256 hash (`f47919...`), predicts custom account address, prompts Freighter signature, and initializes admin + agent keys.
- **`PolicyForm`**: Real-time form validation, encoding via SDK `policyToScVal`, Freighter signing, and transaction broadcast. Deep links (`/configure?guard=C…`) adopt the guard named in the URL, so navigating from the console's default-deny banner does not silently show a different account's state.
- **`/fleet` (Fleet Overview)**: One table of every registered guard instance with its live on-chain state, for operators running more than one guarded agent.

### Key Components & Actions

- **`DeployPanel`**: Fetches bytecode, verifies SHA-256 hash (`f47919...`), predicts custom account address, prompts the wallet signature, and initializes admin + agent keys.
- **`PolicyForm`**: Real-time form validation, encoding via SDK `policyToScVal`, wallet signing, and transaction broadcast.
- **`PanicPanel`**: Emergency freeze workflow:
  - Prompts explicit operator confirmation modal.
  - Submits wallet-signed `freeze()` transaction.
  - Re-reads contract `status()` to verify `admin_frozen = true`.
  - Provides wallet-signed `unfreeze()` to restore normal operations.
- **`TelemetryFeed`**: Cursor-based polling of `event_auth_checked` topics from Soroban RPC for up to `FEED_GUARD_CAP` (5) guards simultaneously, decoding contract outcomes and reason codes. Each row carries a severity tier — blocked rows are marked from the danger token, diagnostic-stream rows from the warn token, and the committed-vs-diagnostic stream is labelled on every row — so blocks are findable by looking rather than by reading, with the tier always also stated in words. No sound: operator consoles run unattended and muted. Each row also carries its source guard's registry label, and a guard-chip filter narrows the merged feed. Which guards fill the `FEED_GUARD_CAP` slots is chosen here: the panel offers every registry guard, pins the actively-selected guard, and labels the registry entries left outside the cap as _not tailed_ instead of dropping them silently. A separate line reports poll health — pending, healthy, overdue, or failing with the last error — from the poll attempts themselves, so an error that ends a poll round never rewrites the event rows already on screen and an empty-but-answering round is not shown as a breakdown.
- **`SetupWizard`**: The post-deploy checklist. Steps derive from `isInitialized()`, `status()` and `policy()`; only the operator's own live re-read can turn the verify step green (mirroring `PanicPanel`'s mandatory on-chain re-read). The only persisted state is the dismiss flag and the deploy marker.
- **`WalletBar`**: Displays Freighter connection status, address, and network validation.
- **`TelemetryFeed`**: Cursor-based polling of `event_auth_checked` topics from Soroban RPC, decoding contract outcomes and reason codes.
- **`WalletBar`**: Wallet connection status, address, network validation, the Freighter / Albedo / xBull connector picker, and the multi-guard switcher (saved per network, add-by-address verified with a live `status()` read, rename, and confirm-gated delete).
- **`FleetTable`**: Live per-instance status across every registered guard account.
- **`TxHistoryTable`** / **`MultisigTracker`**: The locally recorded submission history and pending multisig approvals.
- **`SubmitSignedXDRPanel`**: Imports and broadcasts an externally signed transaction envelope for multisig or air-gapped signing.
- **`CommandPalette`** (`Cmd`/`Ctrl`+`K`): Keyboard-navigable navigation, guard-instance search, and quick actions.
- **`ThemeToggle`**: Dark / light / high-contrast themes, following the OS preference until the operator chooses.
- **`AddressBookModal`** / **`MigrationWizard`**: Saved recipients — nicknames and imported names are screened against a documented label policy that rejects invisible and control characters with a field-level error while preserving international text — and a guided policy-migration flow.
- **`DashboardGrid`**: Operator-arranged, persisted panel layout.
- **`TelemetryAlerts`**: Opt-in audio and browser-notification alerts for blocked calls and freezes.

## Operator Runbooks

Three step-by-step procedures cover the console's high-stakes operations. They are written to be followed under pressure, and each includes CLI fallback commands for when the browser UI is unavailable.

| Runbook                                                                                  | Use it when                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Emergency Freeze & Security Incident Response**](./docs/runbooks/emergency-freeze.md) | An agent is behaving abnormally or a key may be compromised. Covers incident classification and response timelines, the two-step `PanicPanel` confirmation ritual, verifying frozen status on chain (dashboard reader and Stellar CLI), preserving evidence, agent/admin key rotation, root-cause analysis and the unfreeze checklist.                                                |
| [**Routine Policy Updates & Audit**](./docs/runbooks/policy-updates.md)                  | Changing caps, allowlists, execution windows, pause state or the dead-man switch. Covers capturing a rollback baseline, staging and validating a draft in `PolicyForm`, the `set_policy` rolling-window and dead-man-switch resets, the pre-flight security checklist (including verifying token contract IDs on Stellar Expert), post-submission verification and rollback/recovery. |

## Developer Guides

| Guide                                                                           | Description                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Agent Integration Guide**](./docs/guides/agent-integration.md)               | Connecting custom AI agent runtimes (TypeScript, Python, LangChain, ElizaOS) to a deployed Guard, configuring environment variables, sending heartbeats, and diagnosing telemetry in the dashboard.                                                                                                                                               |
| [**Air-Gapped Multisig Signing**](./docs/guides/air-gapped-multisig-signing.md) | The full round trip for offline multisig approvals: verifying the network, exporting an unsigned envelope, collecting partial signatures, checking remaining signer weight, reviewing and submitting, plus recovery for stale sequences, expired envelopes and rejected transactions.                                                             |
| [**Glossary**](./docs/glossary.md)                                              | Precise technical definitions of every Stellar, Soroban and Stellar Agent Guard term used across this project — Soroban Auth Context, SAC, Stroop, Rolling Window, DMS, Diagnostic Event, Pre-flight Simulation, Pinned Bytecode, Footprint and more — with an alphabetical index, cross-references, and links to official Stellar documentation. |

## Architecture

Stellar Agent Guard operates across three dedicated repositories:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Operator (Browser / Freighter)                     │
│                                     │                                   │
│                                     ▼                                   │
│              stellar-agent-guard-dashboard (Next.js / UI)               │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   AI Agent Runtime (LangChain / ElizaOS)                │
│                                     │                                   │
│                                     ▼                                   │
│                stellar-agent-guard-sdk (TypeScript / RPC)               │
│               • Pre-flight policy check  • Cost pre-checks              │
│               • Agent-auth tx signing    • Event telemetry              │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼ Soroban RPC
┌─────────────────────────────────────────────────────────────────────────┐
│               stellar-agent-guard-contracts (Soroban / Rust)             │
│            • CustomAccount interface (`__check_auth`)                   │
│            • Spend caps, rolling window, allowlists, dead-man switch    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Repository                                                                                                     | Role                                                                                                | Documentation                                                                            |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [**stellar-agent-guard-contracts**](https://github.com/aigbagbobila/stellar-agent-guard-contracts)             | Soroban smart contracts implementing Custom Account Abstraction and spending policy firewall        | [GitBook Docs](https://soroban-cost-estimator.gitbook.io/stellar-agent-guard-contracts/) |
| [**stellar-agent-guard-sdk**](https://github.com/aigbagbobila/stellar-agent-guard-sdk)                         | TypeScript SDK for pre-flight interception, simulation pricing, and AI agent framework integration  | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-sdk)                        |
| [**stellar-agent-guard-dashboard**](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) (this repo) | Client-side operator dashboard for policy deployment, inspection, and emergency panic-button freeze | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-dashboard)                  |

The dashboard's own internal contract — data flow, the derived-vs-stored state model, the complete write surface and the trust model — is normative in [`SPEC.md`](./SPEC.md).

## ✅ Verified against live testnet

The dashboard core logic (`lib/guard/*`) was proven against live Stellar testnet via `scripts/prove-phase3.ts` using the identical module pipeline that powers the UI. The table below is a **dated record** of that run (its exact timestamp is `ranAt` in [`tests/fixtures/phase3-proof.json`](./tests/fixtures/phase3-proof.json)), not a claim re-verified on every build:

| Step                         | Result                                                                 | Evidence                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Pinned bytecode verification | Hash matches `f47919...` (39673 bytes)                                 | Off-chain ledger byte check                                                                                                   |
| Custom account deploy        | Deployed to `CC6VDBH5M473O4XUPD5GNRVIPB6CJ4U6IZCITF7XLKNLMWZPP3U5BMTK` | Tx [`bcd8eac5…`](https://stellar.expert/explorer/testnet/tx/bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa24006579) |
| `initialize(admin, agent)`   | Registered keys on custom account                                      | Tx [`bf597dc9…`](https://stellar.expert/explorer/testnet/tx/bf597dc9888a4ac8199922a1ed6d7099eeb4267d51b2e312f6bbc225a02e7132) |
| `set_policy` via form path   | Installed initial policy rules                                         | Tx [`8d45d22f…`](https://stellar.expert/explorer/testnet/tx/8d45d22f3791f7d22722412589b31388e231a01944d7ed361342123a6b087dd9) |
| Unfrozen transfer            | **Allowed**                                                            | Tx [`fe1f5e48…`](https://stellar.expert/explorer/testnet/tx/fe1f5e48960bfe154100e2b671ac81415deeb5e9266794ab1be555076d88f675) |
| **Panic button: `freeze()`** | **Frozen**                                                             | Tx [`0d57cd1c…`](https://stellar.expert/explorer/testnet/tx/0d57cd1cd8d2988a11a429e479abdba26bc415072a451b663fdfa5038823d3ff) |
| Status re-read               | `admin_frozen = true`                                                  | Contract read confirmation                                                                                                    |
| Frozen transfer attempt      | **Blocked with reason `admin_frozen`**                                 | Pre-broadcast refusal, 0 fees                                                                                                 |
| **Reversal: `unfreeze()`**   | **Unfrozen**                                                           | Tx [`33929a97…`](https://stellar.expert/explorer/testnet/tx/33929a97c19b8095c46ad71e674b6f47570b17c49e0af237b9dfda7b14979228) |
| Status re-read               | `admin_frozen = false`                                                 | Contract read confirmation                                                                                                    |
| Retried transfer             | **Allowed**                                                            | Tx [`503f649e…`](https://stellar.expert/explorer/testnet/tx/503f649eb91cb2e755297fa326f91e7e90921924471324cbbde25514660f2c18) |

Full proof artifact recorded in [`tests/fixtures/phase3-proof.json`](./tests/fixtures/phase3-proof.json) and [`tests/fixtures/README.md`](./tests/fixtures/README.md).

## Honest limitations

- **Freighter wallet dependency**: Operator write actions require an active Freighter browser extension connected to Stellar Testnet; no programmatic secret keys are held or supported.
- **Client-side static deployment**: Designed as a pure client-side application (compatible with Vercel or any static host); does not maintain a persistent server database.
- **Enforcement boundary for arbitrary calls**: Full amount/recipient limits apply natively to SAC token transfers. Arbitrary Soroban contract calls are gated by protocol/function allowlists, active execution window, pause, and dead-man switches; fine-grained amount controls for non-SAC calls are tracked as v2.

## Enforcement scope — read this before relying on the caps

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

This boundary is an inherent property of the platform (the auth context does not expose arbitrary call arguments generically), not a gap this project hides or overclaims. The classification that produces this boundary (`AssetTransfer` vs `Protocol` vs `Unknown` default-deny) is spelled out in SPEC §6.

## Topics

The canonical GitHub topics for this repository, each mapped to the README section that evidences it. A topic is listed only if the capability behind it is demonstrated above, so the list cannot drift into keyword stuffing.

| Topic              | README evidence                                             |
| ------------------ | ----------------------------------------------------------- |
| `stellar`          | Intro and Architecture — Stellar testnet, SAC transfers     |
| `soroban`          | Architecture — Soroban RPC, Custom Account `__check_auth`   |
| `dashboard`        | Title and "What it does"                                    |
| `operator-console` | Intro ("the operator's command console"), Screens & Actions |
| `nextjs`           | Badges, Architecture (Next.js 16)                           |
| `typescript`       | Architecture repo table — `lib/guard/*` is TypeScript       |
| `wallet-security`  | "What makes this different" — non-custodial, no key custody |
| `web3`             | Architecture; "Verified against live testnet"               |
| `ai-agents`        | Intro — guarding an autonomous agent's wallet               |
| `guardrails`       | "What it does" — spend caps, allowlists, dead-man switch    |

The **About** description and the topic list are repository settings, not files in this tree; the exact `gh` commands that apply them are recorded in [`docs/readme-claims.md`](./docs/readme-claims.md) and in this change's pull request.

## Maintainers

| Name   | GitHub                                           | Telegram                                        |
| ------ | ------------------------------------------------ | ----------------------------------------------- |
| Hybrid | [@aigbagbobila](https://github.com/aigbagbobila) | [@aigbagbobila](https://t.me/+EzSusj-2vVhhNmI0) |

## Socials

- [Telegram](https://t.me/+EzSusj-2vVhhNmI0)
- [Discord](https://discord.gg/Z766vsgjg)

## Contact

- GitHub issues: <https://github.com/aigbagbobila/stellar-agent-guard-dashboard/issues>
- Maintainer (GitHub): [@aigbagbobila](https://github.com/aigbagbobila)
- Dashboard security disclosures: see this repository's [SECURITY.md](SECURITY.md).
- Contract and protocol security disclosures: see the [contracts SECURITY.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## License

Licensed under [MIT](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on coding standards, PR process, and
project structure — including the strict one-commit-per-logical-unit rule.

Looking for something to work on? The
[issue backlog](https://github.com/aigbagbobila/stellar-agent-guard-dashboard/issues)
holds scoped issues with Summary / Acceptance Criteria / Tech Stack — good first tasks for
the Drips Stellar Wave contributor sprints.

![Contributors](https://contrib.rocks/image?repo=aigbagbobila/stellar-agent-guard-dashboard)
