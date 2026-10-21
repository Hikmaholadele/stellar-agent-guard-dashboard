/**
 * E2E: the operator's wallet is on the wrong network, and the console must
 * refuse to help until that is fixed.
 *
 * The dashboard is pinned to testnet (`lib/guard/network.ts`). A wallet on
 * mainnet produces signatures over a different network id, so no write it signs
 * can be valid; the console refuses at connect time and every write control
 * stays disabled until wallet and dashboard agree. This suite walks that exact
 * path in a real browser: the wallet is mocked at the extension's own
 * postMessage bridge (`walletMock.ts`) and can be switched between networks at
 * runtime, which is what the recovery half of the scenario needs.
 *
 * The chain is served by `rpcFixtures.ts`, XDR-exact and — for the pinned
 * artifact's code entry — the real committed bytecode, validated against the
 * SDK's own parsers by `tests/unit/rpcFixtures.test.ts`. Nothing here touches
 * the real network, so the scenario is deterministic and free.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  connectWalletFromUi,
  installWalletMock,
  MAINNET_PASSPHRASE,
  switchWalletNetwork,
} from "./networkMismatchWalletMock.ts";
import { handleRpcRequest } from "./rpcFixtures.ts";

const MISMATCH_BANNER = /Wallet on Mainnet, dashboard on Testnet/;
const TOOLTIP = /Connect admin wallet to perform this action/;

/** Answer every Soroban RPC POST the console makes with the local fixtures. */
async function mockSorobanRpc(page: Page): Promise<void> {
  await page.route("https://soroban-testnet.stellar.org/**", (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") return void route.fulfill({ status: 405, body: "" });
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: handleRpcRequest(request.postDataJSON()).body,
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockSorobanRpc(page);
  await installWalletMock(page, { networkPassphrase: MAINNET_PASSPHRASE, network: "Mainnet" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stellar Agent Guard" })).toBeVisible();
});

test("a mainnet wallet is refused with the network mismatch blocker", async ({ page }) => {
  await connectWalletFromUi(page);

  // The blocker names both sides of the mismatch and the consequence, in the
  // console's own wording from GuardProvider.
  await expect(page.getByText(MISMATCH_BANNER)).toBeVisible();
  await expect(page.getByText(/Switch the wallet's network/)).toBeVisible();

  // The refusal is state, not just prose: the wallet stays disconnected, so
  // nothing on the page claims a wallet is connected. `exact` matters — the page
  // carries other strings containing the word ("Disconnected", "Stay connected").
  await expect(page.getByText("connected", { exact: true })).toHaveCount(0);
});

test("write controls stay disabled with an explanatory tooltip while the wallet is on the wrong network", async ({
  page,
}) => {
  await connectWalletFromUi(page);
  await expect(page.getByText(MISMATCH_BANNER)).toBeVisible();

  // Panic panel: both actions disabled, each carrying the explanation.
  // `exact` for Unfreeze: the panel also offers "Export Unfreeze XDR".
  const freeze = page.getByRole("button", { name: "Freeze this account" });
  const unfreeze = page.getByRole("button", { name: "Unfreeze", exact: true });
  await expect(freeze).toBeDisabled();
  await expect(unfreeze).toBeDisabled();
  await expect(freeze).toHaveAttribute("title", TOOLTIP);
  await expect(unfreeze).toHaveAttribute("title", TOOLTIP);

  // Configure page: the policy and deploy writes are gated the same way.
  await page.getByRole("link", { name: "Configure", exact: true }).click();
  const install = page.getByRole("button", { name: /Sign and install policy/ });
  const revoke = page.getByRole("button", { name: /Revoke policy/ });
  await expect(install).toBeDisabled();
  await expect(revoke).toBeDisabled();
  await expect(install).toHaveAttribute("title", TOOLTIP);
  await expect(revoke).toHaveAttribute("title", TOOLTIP);
  const deploy = page.getByRole("button", { name: "Deploy guard" });
  await expect(deploy).toBeDisabled();
  await expect(deploy).toHaveAttribute("title", TOOLTIP);
});

test("switching the wallet to the dashboard's network re-enables the controls", async ({
  page,
}) => {
  await connectWalletFromUi(page);
  await expect(page.getByText(MISMATCH_BANNER)).toBeVisible();
  const freeze = page.getByRole("button", { name: "Freeze this account" });
  await expect(freeze).toBeDisabled();

  // The operator fixes the network inside the wallet, then reconnects.
  await switchWalletNetwork(page, "testnet");
  await connectWalletFromUi(page);

  // The blocker is gone, the wallet is connected, and the writes are live.
  await expect(page.getByText(MISMATCH_BANNER)).toHaveCount(0);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(freeze).toBeEnabled();
  await expect(freeze).not.toHaveAttribute("title", TOOLTIP);
  // Unfreeze stays disabled for a different, correct reason: the chain reports
  // the account as not frozen, so there is nothing to unfreeze.
  await expect(page.getByRole("button", { name: "Unfreeze", exact: true })).toBeDisabled();

  await page.getByRole("link", { name: "Configure", exact: true }).click();
  await expect(page.getByRole("button", { name: /Sign and install policy/ })).toBeEnabled();
  // Revoke stays disabled for a different, correct reason: the chain reports
  // no policy installed (default-deny), so there is nothing to revoke.
  const revoke = page.getByRole("button", { name: /Revoke policy/ });
  await expect(revoke).toBeDisabled();
  await expect(revoke).not.toHaveAttribute("title", TOOLTIP);
  // Deploy is wallet-enabled now; it stays disabled only by its artifact gate.
  // Deploy is gated by the wallet *and* by the on-chain artifact identity. The
  // fixtures serve the pinned bytecode, so the artifact gate passes and the only
  // thing that had made deploy unavailable — the mismatched wallet — is gone.
  const deploy = page.getByRole("button", { name: "Deploy guard" });
  await expect(deploy).toBeEnabled();
  await expect(deploy).not.toHaveAttribute("title", TOOLTIP);
});

test("a wallet already on the dashboard's network never shows the blocker", async ({ page }) => {
  // The mock from `beforeEach` starts on mainnet; here the operator fixes the
  // wallet's network before granting access, so the console never sees a
  // mismatch at all.
  await switchWalletNetwork(page, "testnet");
  await connectWalletFromUi(page);

  await expect(page.locator('[data-testid="network-mismatch"]')).toHaveCount(0);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Freeze this account" })).toBeEnabled();
});

test("reconnecting with a different wrong network updates the blocker", async ({ page }) => {
  await connectWalletFromUi(page);
  await expect(page.getByText(MISMATCH_BANNER)).toBeVisible();

  // Point the wallet at some third network; the refusal must name *that* one.
  await page.evaluate((passphrase) => {
    interface Controls {
      switchNetwork(passphrase: string, name: string): void;
    }
    (window as unknown as { __walletMock: Controls }).__walletMock.switchNetwork(
      passphrase,
      "Local",
    );
  }, "Local Network ; January 2020");
  await connectWalletFromUi(page);

  await expect(page.getByText(/Wallet on Local, dashboard on Testnet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Freeze this account" })).toBeDisabled();
});
