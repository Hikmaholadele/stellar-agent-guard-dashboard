/**
 * A browser-context mock of the Freighter wallet extension.
 *
 * `@stellar/freighter-api` does not talk to the extension directly: it posts a
 * `FREIGHTER_EXTERNAL_MSG_REQUEST` message on `window` and awaits a matching
 * `FREIGHTER_EXTERNAL_MSG_RESPONSE` (note the API's own `messagedId` spelling
 * in the response). This module installs a listener — via `addInitScript`, so
 * it is in place before any application code runs — that answers those requests
 * with deterministic mock payloads, so the full sign flow (request access →
 * sign envelope) runs headlessly.
 *
 * Signing is simulated by echoing the envelope back unchanged: the dashboard
 * never verifies signatures locally (the network would), so an echo exercises
 * exactly the same code path a real approval would, without a secret key
 * anywhere in the test.
 *
 * Authorization is persisted in `localStorage` so the first visit shows the
 * disconnected state (the connect button is clicked by the test) while later
 * page loads auto-connect — the same behaviour an operator sees after having
 * granted the site access once.
 *
 * The address must match the admin account captured in
 * `tests/fixtures/rpc-capture.json`, because the mocked RPC serves that
 * account's ledger entry for sequence numbers.
 */

import type { Page } from "@playwright/test";

/** The account the mock wallet signs as. */
export const MOCK_ADMIN_ADDRESS = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export interface WalletMockOptions {
  /** Address the wallet reports; defaults to the captured testnet admin. */
  address?: string;
}

/** Install the Freighter message mock into the page before any app script runs. */
export async function installFreighterMock(
  page: Page,
  options: WalletMockOptions = {},
): Promise<void> {
  const address = options.address ?? MOCK_ADMIN_ADDRESS;
  await page.addInitScript(
    ({ address, passphrase }: { address: string; passphrase: string }) => {
      const AUTHORIZED_KEY = "stellar-agent-guard.e2e.wallet-authorized";
      const REJECT_NEXT_SIGN_KEY = "stellar-agent-guard.e2e.reject-next-sign";

      const rejectNextSign = (): boolean => {
        if (window.localStorage.getItem(REJECT_NEXT_SIGN_KEY) !== "1") return false;
        window.localStorage.removeItem(REJECT_NEXT_SIGN_KEY);
        return true;
      };

      const isAuthorized = (): boolean => {
        try {
          return window.localStorage.getItem(AUTHORIZED_KEY) === "1";
        } catch {
          return false;
        }
      };

      interface FreighterRequest {
        source?: string;
        messageId?: number | string;
        type?: string;
        transactionXdr?: string;
        entryXdr?: string;
        accountToSign?: string;
        blob?: string;
      }

      window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data as FreighterRequest | null;
        if (!data || data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;

        const reply = (payload: Record<string, unknown>): void => {
          window.postMessage(
            { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: data.messageId, ...payload },
            window.location.origin,
          );
        };

        switch (data.type) {
          case "REQUEST_ACCESS": {
            try {
              window.localStorage.setItem(AUTHORIZED_KEY, "1");
            } catch {
              // Storage unavailable: fall through and still grant access.
            }
            reply({ publicKey: address });
            return;
          }
          case "REQUEST_PUBLIC_KEY":
            // Empty until the test (or the operator) clicks "Connect": an
            // already-granted wallet would skip the connect step entirely.
            reply({ publicKey: isAuthorized() ? address : "" });
            return;
          case "REQUEST_CONNECTION_STATUS":
            reply({ isConnected: true });
            return;
          case "REQUEST_ALLOWED_STATUS":
          case "SET_ALLOWED_STATUS":
            reply({ isAllowed: true });
            return;
          case "REQUEST_NETWORK":
            reply({ network: "testnet", networkPassphrase: passphrase });
            return;
          case "REQUEST_NETWORK_DETAILS":
            reply({
              networkDetails: {
                network: "testnet",
                networkName: "Stellar Testnet",
                networkUrl: "https://stellarlabs.org",
                networkPassphrase: passphrase,
                sorobanRpcUrl: "https://soroban-testnet.stellar.org",
              },
            });
            return;
          case "SUBMIT_TRANSACTION":
            if (rejectNextSign()) {
              reply({ apiError: { code: -4, message: "User rejected the request" } });
              return;
            }
            reply({
              signedTransaction: data.transactionXdr ?? "",
              signerAddress: data.accountToSign || address,
            });
            return;
          case "SUBMIT_AUTH_ENTRY":
            if (rejectNextSign()) {
              reply({ apiError: { code: -4, message: "User rejected the request" } });
              return;
            }
            reply({
              signedAuthEntry: data.entryXdr ?? "",
              signerAddress: data.accountToSign || address,
            });
            return;
          case "SUBMIT_BLOB":
            reply({
              signedMessage: data.blob ?? "",
              signerAddress: data.accountToSign || address,
            });
            return;
          default:
            reply({
              apiError: {
                code: -32601,
                message: `Freighter mock has no handler for ${String(data.type)}`,
              },
            });
        }
      });
    },
    { address, passphrase: TESTNET_PASSPHRASE },
  );
}
