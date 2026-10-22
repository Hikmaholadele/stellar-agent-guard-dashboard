# Security Policy

The Stellar Agent Guard dashboard is a client-side operator console. It does
not run a backend and does not store wallet secret keys. Transactions and
authorization entries are signed by the operator's connected wallet provider.
The dashboard is unaudited security tooling; do not treat this statement as an
independent security audit.

## Scope

| Area                                                                                                                          | In scope here? | Where to report                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dashboard client vulnerabilities, including unsafe rendering, client-side validation, and tampering with browser-stored state | Yes            | This repository's private vulnerability reporting or the email fallback below                                       |
| Vulnerabilities in the SDK consumed by this dashboard                                                                         | No             | [SDK SECURITY.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/blob/main/SECURITY.md)             |
| Contract, protocol, or on-chain policy-enforcement issues                                                                     | No             | [Contracts SECURITY.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md) |
| A hosted dashboard's deployment or configuration                                                                              | No             | The operator responsible for that deployment                                                                        |
| Issues in Freighter or another wallet provider                                                                                | No             | The affected wallet provider                                                                                        |

The dashboard does not hold private keys: its browser wallet adapter delegates
transaction and authorization-entry signing to the connected wallet provider.
Contract and SDK security boundaries remain owned by their respective
repositories, not by this dashboard.

## Client-side security notes

The dashboard renders ordinary React content, which React escapes by default.
The source scan of `app/` and `lib/` found one `dangerouslySetInnerHTML` use:
the static initial-theme script in `app/layout.tsx`. It contains no interpolated
user data and reads the theme preference only to set the root `data-theme`
attribute. The same scan found no `innerHTML`, `eval(`, or `new Function`
matches in those application source directories. This is a source-grounded
scope note, not a claim that the application has no vulnerabilities.

Browser storage is local to the origin and is not an authorization boundary.
Same-origin script execution can read or alter it. The current storage inventory
is maintained in [`STORAGE_INVENTORY`](./lib/guard/storageInventory.ts):

| Storage area     | Keys / key patterns                                                                                                                                                                           | Stored data                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `localStorage`   | `stellar-agent-guard-dashboard.instances.v2.{network}`, `stellar-agent-guard-dashboard.instances.v1`                                                                                          | Current and legacy saved public guard addresses and labels             |
| `localStorage`   | `stellar-agent-guard-dashboard.addressBook.v1`                                                                                                                                                | Contact labels and public Stellar addresses                            |
| `localStorage`   | `stellar-agent-guard-dashboard.txHistory.v1`                                                                                                                                                  | Browser-recorded transaction hashes, operations, outcomes, and fees    |
| `localStorage`   | `stellar-agent-guard-dashboard.layout.v1`, `stellar-agent-guard-dashboard.namedLayouts.v1`, `stellar-agent-guard-dashboard.fleet-view.v1`                                                     | Dashboard layout and fleet-view preferences                            |
| `localStorage`   | `stellar-agent-guard-dashboard.idleTimeout.v1`, `stellar-agent-guard-dashboard.alerts.v1`, `stellar-agent-guard-dashboard.walletProvider.v1`, `stellar-agent-guard-dashboard.setup-wizard.v1` | Idle timeout, alert, preferred-wallet, and setup-checklist preferences |
| `localStorage`   | `stellar-agent-guard-dashboard.scoped.v1.{base}.{network}.{guard}` where `base` is `feedFilter` or `policyDraft`                                                                              | Per-guard feed filters and policy drafts                               |
| `localStorage`   | `stellar-agent-guard-dashboard.webhooks.v1`                                                                                                                                                   | User-configured webhook destinations and event preferences             |
| `localStorage`   | `stellar-agent-guard-dashboard.tab-sync.v1`                                                                                                                                                   | Short-lived cross-tab event transport                                  |
| `localStorage`   | `theme`, `sidebar-collapsed`, `display-density`, `privacy-mask`                                                                                                                               | Presentation preferences                                               |
| `sessionStorage` | `stellar_bytecode_hash_cache`                                                                                                                                                                 | Session-only bytecode hash cache                                       |

Webhook destinations are stored as user-entered browser data. The configured
Soroban RPC endpoint is not a local-storage key; it is supplied through the
dashboard's build configuration. None of these browser values should be treated
as trusted authorization state or as a substitute for on-chain enforcement.

## Reporting a Vulnerability

Please do not report vulnerabilities in public issues or discussions.

1. **Primary: GitHub private vulnerability reporting.** Use the **Report a
   vulnerability** button under this repository's Security tab, or open a
   private advisory at
   <https://github.com/Stellar-Agent-Guard/stellar-agent-guard-dashboard/security/advisories/new>.
   The maintainer must enable private vulnerability reporting in repository
   Settings → Security; this is an outside-repository action and is not claimed
   to be complete by this file.
2. **Email fallback:** if private reporting is unavailable, contact
   `aigbagbobila@users.noreply.github.com`, following the
   [contracts repository's security policy](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md).
   If a report is sensitive, ask for a PGP key before sending details.
3. **Telegram:** use the
   [community channel](https://t.me/+EzSusj-2vVhhNmI0) for non-sensitive
   questions only. It is not a private disclosure channel; do not post
   vulnerability details there.

Please include the affected version or commit, a concise description and
impact, whether funds are at risk, and the smallest reliable reproduction.
Provide a suggested fix only if you have one; write “unknown” rather than
guessing.

## Response Expectations

This mirrors the sibling
[SDK security policy](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/blob/main/SECURITY.md),
whose reporting channels and response expectations follow the contracts policy
as checked on 2026-10-22:

- Acknowledgement within 48 hours of the report reaching a private channel.
- An assessment and remediation plan, or a status update, within 7 days.
- Please do not disclose publicly until a fix is released or 90 days have
  passed, whichever comes first; coordinate earlier publication with the
  maintainers.
- Named advisory credit is available on request. There is no bug bounty at
  this time.

The
[contracts SECURITY.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md)
is authoritative if its policy changes.

## Maintainer Checklist (outside-repository action)

- [ ] Enable GitHub private vulnerability reporting in this repository's
      Settings → Security.

## Related Policies

- [SDK security policy](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/blob/main/SECURITY.md)
  covers vulnerabilities in the SDK; its addition was tracked by
  [SDK issue #123](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/123)
  and [SDK PR #223](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/pull/223).
- [Contracts security policy](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md)
  covers contract and protocol disclosures and remains authoritative for those
  reports.
