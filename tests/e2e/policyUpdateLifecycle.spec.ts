/** A policy edit must survive wallet refusal and require a fresh review to retry. */
import { expect, test, type Page } from "@playwright/test";
import { StrKey } from "@stellar/stellar-sdk";
import { installFreighterMock } from "./walletMock.ts";
import { installSorobanRpcMock } from "./sorobanRpcMock.ts";

const AGENT_ADDRESS = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(7));
const AGENT_PUBKEY_HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";
const AGENT_PUBKEY_PLACEHOLDER = "53b093e0281a2d8f4276b77fd21e3380b3329f09097ace3d9e60cf0f2f9039e2";

async function ensureWalletConnected(page: Page): Promise<void> {
  const connected = page.locator(".pill.ok").filter({ hasText: "connected" });
  try {
    await connected.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.getByRole("button", { name: "Connect admin wallet" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a wallet provider" });
    await expect(picker.getByText("detected", { exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await expect(connected).toBeVisible();
}

test("edit, simulate, review, reject in wallet, retry, and verify a fresh chain read", async ({
  page,
}) => {
  test.slow();
  page.setDefaultTimeout(15_000);
  const chain = await installSorobanRpcMock(page);
  await installFreighterMock(page);

  await page.goto("/deploy");
  await ensureWalletConnected(page);
  await page.getByPlaceholder(AGENT_PUBKEY_PLACEHOLDER).fill(AGENT_PUBKEY_HEX);
  await page.getByLabel("Agent account address").fill(AGENT_ADDRESS);
  await page.getByPlaceholder("3600").fill("3600");
  await page.getByPlaceholder("1000").fill("1000");
  await page.getByPlaceholder("5000").fill("5000");
  await page.getByRole("button", { name: "Deploy guard" }).click();
  await expect(page.getByText("Deployed and verified against the pinned artifact")).toBeVisible({
    timeout: 60_000,
  });
  const predicted = (
    await page.locator(".stat", { hasText: "Predicted guard address" }).locator(".v").innerText()
  ).trim();
  await page.getByRole("button", { name: "Sign and initialize" }).click();
  await expect(page.getByText("initialize landed on chain")).toBeVisible({ timeout: 60_000 });

  await page.goto("/configure");
  await ensureWalletConnected(page);
  const guardSelector = page.locator("label.field select").first();
  await expect(guardSelector.locator(`option[value="${predicted}"]`)).toHaveCount(1);
  await guardSelector.selectOption(predicted);
  await expect(guardSelector).toHaveValue(predicted);

  const panel = page.locator(".panel", { hasText: "Guardrail policy" });
  await panel.getByLabel("Per-transaction cap (blank = off)").fill("1200");
  await panel.getByLabel("Rolling-window cap (blank = off)").fill("6000");
  await expect(panel.locator(".error")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Rolling 24h spend simulation" })).toBeVisible();
  await expect(
    panel.getByRole("img", { name: /Rolling spend curve versus the proposed policy ceiling/ }),
  ).toBeVisible();
  await expect(panel.getByText("Per-tx cap: 1,200 stroops")).toBeVisible();

  await page.evaluate(() => localStorage.setItem("stellar-agent-guard.e2e.reject-next-sign", "1"));
  await panel.getByRole("button", { name: "Sign and install policy" }).click();
  const review = page.getByRole("dialog", { name: "Policy changes" });
  await expect(review).toContainText("1200");
  await expect(review).toContainText("6000");
  await review.getByRole("button", { name: "Confirm and sign" }).click();
  await expect(page.getByText("The policy write did not complete")).toBeVisible();
  await expect(page.getByText(/User rejected the request/)).toBeVisible();
  await expect(page.getByText("set_policy landed on chain")).toHaveCount(0);
  expect(chain.guards.get(predicted)?.policy).toBeNull();

  // A retry must create a new review and wallet request for the same draft.
  await expect(panel.getByLabel("Per-transaction cap (blank = off)")).toHaveValue("1200");
  await panel.getByRole("button", { name: "Sign and install policy" }).click();
  await expect(review).toBeVisible();
  await expect(review).toContainText("1200");
  await review.getByRole("button", { name: "Confirm and sign" }).click();
  await expect(page.getByText("set_policy landed on chain")).toBeVisible({ timeout: 60_000 });
  expect(chain.guards.get(predicted)?.policy).not.toBeNull();

  // Reload forces a new provider and policy() simulation, independent of the receipt.
  const readsBeforeReload = chain.requests.filter(
    (method) => method === "simulateTransaction",
  ).length;
  await page.reload();
  await expect(panel.locator("p.tiny.mono").first()).toContainText("per-transaction cap 1200");
  await expect(panel.locator("p.tiny.mono").first()).toContainText("rolling cap 6000 per 86400s");
  expect(
    chain.requests.filter((method) => method === "simulateTransaction").length,
  ).toBeGreaterThan(readsBeforeReload);
});
