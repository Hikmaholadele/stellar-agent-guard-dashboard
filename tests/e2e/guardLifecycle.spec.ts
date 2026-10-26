/**
 * The operator's full lifecycle, end to end, in a real browser (issue #112).
 *
 * Deploy → initialize → install a spend policy → emergency freeze → verify the
 * frozen status → unfreeze. Every step drives the actual Next.js pages
 * (`/deploy`, `/configure`, `/panic`, `/`) in headless Chromium, signs through
 * the mocked Freighter provider in `walletMock.ts`, and lands on a stateful mock
 * chain (`sorobanRpcMock.ts`) that applies each write — so the freeze signed on
 * `/panic` really is the `FROZEN` the status panel then reads back.
 *
 * The assertions are deliberately about what the *operator* can see: predicted
 * addresses, verification badges, confirmation dialogs, status indicators and
 * receipts. Nothing asserts against the mock's internals — if the UI stops
 * telling the truth, this test goes red even when the mock is happy.
 */

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { StrKey } from "@stellar/stellar-sdk";
import { installFreighterMock, MOCK_ADMIN_ADDRESS } from "./walletMock.ts";
import { installSorobanRpcMock } from "./sorobanRpcMock.ts";

/** A distinct, valid agent account: separation of duties is a pre-flight check. */
const AGENT_ADDRESS = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(7));

/** The agent's raw 32-byte Ed25519 key, hex (never the G… strkey form). */
const AGENT_PUBKEY_HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";

const AGENT_PUBKEY_PLACEHOLDER = "53b093e0281a2d8f4276b77fd21e3380b3329f09097ace3d9e60cf0f2f9039e2";

/** Enter the deploy step's parameters, the ones `initialize` will be audited against. */
async function fillInitParameters(page: Page): Promise<void> {
  await page.getByPlaceholder(AGENT_PUBKEY_PLACEHOLDER).fill(AGENT_PUBKEY_HEX);
  await page.getByLabel("Agent account address").fill(AGENT_ADDRESS);
  await page.getByPlaceholder("3600").fill("3600");
  await page.getByPlaceholder("1000").fill("1000");
  await page.getByPlaceholder("5000").fill("5000");
}

/** Connect the mocked admin wallet, or assert an auto-reconnecting one is live. */
async function ensureWalletConnected(page: Page): Promise<void> {
  const connected = page.locator(".pill.ok").filter({ hasText: "connected" });
  // An already-authorized wallet reclaims the session on mount, replacing the
  // connect button outright — so wait for whichever of the two states wins
  // before acting, rather than clicking a node that is about to unmount.
  try {
    await connected.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.getByRole("button", { name: "Connect admin wallet" }).click();
    // The connect button opens the provider picker rather than connecting
    // directly (#96). Freighter is the provider the mock installs, so choose
    // it once detection has marked it "detected".
    const picker = page.getByRole("dialog", { name: "Choose a wallet provider" });
    await expect(picker.getByText("detected", { exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Connect", exact: true }).click();
    await connected.waitFor({ state: "visible" });
  }
  await expect(connected).toBeVisible();
  // The full address rides on the truncated text's `title`, as it does for an
  // operator hovering the account that is about to sign. Scoped to the wallet
  // row: the deploy panel also titles the deployer address, so a page-wide
  // title lookup matches both and violates strict mode.
  await expect(
    page.locator("div.row").filter({ has: connected }).getByTitle(MOCK_ADMIN_ADDRESS),
  ).toBeVisible();
}

/**
 * Select the guard this journey is operating on.
 *
 * Instances are remembered across loads, but the *selection* is a per-page
 * decision — an operator (or a link into a specific screen) picks which account
 * they are looking at — so each screen is pointed at the freshly deployed guard
 * explicitly, exactly as an operator would.
 */
async function selectGuard(page: Page, guard: string): Promise<void> {
  const selector = page.locator("label.field select").first();
  await expect(selector.locator(`option[value="${guard}"]`)).toHaveCount(1);
  await selector.selectOption(guard);
  await expect(selector).toHaveValue(guard);
}

test.describe("guard lifecycle: deploy → configure → freeze → unfreeze", () => {
  // Each write waits on the inclusion poll plus a chain re-read; the whole
  // journey is several of those, so the default timeout would be a coin toss.
  test.slow();

  test("an operator deploys, configures, freezes and unfreezes a guard", async ({ page }) => {
    const chain = await installSorobanRpcMock(page);
    await installFreighterMock(page);

    // ── Step 1: deploy ─────────────────────────────────────────────────────
    await page.goto("/deploy");
    await ensureWalletConnected(page);

    // The artifact gate: deployment is only permitted once the chain's own
    // bytes hash to the pinned Phase 1 artifact.
    await expect(page.getByText("deploy is permitted")).toBeVisible();
    await expect(page.locator(".stat", { hasText: "Identity" }).locator(".v")).toHaveText(
      "matches",
    );

    // Parameters are entered *before* anything is signed, so the pre-flight
    // checklist is green by the time the wallet is prompted.
    await fillInitParameters(page);
    const checklist = page.getByRole("group", {
      name: "Initialization pre-flight checks",
    });
    await expect(checklist).toContainText("Admin and agent are different accounts");
    await expect(checklist).toContainText("Dead-man grace is at least 300 seconds");
    await expect(checklist).toContainText("Initial spend caps are greater than zero");
    await expect(checklist.locator('[role="alert"]')).toHaveCount(0);

    // The address the deploy will produce, reported before signing.
    const predictedStat = page.locator(".stat", { hasText: "Predicted guard address" });
    await expect(predictedStat).toBeVisible();
    const predicted = (await predictedStat.locator(".v").innerText()).trim();
    expect(predicted).toMatch(/^C[A-Z2-7]{55}$/);
    await expect(page.getByText("Pinned bytecode already on chain")).toBeVisible();

    await page.getByRole("button", { name: "Deploy guard" }).click();
    await expect(page.getByText("Deployed and verified against the pinned artifact")).toBeVisible({
      timeout: 60_000,
    });
    const outcome = page.locator(".notice.info", {
      hasText: "Deployed and verified against the pinned artifact",
    });
    await expect(outcome.locator(".tiny.mono")).toHaveText(predicted);
    await expect(outcome.getByText("submitted").first()).toBeVisible();

    // The handoff record (#396) is built from the same outcome, and its verified
    // claim is the live read — not the fact that a transaction was submitted.
    const receiptPanel = page.locator(".notice.info", {
      hasText: "Deployment verification receipt",
    });
    await expect(receiptPanel).toBeVisible();
    await expect(receiptPanel).toContainText("Verification: verified");
    const downloadPromise = page.waitForEvent("download");
    await receiptPanel.getByRole("button", { name: "Download receipt" }).click();
    const download = await downloadPromise;
    const receiptPath = await download.path();
    expect(receiptPath).not.toBeNull();
    const receipt = JSON.parse(readFileSync(receiptPath!, "utf8")) as {
      kind: string;
      schemaVersion: number;
      generator: { provenance: string };
      disclaimer: string;
      network: { name: string };
      addresses: { predicted: string; deployed: string };
      artifact: { pinnedHash: string; pinnedBytes: number };
      verification: { status: string; verified: boolean };
      transactions: Array<{ outcome: string; hash: string | null }>;
    };
    expect(receipt.kind).toBe("stellar-agent-guard.deployment-receipt");
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.generator.provenance).toBe("client-generated");
    expect(receipt.disclaimer).toMatch(/not a signed credential/i);
    expect(receipt.network.name).toBe("testnet");
    expect(receipt.addresses.predicted).toBe(predicted);
    expect(receipt.addresses.deployed).toBe(predicted);
    expect(receipt.verification.status).toBe("verified");
    expect(receipt.verification.verified).toBe(true);
    expect(receipt.artifact.pinnedBytes).toBeGreaterThan(0);
    expect(receipt.transactions.some((tx) => tx.outcome === "submitted")).toBe(true);
    // Nothing a key, an envelope or a wallet session would look like.
    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(serialised).not.toMatch(/AAAAAg[A-Za-z0-9+/=]{16,}/);
    expect(serialised).not.toMatch(/freighter|sessionToken|secretKey|signedXdr/i);

    // ── Step 2: initialize with the parameters entered above ───────────────
    await page.getByRole("button", { name: "Sign and initialize" }).click();
    await expect(page.getByText("initialize landed on chain")).toBeVisible({ timeout: 60_000 });

    // The new guard is now selected, and it is remembered as an instance for
    // every later screen.
    await expect(page.locator("label.field select").first()).toHaveValue(predicted);

    // ── Step 3: configure the spend policy ─────────────────────────────────
    await page.goto("/configure");
    await ensureWalletConnected(page);
    await selectGuard(page, predicted);

    const policyPanel = page.locator(".panel", { hasText: "Guardrail policy" });
    await policyPanel.getByLabel("Per-transaction cap (blank = off)").fill("1000");
    await policyPanel.getByLabel("Rolling-window cap (blank = off)").fill("5000");
    await expect(policyPanel.locator(".error")).toHaveCount(0);

    await policyPanel.getByRole("button", { name: "Sign and install policy" }).click();
    // The diff is the operator's last look before the wallet prompt, so it has to
    // be acknowledged explicitly before anything is signed.
    const policyDiff = page.getByRole("dialog", { name: "Policy changes" });
    await expect(policyDiff).toBeVisible();
    await policyDiff.getByRole("button", { name: "Confirm and sign" }).click();
    await expect(page.getByText("set_policy landed on chain")).toBeVisible({ timeout: 60_000 });

    // The form re-seeds from what the chain now reports — the receipt is the
    // write, this line is the policy actually in force.
    await expect(policyPanel.locator("p.tiny.mono").first()).toContainText(
      "per-transaction cap 1000",
    );
    await expect(policyPanel.locator("p.tiny.mono").first()).toContainText(
      "rolling cap 5000 per 86400s",
    );

    // ── Step 4: emergency freeze ───────────────────────────────────────────
    await page.goto("/panic");
    await ensureWalletConnected(page);
    await selectGuard(page, predicted);

    const adminFreeze = page.locator(".stat", { hasText: "Admin freeze" });
    await expect(adminFreeze.locator(".v")).toHaveText("clear");
    await expect(page.getByText("Chain currently reports:")).toBeVisible();

    const freezeButton = page.getByRole("button", { name: "Freeze this account" });
    await expect(freezeButton).toBeEnabled();
    await freezeButton.click();

    // The confirmation dialog is a real modal: it must appear, demand an
    // acknowledgement, and refuse to sign until it is given.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Confirm the freeze");
    const signFreeze = dialog.getByRole("button", { name: "Sign freeze" });
    await expect(signFreeze).toBeDisabled();
    await dialog.locator("#ack-freeze").check();
    await expect(signFreeze).toBeEnabled();
    await signFreeze.click();

    await expect(page.getByText("Freeze confirmed on chain")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/status\(\)\.admin_frozen now reads true/)).toBeVisible();

    // ── Step 5: the frozen status is visible everywhere it matters ─────────
    await expect(adminFreeze.locator(".v")).toHaveText("FROZEN");
    await expect(adminFreeze.locator(".v")).toHaveClass(/danger/);
    await expect(page.getByText("Chain currently reports:").locator(".pill.danger")).toHaveText(
      "FROZEN",
    );
    await expect(freezeButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "Unfreeze", exact: true })).toBeEnabled();

    // A reload must show the same truth: the freeze lives on the chain, not in
    // the page's memory.
    await page.reload();
    await ensureWalletConnected(page);
    await selectGuard(page, predicted);
    await expect(adminFreeze.locator(".v")).toHaveText("FROZEN", { timeout: 30_000 });
    await expect(freezeButton).toBeDisabled();

    // ── Step 6: unfreeze ───────────────────────────────────────────────────
    await page.getByRole("button", { name: "Unfreeze", exact: true }).click();
    await expect(page.getByText("Unfreeze confirmed on chain")).toBeVisible({ timeout: 60_000 });
    await expect(adminFreeze.locator(".v")).toHaveText("clear");
    await expect(adminFreeze.locator(".v")).toHaveClass(/ok/);
    await expect(page.getByText("Chain currently reports:").locator(".pill.ok")).toHaveText(
      "clear",
    );
    await expect(freezeButton).toBeEnabled();

    // The mock chain really did apply the writes, in order — this is the
    // hermeticity check, not a UI assertion.
    expect(chain.guards.get(predicted)?.frozen).toBe(false);
    expect(chain.guards.get(predicted)?.policy).not.toBeNull();
    expect(chain.requests).toContain("sendTransaction");
  });
});
