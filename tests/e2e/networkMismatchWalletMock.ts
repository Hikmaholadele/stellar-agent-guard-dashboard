/**
 * An in-page Freighter wallet mock, driven through the extension's own
 * `postMessage` bridge.
 *
 * The freighter-api bundle never touches `window.freighter`: it posts
 * `FREIGHTER_EXTERNAL_MSG_REQUEST` messages to the page and waits for a
 * `FREIGHTER_EXTERNAL_MSG_RESPONSE` with the matching `messagedId` (note the
 * extension's spelling). A content script is just a page-level listener, so a
 * mock that speaks the same protocol is indistinguishable from the real
 * extension — no bundler hooks, no module interception.
 *
 * The mock is injected with `page.addInitScript`, so it exists before any app
 * code runs, and it can switch networks at runtime, which is what the recovery
 * half of the scenario needs: the wallet refuses/lets the dashboard proceed
 * based on the passphrase it reports, exactly like the real thing.
 */

import { expect, type Page } from "@playwright/test";
import { NETWORK } from "../../lib/guard/network.ts";

/** The dashboard's pinned network, for readable failures. */
export const DASHBOARD_PASSPHRASE = NETWORK.passphrase;

/** A mainnet passphrase, i.e. the wrong network for this dashboard. */
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Testnet passphrase, distinct from the dashboard's for the mismatch case. */
export const TESTNET_WRONG_PASSPHRASE = "Test SDF Network ; September 2015 (wrong)";

/** The operator address the mock wallet reports (matches the RPC fixture's funded account). */
export const OPERATOR_ADDRESS = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

interface WalletMockOptions {
  /** The passphrase the mock wallet starts on. */
  networkPassphrase: string;
  /** The human network name the mock wallet reports. */
  network: string;
}

/**
 * Install the wallet mock on the page before any app code runs.
 *
 * Returns nothing: the mock's runtime controls are exposed on `window` and are
 * driven from the test via `switchWalletNetwork` below.
 */
export async function installWalletMock(page: Page, options: WalletMockOptions): Promise<void> {
  await page.addInitScript(
    ({
      passphrase,
      network,
      address,
    }: {
      passphrase: string;
      network: string;
      address: string;
    }) => {
      interface FreighterRequest {
        type: string;
        /** The id the API puts on the request; echoed back as `messagedId`. */
        messageId?: number;
        [key: string]: unknown;
      }

      const state = { passphrase, network, address, connected: false };

      const respond = (request: FreighterRequest, payload: Record<string, unknown>): void => {
        // The real extension replies asynchronously; keep that shape.
        window.setTimeout(() => {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              // The API decorates the request with `messageId` and matches the
              // reply on `messagedId`: the extension's own, deliberate, spelling.
              messagedId: request.messageId,
              ...payload,
            },
            window.location.origin,
          );
        }, 0);
      };

      const networkDetails = () => ({
        network: state.network,
        networkName: state.network,
        networkUrl: "https://mocked.invalid",
        networkPassphrase: state.passphrase,
        sorobanRpcUrl: "https://mocked.invalid/soroban",
      });

      window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as FreighterRequest | null;
        if (event.source !== window || data?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
        const request = data;

        switch (request.type) {
          case "REQUEST_ACCESS": {
            state.connected = true;
            respond(request, { publicKey: state.address, apiError: null });
            break;
          }
          case "REQUEST_PUBLIC_KEY": {
            // Before access is granted the extension reports no address, which
            // is what keeps the console's silent auto-reconnect (it polls
            // currentAddress() on load) from firing until the operator — or the
            // test, via REQUEST_ACCESS — actually grants access.
            respond(request, state.connected ? { publicKey: state.address } : { publicKey: "" });
            break;
          }
          case "REQUEST_NETWORK": {
            respond(request, {
              network: state.network,
              networkPassphrase: state.passphrase,
              networkDetails: networkDetails(),
            });
            break;
          }
          case "REQUEST_NETWORK_DETAILS": {
            respond(request, { networkDetails: networkDetails() });
            break;
          }
          case "REQUEST_ALLOWED_STATUS": {
            respond(request, { isAllowed: state.connected });
            break;
          }
          case "SET_ALLOWED_STATUS": {
            state.connected = true;
            respond(request, { isAllowed: true });
            break;
          }
          case "REQUEST_CONNECTION_STATUS": {
            respond(request, { isConnected: state.connected });
            break;
          }
          case "SUBMIT_TRANSACTION": {
            // Signing is not exercised by this suite: a mismatched wallet is
            // refused before anything is built, so returning an error payload
            // makes an unexpected signing attempt loudly visible instead of
            // silently "succeeding".
            respond(request, {
              signedTransaction: "",
              signerAddress: state.address,
              apiError: { code: -3, message: "wallet mock does not sign transactions" },
            });
            break;
          }
          case "SUBMIT_AUTH_ENTRY": {
            respond(request, {
              signedAuthEntry: null,
              signerAddress: state.address,
              apiError: { code: -3, message: "wallet mock does not sign auth entries" },
            });
            break;
          }
          default:
            respond(request, {
              apiError: { code: -1, message: `wallet mock has no handler for ${request.type}` },
            });
        }
      });

      // Runtime controls, used by the test to play the operator switching the
      // wallet's network inside the extension.
      (window as unknown as Record<string, unknown>).__walletMock = {
        switchNetwork(passphrase: string, name: string): void {
          state.passphrase = passphrase;
          state.network = name;
        },
        state,
      };
    },
    {
      passphrase: options.networkPassphrase,
      network: options.network,
      address: OPERATOR_ADDRESS,
    },
  );
}

/** Which network the mock wallet is on after a switch. */
export type MockNetwork = "mainnet" | "testnet";

/** Network identities the mock can be switched between. */
const NETWORKS: Record<MockNetwork, { passphrase: string; name: string }> = {
  mainnet: { passphrase: MAINNET_PASSPHRASE, name: "Mainnet" },
  testnet: { passphrase: DASHBOARD_PASSPHRASE, name: "TESTNET" },
};

/**
 * Play the operator switching the wallet's network inside the extension.
 *
 * This only changes what the wallet reports; it does not touch the dashboard.
 * The next time the UI asks the wallet for its network, it sees the new one.
 */
export async function switchWalletNetwork(page: Page, to: MockNetwork): Promise<void> {
  const target = NETWORKS[to];
  await page.evaluate(
    ({ passphrase, name }) => {
      interface WalletMockControls {
        switchNetwork(passphrase: string, name: string): void;
      }
      (window as unknown as { __walletMock: WalletMockControls }).__walletMock.switchNetwork(
        passphrase,
        name,
      );
    },
    { passphrase: target.passphrase, name: target.name },
  );
}

/**
 * Connect (or reconnect) the wallet from the page, as the operator clicking the
 * dashboard's own connect button does.
 */
export async function connectWalletFromUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: /connect admin wallet/i }).click();
  const picker = page.getByRole("dialog", { name: "Choose a wallet provider" });
  await expect(picker.getByText("detected", { exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "Connect", exact: true }).click();
}
