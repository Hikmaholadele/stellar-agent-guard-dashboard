# Frequently Asked Questions (FAQ)

### Can the dashboard execute transfers on behalf of the agent?

No. The dashboard is strictly an operator console for installing security policies, monitoring events, and triggering freezes. The agent's transactions are generated and signed by the autonomous agent runtime using the SDK.

### What happens if I close the browser during a freeze?

The freeze transaction is signed and broadcast on-chain. Once included in a ledger by the Stellar testnet validators, the smart account remains frozen regardless of whether the dashboard is open.

### How do I switch networks?

The current deployment targets Stellar Testnet. Network settings can be inspected in `lib/guard/network.ts`.

---

### What should I do when I see these errors?

The dashboard maps common wallet, RPC, and simulation failures to **safe next steps** — what is known, what remains uncertain, and which read-only check to perform next. Avoid advising blind retries for writes or claiming a failed read means zero policy state.

| Failure Type                 | Known                                                                                        | Uncertain                                                                                          | Read-only Check                                                                                                                                            | Safe Next Step                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPC TIMEOUT**              | Read was attempted but no response from RPC endpoint within the deadline.                    | Whether the transaction was actually submitted or the RPC simply dropped the request.              | Check the transaction hash in the RPC logs or via `stellar-agent-guard-sdk` status read. If no hash appears, assume the transaction was not broadcast.     | Do not blindly retry. Instead, check the on-chain status via a block explorer or the SDK's `status()` read. If no transaction appears, the read may have been incomplete — file a report with the diagnostics. |
| **429 RATE LIMIT**           | RPC responded HTTP 429 with a `retry-after` hint.                                            | Whether the hint applies to this read or is a global throttle.                                     | Verify the `retry-after` header value and confirm no other concurrent reads are contending the same endpoint.                                              | Use the `retry-after` delay if present; otherwise apply exponential backoff. Do not exceed the provider's suggested quiet period.                                                                              |
| **TRY_AGAIN_LATER**          | RPC returned a retryable error code.                                                         | Whether the underlying condition is transient (network blip) or permanent (quota exceeded).        | Check the error detail for hints about quota, congestion, or agent key state.                                                                              | Apply backoff and retry once. If repeated, assess if the condition is persistent or requires operator action.                                                                                                  |
| **WALLET SIGNING FAILURE**   | The wallet could not produce a signature (user rejected, unavailable key, or device error).  | Whether the transaction was ever broadcast or was stuck in the wallet's outbox.                    | Inspect the wallet's outbox/session log for any pending signed but-unbroadcast transactions. Confirm with the operator whether the signing flow completed. | Do not retry the same signing flow without addressing the root cause (e.g., user permission, key availability). File a report if the transaction status is ambiguous.                                          |
| **SIMULATION FAILURE**       | The transaction simulation (e.g., `check`, `estimate`) returned an error.                    | Whether the transaction would succeed on-chain or the error is permanent (e.g., policy violation). | Read the simulation's diagnostic detail; check `has_policy` and `admin_frozen` status on-chain.                                                            | Do not broadcast the transaction if the simulation fails with a policy violation. Retry only if the error is transient and you have confirmed the policy state.                                                |
| **POST-SUBMIT VERIFICATION** | The transaction was submitted but the post-deploy read failed or returned mismatched hashes. | Whether the transaction landed and the read simply missed it, or the transaction was rejected.     | Check the transaction hash on a block explorer; confirm the ledger-declared hash matches the pinned artifact.                                              | If the transaction appears on-chain with the expected hash, the read may be stale. If the hash does not match, the transaction was rejected — do not assume it succeeded.                                      |

**General principle**: every failure entry states what is known, what remains uncertain, and which read-only check to perform next. Blind retries are advised only for rate-limit signals with a `retry-after` hint; all other write failures should be investigated before repeating. Failed reads are never rendered as zero or verified values — they are labeled as errors and reported with diagnostics.

### How do I switch networks?

The current deployment targets Stellar Testnet. Network settings can be inspected in `lib/guard/network.ts`.
