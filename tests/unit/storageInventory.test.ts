import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS_BOOK_STORAGE_KEY } from "../../lib/guard/addressBook.ts";
import { ALERT_SETTINGS_STORAGE_KEY } from "../../lib/guard/audioAlert.ts";
import { BYTECODE_CACHE_STORAGE_KEY } from "../../lib/guard/bytecodeCache.ts";
import { DENSITY_STORAGE_KEY } from "../../lib/guard/densityStore.ts";
import { SCOPED_STORAGE_BASES, SCOPED_STORAGE_PREFIX } from "../../lib/guard/guardScoped.ts";
import { INSTANCE_STORAGE_PREFIX, LEGACY_INSTANCE_STORAGE_KEY } from "../../lib/guard/instance.ts";
import { LAYOUT_STORAGE_KEY, NAMED_LAYOUTS_STORAGE_KEY } from "../../lib/guard/layoutStore.ts";
import { PRIVACY_MASK_STORAGE_KEY } from "../../lib/guard/privacyStore.ts";
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "../../lib/guard/presentationStorageKeys.ts";
import { SETUP_STORAGE_KEY } from "../../lib/guard/setupChecklist.ts";
import { STORAGE_INVENTORY } from "../../lib/guard/storageInventory.ts";
import { TAB_SYNC_STORAGE_KEY } from "../../lib/guard/tabSync.ts";
import { TX_HISTORY_STORAGE_KEY } from "../../lib/guard/txHistory.ts";
import { IDLE_TIMEOUT_STORAGE_KEY } from "../../lib/guard/useIdleTimer.ts";
import { PREFERRED_WALLET_STORAGE_KEY } from "../../lib/guard/walletConnector.ts";
import { WEBHOOK_SETTINGS_STORAGE_KEY } from "../../lib/guard/webhookDispatcher.ts";

test("the privacy inventory covers every persisted helper key", () => {
  const displayedKeys = new Set(STORAGE_INVENTORY.map((entry) => entry.key));
  const expectedKeys = [
    `${INSTANCE_STORAGE_PREFIX}.{network}`,
    LEGACY_INSTANCE_STORAGE_KEY,
    ADDRESS_BOOK_STORAGE_KEY,
    TX_HISTORY_STORAGE_KEY,
    LAYOUT_STORAGE_KEY,
    NAMED_LAYOUTS_STORAGE_KEY,
    IDLE_TIMEOUT_STORAGE_KEY,
    ALERT_SETTINGS_STORAGE_KEY,
    PREFERRED_WALLET_STORAGE_KEY,
    SETUP_STORAGE_KEY,
    `${SCOPED_STORAGE_PREFIX}.{base}.{network}.{guard}`,
    WEBHOOK_SETTINGS_STORAGE_KEY,
    TAB_SYNC_STORAGE_KEY,
    THEME_STORAGE_KEY,
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    DENSITY_STORAGE_KEY,
    PRIVACY_MASK_STORAGE_KEY,
    BYTECODE_CACHE_STORAGE_KEY,
  ];
  assert.deepEqual([...displayedKeys].sort(), [...expectedKeys].sort());
  assert.ok(SCOPED_STORAGE_BASES.length > 0);
  assert.ok(STORAGE_INVENTORY.every((entry) => entry.purpose && entry.category));
});
