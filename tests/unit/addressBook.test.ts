import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADDRESS_BOOK_EXPORT_SCHEMA,
  ADDRESS_BOOK_EXPORT_VERSION,
  ADDRESS_BOOK_STORAGE_KEY,
  aliasKey,
  applyAddressBookImport,
  deleteContact,
  exportAddressBook,
  isValidAddress,
  loadAddressBook,
  lookupLabel,
  mergeAddressBook,
  normalizeAlias,
  parseAddressBook,
  previewAddressBookImport,
  saveContact,
  suggestedAlias,
  upsertContact,
  type Contact,
  type StorageLike,
} from "../../lib/guard/addressBook.ts";

const ACCOUNT = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
const CONTRACT = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const OTHER = "GBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F";
const FOURTH = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

/** An in-memory stand-in for `localStorage`, so tests inject their own storage. */
function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

function record(address: string, label: string) {
  return { address, label };
}

test("isValidAddress accepts account and contract strkeys, rejects the rest", () => {
  assert.equal(isValidAddress(ACCOUNT), true);
  assert.equal(isValidAddress(CONTRACT), true);
  assert.equal(isValidAddress("  " + ACCOUNT + "  "), true, "surrounding whitespace is tolerated");
  assert.equal(isValidAddress("GA7Q-not-a-key"), false);
  assert.equal(isValidAddress(""), false);
});

test("aliases normalize whitespace and compare case-insensitively", () => {
  assert.equal(normalizeAlias("  Treasury   Multisig "), "Treasury Multisig");
  assert.equal(normalizeAlias("Treasury\tMultisig"), "Treasury Multisig");
  assert.equal(aliasKey("  TREASURY multisig "), "treasury multisig");
  assert.equal(aliasKey("Treasury Multisig"), aliasKey("  treasury   MULTISIG "));
});

test("suggestedAlias appends a deterministic, unused suffix", () => {
  const contacts: Contact[] = [
    { address: ACCOUNT, label: "Treasury", addedAt: "2026-01-01T00:00:00.000Z" },
    { address: CONTRACT, label: "Treasury (2)", addedAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(suggestedAlias("Treasury", contacts), "Treasury (3)");
  assert.equal(suggestedAlias("  treasury ", contacts), "treasury (3)");
  assert.equal(suggestedAlias("Fresh", contacts), "Fresh (2)");
});

test("upsert adds a contact and persists it to storage", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Treasury" }, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "Treasury");
  assert.equal(loaded[0]?.address, ACCOUNT);
  assert.ok(storage.getItem(ADDRESS_BOOK_STORAGE_KEY), "written under the address-book key");
});

test("re-adding a known address updates its label without duplicating", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Old" }, storage);
  const first = loadAddressBook(storage)[0] as Contact;
  upsertContact({ address: ACCOUNT, label: "New" }, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "New");
  assert.equal(loaded[0]?.addedAt, first.addedAt, "the original addedAt is preserved");
});

test("an invalid address or empty label is rejected and nothing is stored", () => {
  const storage = memoryStorage();
  assert.throws(() => upsertContact({ address: "nonsense", label: "X" }, storage), /valid Stellar/);
  assert.throws(() => upsertContact({ address: ACCOUNT, label: "   " }, storage), /label/);
  assert.equal(loadAddressBook(storage).length, 0);
});

test("lookupLabel finds a stored nickname and returns null otherwise", () => {
  const storage = memoryStorage();
  upsertContact({ address: CONTRACT, label: "Soroswap Router" }, storage);
  assert.equal(lookupLabel(CONTRACT, storage), "Soroswap Router");
  assert.equal(lookupLabel(" " + CONTRACT + " ", storage), "Soroswap Router", "trimmed on lookup");
  assert.equal(lookupLabel(OTHER, storage), null);
  assert.equal(lookupLabel("", storage), null);
});

test("deleteContact removes one and leaves the rest", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "A" }, storage);
  upsertContact({ address: OTHER, label: "B" }, storage);
  deleteContact(ACCOUNT, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.address, OTHER);
  // Deleting an unknown address is a no-op, not an error.
  assert.equal(
    deleteContact("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", storage).length,
    1,
  );
});

test("a corrupt or non-array payload loads as an empty book", () => {
  assert.deepEqual(
    loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: "{ not json" })),
    [],
  );
  assert.deepEqual(loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: '{"a":1}' })), []);
});

test("entries with an invalid address or blank label are dropped on load", () => {
  const raw = JSON.stringify([
    { address: ACCOUNT, label: "good" },
    { address: "bad", label: "dropped" },
    { address: OTHER, label: "  " },
  ]);
  const loaded = loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: raw }));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "good");
});

test("a partial legacy address book stays untouched for recovery", () => {
  const raw = JSON.stringify([
    { address: ACCOUNT, label: "good" },
    { address: "bad", label: "unreadable" },
  ]);
  const storage = memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: raw });
  assert.equal(loadAddressBook(storage).length, 1);
  assert.equal(storage.dump()[ADDRESS_BOOK_STORAGE_KEY], raw);
});

/* -------------------------------------------------------------------------- */
/* Versioned export                                                           */
/* -------------------------------------------------------------------------- */

test("export writes a versioned document containing only public addresses and labels", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "  Treasury   Multisig " }, storage);
  upsertContact({ address: CONTRACT, label: "Soroswap Router" }, storage);

  const exported = exportAddressBook(loadAddressBook(storage), new Date("2026-10-20T12:00:00Z"));
  const document = JSON.parse(exported) as Record<string, unknown>;

  assert.equal(document.schema, ADDRESS_BOOK_EXPORT_SCHEMA);
  assert.equal(document.version, ADDRESS_BOOK_EXPORT_VERSION);
  assert.equal(document.exportedAt, "2026-10-20T12:00:00.000Z");
  assert.deepEqual(document.contacts, [
    { address: CONTRACT, label: "Soroswap Router" },
    { address: ACCOUNT, label: "Treasury Multisig" },
  ]);
  assert.equal(exported.includes("addedAt"), false, "timestamps stay out of the portable file");
  assert.equal(exported.endsWith("\n"), true, "the file ends with a newline");
});

test("the versioned book round-trips through export and strict parse", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Treasury Multisig" }, storage);
  upsertContact({ address: CONTRACT, label: "Soroswap Router" }, storage);
  const exported = exportAddressBook(loadAddressBook(storage));
  const reparsed = parseAddressBook(exported);
  assert.equal(reparsed.length, 2);
  assert.equal(
    lookupLabel(ACCOUNT, memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: JSON.stringify(reparsed) })),
    "Treasury Multisig",
  );
});

test("the legacy bare-array export is still readable", () => {
  const legacy = JSON.stringify([{ address: ACCOUNT, label: "Old Backup" }]);
  const parsed = parseAddressBook(legacy);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.label, "Old Backup");

  const preview = previewAddressBookImport(legacy, []);
  assert.equal(preview.version, 0);
  assert.equal(preview.legacy, true);
  assert.match(preview.warnings.join(" "), /legacy/);
  assert.equal(preview.mergeable.length, 1);
});

test("unsupported versions and schemas are rejected rather than guessed at", () => {
  assert.throws(
    () => parseAddressBook(JSON.stringify({ version: 99, contacts: [] })),
    /Unsupported address-book file version 99/,
  );
  assert.throws(
    () =>
      parseAddressBook(
        JSON.stringify({ schema: "some-other-tool/book", version: 1, contacts: [] }),
      ),
    /Unsupported address-book schema/,
  );
  assert.throws(() => parseAddressBook(JSON.stringify({ contacts: [] })), /integer schema version/);
  assert.throws(
    () => parseAddressBook(JSON.stringify({ version: 1, contacts: "nope" })),
    /contacts array/,
  );
});

test("parseAddressBook rejects invalid JSON, bad addresses, blank labels and duplicates", () => {
  assert.throws(() => parseAddressBook("not json"), /valid JSON/);
  assert.throws(() => parseAddressBook('{"address":"x"}'), /integer schema version/);
  assert.throws(
    () => parseAddressBook(`[{"address":"nope","label":"x"}]`),
    /Contact 1.*valid Stellar/,
  );
  assert.throws(
    () => parseAddressBook(`[{"address":"${ACCOUNT}","label":""}]`),
    /label is required/,
  );
  assert.throws(
    () =>
      parseAddressBook(
        JSON.stringify([
          { address: ACCOUNT, label: "one" },
          { address: ACCOUNT, label: "two" },
        ]),
      ),
    /duplicate address/,
  );
});

/* -------------------------------------------------------------------------- */
/* Explicit duplicate-address and alias conflict resolution (#377)            */
/* -------------------------------------------------------------------------- */

test("saving an existing address with a new alias stops at a conflict and changes nothing", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);
  const before = storage.dump();

  const result = saveContact({ address: ACCOUNT, label: "Ops treasury" }, storage);
  assert.equal(result.status, "conflict");
  if (result.status !== "conflict") return;
  assert.equal(result.conflict.kind, "duplicate-address");
  assert.deepEqual(result.conflict.resolutions, ["update"]);
  assert.equal(result.conflict.existing.label, "Treasury");
  assert.equal(result.conflict.suggestedLabel, null);
  assert.deepEqual(storage.dump(), before, "the existing entry is untouched");
});

test("an explicitly confirmed update relabels the address and keeps addedAt", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);
  const first = loadAddressBook(storage)[0] as Contact;

  const result = saveContact(
    { address: ACCOUNT, label: "  Ops   Treasury ", resolution: "update" },
    storage,
  );
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.equal(result.action, "updated");
  assert.equal(result.contact.label, "Ops Treasury", "the stored alias is normalized");
  assert.equal(result.contact.addedAt, first.addedAt);
  assert.equal(loadAddressBook(storage).length, 1);
});

test("an identical alias in different case or spacing is a no-op, not a conflict", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury Multisig" }, storage);
  const result = saveContact({ address: ACCOUNT, label: "  treasury   MULTISIG " }, storage);
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.equal(result.action, "unchanged");
  assert.equal(loadAddressBook(storage)[0]?.label, "Treasury Multisig", "display casing is kept");
});

test("an alias held by another address is a conflict with rename and update options", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);
  const before = storage.dump();

  const result = saveContact({ address: OTHER, label: " treasury " }, storage);
  assert.equal(result.status, "conflict");
  if (result.status !== "conflict") return;
  assert.equal(result.conflict.kind, "alias-conflict");
  assert.deepEqual(result.conflict.resolutions, ["rename", "update"]);
  assert.equal(result.conflict.existing.address, ACCOUNT);
  assert.equal(result.conflict.suggestedLabel, "treasury (2)");
  assert.deepEqual(storage.dump(), before, "the alias holder is preserved until confirmed");
});

test("rename stores the new address under a disambiguated alias and keeps the holder", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);

  const result = saveContact({ address: OTHER, label: "Treasury", resolution: "rename" }, storage);
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.equal(result.action, "renamed");
  assert.equal(result.contact.label, "Treasury (2)");
  assert.equal(lookupLabel(ACCOUNT, storage), "Treasury");
  assert.equal(lookupLabel(OTHER, storage), "Treasury (2)");
});

test("update moves the alias explicitly, removing the previous holder", () => {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);

  const result = saveContact({ address: OTHER, label: "Treasury", resolution: "update" }, storage);
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.equal(result.action, "updated");
  assert.equal(
    lookupLabel(ACCOUNT, storage),
    null,
    "the old holder is gone only after confirmation",
  );
  assert.equal(lookupLabel(OTHER, storage), "Treasury");
  assert.equal(loadAddressBook(storage).length, 1);
});

/* -------------------------------------------------------------------------- */
/* Import preview, merge and replace (#376)                                   */
/* -------------------------------------------------------------------------- */

function seededBook() {
  const storage = memoryStorage();
  saveContact({ address: ACCOUNT, label: "Treasury" }, storage);
  saveContact({ address: CONTRACT, label: "Router" }, storage);
  return storage;
}

test("import preview classifies valid, invalid, duplicate and alias-conflict records before writing", () => {
  const storage = seededBook();
  const before = storage.dump();
  const file = JSON.stringify({
    schema: ADDRESS_BOOK_EXPORT_SCHEMA,
    version: 1,
    exportedAt: "2026-10-20T00:00:00.000Z",
    contacts: [
      record(ACCOUNT, "Treasury Multisig"), // duplicate address (local relabel)
      record(OTHER, "router"), // alias conflict with CONTRACT, case-folded
      record("not-an-address", "Broken"), // invalid
      record(ACCOUNT, "Treasury again"), // duplicate address within the file
      record(FOURTH, "Cold Wallet"), // clean
    ],
  });

  const preview = previewAddressBookImport(file, loadAddressBook(storage));
  assert.equal(preview.total, 5);
  assert.equal(preview.version, 1);
  assert.equal(preview.legacy, false);
  assert.equal(preview.mergeable.length, 1, "only the clean record can be merged");
  assert.equal(preview.mergeable[0]?.address, FOURTH);
  assert.equal(preview.invalid.length, 1);
  assert.equal(preview.duplicates.length, 2);
  assert.equal(preview.aliasConflicts.length, 1);
  assert.deepEqual(
    preview.issues.map((issue) => issue.kind),
    ["duplicate-address", "alias-conflict", "invalid", "duplicate-address"],
  );
  assert.equal(preview.result.merge.length, 3, "merge keeps the two local contacts");
  assert.equal(preview.result.replace.length, 3, "replace writes ACCOUNT, OTHER and FOURTH");
  assert.deepEqual(storage.dump(), before, "previewing never writes");
});

test("a merge applies only clean records and preserves local entries", () => {
  const storage = seededBook();
  const preview = previewAddressBookImport(
    JSON.stringify({
      version: 1,
      contacts: [record(FOURTH, "Cold Wallet"), record(ACCOUNT, "Different alias")],
    }),
    loadAddressBook(storage),
  );

  const tally = applyAddressBookImport(preview, "merge", storage);
  assert.equal(tally.mode, "merge");
  assert.equal(tally.applied, 1);
  assert.equal(tally.skipped, 1);
  assert.equal(tally.total, 3);
  assert.equal(lookupLabel(ACCOUNT, storage), "Treasury", "the local alias is kept");
  assert.equal(lookupLabel(CONTRACT, storage), "Router");
  assert.equal(lookupLabel(FOURTH, storage), "Cold Wallet");
});

test("a confirmed replace writes the imported book and drops local-only contacts", () => {
  const storage = seededBook();
  const preview = previewAddressBookImport(
    JSON.stringify({
      version: 1,
      contacts: [record(ACCOUNT, "Treasury Multisig"), record(OTHER, "Router")],
    }),
    loadAddressBook(storage),
  );

  assert.equal(preview.replaceable.length, 2);
  const tally = applyAddressBookImport(preview, "replace", storage);
  assert.equal(tally.mode, "replace");
  assert.equal(tally.applied, 2);
  assert.equal(tally.total, 2);
  assert.equal(lookupLabel(ACCOUNT, storage), "Treasury Multisig", "imported alias wins");
  assert.equal(lookupLabel(CONTRACT, storage), null, "local-only contact is removed");
  assert.equal(lookupLabel(OTHER, storage), "Router", "the alias moved to the imported address");
});

test("duplicates within one file are reported even with an empty local book", () => {
  const storage = memoryStorage();
  const preview = previewAddressBookImport(
    JSON.stringify([
      { address: ACCOUNT, label: "One" },
      { address: ACCOUNT, label: "Two" },
    ]),
    [],
  );
  assert.equal(preview.total, 2);
  assert.equal(preview.duplicates.length, 1);
  assert.match(preview.duplicates[0]?.reason ?? "", /more than once/);
  assert.equal(preview.mergeable.length, 1, "the first record is still applyable");
  assert.equal(preview.result.replace.length, 1);
});

test("an import writes only address-book data, never other browser or wallet state", () => {
  const storage = memoryStorage({
    "stellar-agent-guard-dashboard.wallet": "keep-me",
    "some.other.key": "untouched",
  });
  const preview = previewAddressBookImport(
    JSON.stringify([{ address: ACCOUNT, label: "Treasury" }]),
    [],
  );
  applyAddressBookImport(preview, "replace", storage);
  const dump = storage.dump();
  assert.equal(dump["stellar-agent-guard-dashboard.wallet"], "keep-me");
  assert.equal(dump["some.other.key"], "untouched");
  assert.equal(lookupLabel(ACCOUNT, storage), "Treasury");
});

test("mergeAddressBook remains additive and reports its tally", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Keep me" }, storage);
  upsertContact({ address: CONTRACT, label: "Old Router" }, storage);
  const tally = mergeAddressBook(
    loadAddressBook(storage),
    [
      { address: CONTRACT, label: "Soroswap Router", addedAt: new Date().toISOString() },
      { address: OTHER, label: "Cold Wallet", addedAt: new Date().toISOString() },
    ],
    storage,
  );
  assert.equal(tally.applied, 2, "one added and one relabelled");
  assert.equal(tally.total, 3);
  assert.equal(lookupLabel(ACCOUNT, storage), "Keep me", "untouched existing contact survives");
  assert.equal(lookupLabel(CONTRACT, storage), "Soroswap Router");
  assert.equal(lookupLabel(OTHER, storage), "Cold Wallet");
});
