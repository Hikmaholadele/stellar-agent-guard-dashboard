import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { rpc } from "@stellar/stellar-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import {
  SECRET_KEY_PATTERN,
  SECRET_KEY_WARNING,
  dismissSecretKeyAlert,
  findDisallowedLabelChar,
  findSecretKeyInText,
  getSecretKeyAlert,
  installSecretKeyGuard,
  isStellarSecretKey,
  raiseSecretKeyAlert,
  sanitizeAddressInput,
  subscribeSecretKeyAlerts,
  validateLabel,
} from "../../lib/guard/inputSanitizer.ts";
import {
  loadAddressBook,
  previewAddressBookImport,
  saveContact,
  type StorageLike,
} from "../../lib/guard/addressBook.ts";
import { addGuard } from "../../lib/guard/registry.ts";

installDom();

let act: Act;

before(async () => {
  const loaded = await loadReact();
  act = loaded.act;
});

// Fixtures are generated so their length is exactly right by construction — a
// hand-typed 56-character seed is one miscount away from testing nothing.
const SECRET = `S${"A3Y5Q".repeat(11)}`; // S + 55 base32 chars
const PUBLIC = `G${"AB2C4".repeat(11)}`; // G + 55 base32 chars
const CONTRACT = `C${"AB2C4".repeat(11)}`; // C + 55 base32 chars

describe("secret seed detection", () => {
  it("matches the exact Stellar secret seed regex", () => {
    assert.match(SECRET, SECRET_KEY_PATTERN);
    assert.equal(isStellarSecretKey(SECRET), true);
  });

  it("accepts every character the shape allows, including digits after S", () => {
    assert.ok(SECRET_KEY_PATTERN.test(`S${"0".repeat(55)}`));
    assert.ok(SECRET_KEY_PATTERN.test(`S${"9".repeat(55)}`));
    assert.ok(SECRET_KEY_PATTERN.test(`S${"A".repeat(55)}`));
  });

  it("rejects the wrong length, prefix, alphabet and empty input", () => {
    assert.equal(isStellarSecretKey(""), false);
    assert.equal(isStellarSecretKey("S"), false);
    // 54 payload chars: one short.
    assert.equal(isStellarSecretKey(`S${"A".repeat(54)}`), false);
    // 56 payload chars: one long.
    assert.equal(isStellarSecretKey(`S${"A".repeat(56)}`), false);
    // Public-key and contract-id prefixes are never secrets.
    assert.equal(isStellarSecretKey(PUBLIC), false);
    assert.equal(isStellarSecretKey(CONTRACT), false);
    // Lowercase is never a strkey.
    assert.equal(isStellarSecretKey(`s${"a".repeat(55)}`), false);
    // Punctuation and interior spaces break the alphabet.
    assert.equal(isStellarSecretKey(`S${"A".repeat(54)}!`), false);
    assert.equal(isStellarSecretKey(`S ${"A".repeat(54)}`), false);
  });

  it("tolerates surrounding whitespace but not interior gaps", () => {
    assert.equal(isStellarSecretKey(`  ${SECRET}  `), true);
    assert.equal(isStellarSecretKey(`\n${SECRET}\t`), true);
    assert.equal(isStellarSecretKey(`${SECRET} extra`), false);
  });

  it("rejects non-string garbage without throwing", () => {
    assert.equal(isStellarSecretKey(String(undefined)), false);
  });
});

describe("finding a secret inside pasted text", () => {
  it("catches a bare secret", () => {
    assert.equal(findSecretKeyInText(SECRET), SECRET);
  });

  it("catches a secret pasted with a label, JSON or newline separation", () => {
    assert.equal(findSecretKeyInText(`my key: ${SECRET}`), SECRET);
    assert.equal(findSecretKeyInText(`{"secret":"${SECRET}"}`), SECRET);
    assert.equal(findSecretKeyInText(`${PUBLIC}\n${SECRET}`), SECRET);
  });

  it("returns null for clean text of every ordinary kind", () => {
    assert.equal(findSecretKeyInText(PUBLIC), null);
    assert.equal(findSecretKeyInText(CONTRACT), null);
    assert.equal(findSecretKeyInText("1000"), null);
    assert.equal(findSecretKeyInText("not an address"), null);
    assert.equal(findSecretKeyInText(""), null);
  });

  it("does not flag secret-shaped runs that are part of a longer token", () => {
    // A longer run, or one embedded inside other alphanumerics, is not a
    // standalone strkey and must not false-positive.
    assert.equal(findSecretKeyInText(`X${SECRET}`), null);
    assert.equal(findSecretKeyInText(`${SECRET}X`), null);
  });
});

describe("sanitizeAddressInput", () => {
  it("passes ordinary values through untouched", () => {
    assert.equal(sanitizeAddressInput(PUBLIC), PUBLIC);
    assert.equal(sanitizeAddressInput(CONTRACT), CONTRACT);
    assert.equal(sanitizeAddressInput("1000"), "1000");
    assert.equal(sanitizeAddressInput("not-an-address"), "not-an-address");
    assert.equal(sanitizeAddressInput(""), "");
  });

  it("replaces a secret seed with the empty string", () => {
    assert.equal(sanitizeAddressInput(SECRET), "");
    assert.equal(sanitizeAddressInput(`  ${SECRET} `), "");
    assert.equal(sanitizeAddressInput(`key: ${SECRET}`), "");
  });

  it("clears the whole value when a secret is anywhere in it", () => {
    // There is no partial keep: a value that arrived with a secret in it is
    // tainted, and keeping the "clean" remainder would still store evidence.
    assert.equal(sanitizeAddressInput(`${PUBLIC}\n${SECRET}`), "");
  });
});

describe("security alert store", () => {
  it("starts with no alert and notifies subscribers immediately on subscribe", () => {
    dismissSecretKeyAlert();
    assert.equal(getSecretKeyAlert(), null);
    let seen: unknown = "unset";
    const unsubscribe = subscribeSecretKeyAlerts((alert) => {
      seen = alert;
    });
    assert.equal(seen, null);
    unsubscribe();
  });

  it("raises the exact required warning text", () => {
    dismissSecretKeyAlert();
    raiseSecretKeyAlert();
    const alert = getSecretKeyAlert();
    assert.ok(alert);
    assert.equal(alert.message, SECRET_KEY_WARNING);
    assert.equal(
      alert.message,
      "SECURITY ALERT: You pasted a secret key. This dashboard never requires secret keys. Do not share your private key.",
    );
  });

  it("counts repeated attempts on one alert instead of stacking dialogs", () => {
    dismissSecretKeyAlert();
    raiseSecretKeyAlert();
    raiseSecretKeyAlert();
    const alert = getSecretKeyAlert();
    assert.equal(alert?.attempts, 2);
    dismissSecretKeyAlert();
    assert.equal(getSecretKeyAlert(), null);
  });

  it("stops notifying after unsubscribe", () => {
    dismissSecretKeyAlert();
    let calls = 0;
    const unsubscribe = subscribeSecretKeyAlerts(() => {
      calls += 1;
    });
    assert.equal(calls, 1); // the immediate flush on subscribe
    raiseSecretKeyAlert();
    assert.equal(calls, 2);
    unsubscribe();
    raiseSecretKeyAlert();
    dismissSecretKeyAlert();
    assert.equal(calls, 2);
  });
});

describe("document-level paste/input/change interception", () => {
  // A per-test guard handle plus a mirror of the store, reset before each case
  // so no assertion can pass on a leftover alert from a previous test.
  let uninstall: (() => void) | null = null;
  let lastAlert: { message: string } | null = null;

  before(() => {
    subscribeSecretKeyAlerts((alert) => {
      lastAlert = alert;
    });
  });

  function reset(): void {
    uninstall?.();
    uninstall = null;
    dismissSecretKeyAlert();
    lastAlert = null;
  }

  function install(): void {
    uninstall = installSecretKeyGuard();
  }

  function makeField(type = "text"): HTMLInputElement {
    const field = document.createElement("input");
    field.type = type;
    document.body.appendChild(field);
    return field;
  }

  /** A paste event carrying the given clipboard text, dispatched at the target. */
  function paste(target: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    const event = document.createEvent("Event") as Event & { clipboardData?: unknown };
    event.initEvent("paste", true, true);
    event.clipboardData = {
      getData: (type: string) => (type === "text/plain" || type === "text" ? text : ""),
    };
    target.dispatchEvent(event);
  }

  /** Set the field's value (unless omitted) and dispatch a bubbling event. */
  function fire(
    target: HTMLInputElement | HTMLTextAreaElement,
    type: "input" | "change",
    value?: string,
  ): void {
    if (value !== undefined) target.value = value;
    const event = document.createEvent("Event");
    event.initEvent(type, true, false);
    target.dispatchEvent(event);
  }

  it("blocks a pasted secret before it reaches the field and raises the warning", () => {
    reset();
    install();
    try {
      const field = makeField();
      field.value = "typing already here";
      paste(field, SECRET);

      // The spec is explicit: a blocked paste clears the input buffer — the
      // field must end empty, not with whatever sat there before the paste.
      assert.equal(field.value, "", "the paste must be blocked and the buffer cleared");
      assert.ok(lastAlert, "a security alert must be raised");
      assert.equal(lastAlert?.message, SECRET_KEY_WARNING);
      assert.ok(getSecretKeyAlert());
    } finally {
      reset();
    }
  });

  it("lets ordinary pastes through untouched", () => {
    reset();
    install();
    try {
      const field = makeField();
      field.value = "preset";
      paste(field, PUBLIC);
      // jsdom performs no default paste insertion, so an unblocked paste means
      // the field keeps exactly what it had and the guard stays silent.
      assert.equal(field.value, "preset");
      assert.equal(getSecretKeyAlert(), null);
    } finally {
      reset();
    }
  });

  it("clears the field when a secret arrives via input without clipboard data", () => {
    reset();
    install();
    try {
      const field = makeField();
      fire(field, "input", SECRET);
      assert.equal(field.value, "", "the input net must clear a secret already in the field");
      assert.ok(lastAlert);
    } finally {
      reset();
    }
  });

  it("still catches a secret on change (blur) if earlier layers missed it", () => {
    reset();
    install();
    try {
      const field = makeField();
      fire(field, "change", SECRET);
      assert.equal(field.value, "", "the change net must clear the field before focus moves on");
      assert.ok(lastAlert);
    } finally {
      reset();
    }
  });

  it("ignores non-text targets", () => {
    reset();
    install();
    try {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      document.body.appendChild(checkbox);
      paste(checkbox, SECRET);
      fire(checkbox, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null, "checkboxes are never screened");
    } finally {
      reset();
    }
  });

  it("screens textareas, including secrets pasted inside other text", () => {
    reset();
    install();
    try {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      paste(textarea, `surrounded ${SECRET}`);
      assert.equal(textarea.value, "", "a textarea paste carrying a secret must be blocked");

      fire(textarea, "change", PUBLIC);
      assert.equal(textarea.value, PUBLIC, "clean values pass through");
    } finally {
      reset();
    }
  });

  it("skips disabled and readonly fields", () => {
    reset();
    install();
    try {
      const locked = makeField();
      locked.disabled = true;
      fire(locked, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null);

      const readonly = makeField();
      readonly.readOnly = true;
      fire(readonly, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null);
    } finally {
      reset();
    }
  });

  it("covers password, number and search fields too", () => {
    reset();
    install();
    try {
      for (const type of ["password", "number", "search"]) {
        const field = makeField(type);
        fire(field, "input", SECRET);
        assert.equal(field.value, "", `a ${type} field must be cleared`);
        dismissSecretKeyAlert();
      }
    } finally {
      reset();
    }
  });

  it("stops screening once uninstalled", () => {
    reset();
    install();
    const field = makeField();
    try {
      fire(field, "input", SECRET);
      assert.equal(field.value, "");

      uninstall?.();
      uninstall = null;
      dismissSecretKeyAlert();
      fire(field, "input", SECRET);
      assert.equal(field.value, SECRET, "with the guard down the field keeps whatever it holds");
    } finally {
      reset();
      field.remove();
    }
  });

  it("clears a React-controlled field whose onChange runs the sanitizer", async () => {
    // The state layer (DeployPanel-style wiring): a secret typed through React's
    // own event path must come back as an empty value in both state and DOM.
    reset();
    const { react, createRoot } = await loadReact();
    const container = document.createElement("div");
    document.body.appendChild(container);

    let latest: string | null = null;
    function Controlled() {
      const [value, setValue] = react.useState("");
      react.useEffect(() => {
        latest = value;
      });
      return react.createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) =>
          setValue(sanitizeAddressInput(event.target.value)),
      });
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(react.createElement(Controlled));
    });

    try {
      const field = container.querySelector("input")!;
      // The standard controlled-input typing simulation: write through the
      // native prototype setter so React's value tracker sees a change, then
      // dispatch the input event React listens for.
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      assert.ok(setValue);
      setValue.call(field, SECRET);
      const event = document.createEvent("Event");
      event.initEvent("input", true, false);
      field.dispatchEvent(event);

      await act(async () => {
        await sleep(0);
      });
      assert.equal(field.value, "", "DOM value ends cleared");
      assert.equal(latest, "", "React state settles on the sanitized (empty) value");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      reset();
    }
  });

  it("leaves state and DOM consistent when the guard clears a controlled field", async () => {
    // The DOM layer under a controlled component: the guard's capture-phase
    // clear runs before React sees the event, and the field settles empty with
    // no secret ever reaching the component's state.
    reset();
    install();
    const { react, createRoot } = await loadReact();
    const container = document.createElement("div");
    document.body.appendChild(container);

    const seen: string[] = [];
    function Controlled() {
      const [value, setValue] = react.useState("");
      react.useEffect(() => {
        seen.push(value);
      });
      return react.createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) => setValue(event.target.value),
      });
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(react.createElement(Controlled));
    });

    try {
      const field = container.querySelector("input")!;
      fire(field, "input", SECRET);
      await act(async () => {
        await sleep(0);
      });
      assert.equal(field.value, "", "DOM value cleared by the guard");
      assert.ok(
        seen.every((value) => !value.includes(SECRET)),
        "no render may ever hold the secret",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      reset();
    }
  });
});

// ── Label policy (issue #384) ───────────────────────────────────────────────
//
// The policy: whitespace is normalized, invisible and control characters are
// rejected with a field-level error, and valid international text is never
// rewritten. The tests run it against the primitives and against the two
// entry points that persist labels — a typed save and an imported file.

describe("label policy: detection", () => {
  it("accepts ordinary and international text untouched", () => {
    const clean = [
      "Treasury Multisig",
      "Équipe Trésorière — Café Münster",
      "日本語のラベル",
      "Привет, мир",
      "حساب المستخدم",
      "🚀 Launch account",
      "Straße (Übung)",
      "",
    ];
    for (const label of clean) {
      assert.equal(findDisallowedLabelChar(label), null, `${label} must be clean`);
      assert.equal(validateLabel(label).ok, true, `${label} must be accepted`);
    }
  });

  it("accepts whitespace, because whitespace is normalized rather than rejected", () => {
    // Tabs, newlines, non-breaking spaces and the Unicode separators the
    // whitespace class owns are collapsed by `normalizeAlias`, not refused.
    for (const label of ["  Treasury  ", "Vault\tPromo", "Vault\nPromo", "Vault\u00A0Promo"]) {
      assert.equal(findDisallowedLabelChar(label), null, `${JSON.stringify(label)} is whitespace`);
      assert.equal(validateLabel(label).ok, true);
    }
  });

  it("rejects every invisible and control class, naming the code point", () => {
    const cases: Array<[string, string, string]> = [
      ["Vault\u200BPromo", "U+200B", "ZERO WIDTH SPACE"],
      ["Vault\u200CPromo", "U+200C", "ZERO WIDTH NON-JOINER"],
      ["Vault\u200DPromo", "U+200D", "ZERO WIDTH JOINER"],
      // The deceptive pair itself: with the ZWSP removed the two labels render
      // identically, which is exactly what the policy refuses to allow.
      ["Vault\u200B Promo", "U+200B", "ZERO WIDTH SPACE"],
      ["invoice\u202Efdp.exe", "U+202E", "RIGHT-TO-LEFT OVERRIDE"],
      ["invoice\u202Dfdp.exe", "U+202D", "LEFT-TO-RIGHT OVERRIDE"],
      ["Treasur\uFEFFy", "U+FEFF", "BOM"],
      ["Treasur\u00ADy", "U+00AD", "SOFT HYPHEN"],
      ["Treasury\u2060x", "U+2060", "WORD JOINER"],
      ["Treasury\u2069x", "U+2069", "POP DIRECTIONAL ISOLATE"],
      ["Treasury\u0000x", "U+0000", "CONTROL CHARACTER"],
      ["Treasury\u007Fx", "U+007F", "CONTROL CHARACTER"],
      ["Treasury\u0085x", "U+0085", "CONTROL CHARACTER"],
      ["Treasury\u2028x", "U+2028", "LINE SEPARATOR"],
    ];
    for (const [label, code, name] of cases) {
      const found = findDisallowedLabelChar(label);
      assert.ok(found, `${JSON.stringify(label)} must be rejected`);
      assert.equal(found.code, code, `${JSON.stringify(label)} → ${found.code}`);
      assert.match(found.name, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const check = validateLabel(label);
      assert.equal(check.ok, false, `${JSON.stringify(label)} must fail validation`);
      if (!check.ok) {
        assert.ok(check.error.includes(code), `the error must name ${code}`);
        assert.ok(check.error.includes(found.name), "the error must name the character class");
      }
    }
  });

  it("reports the first offender's position so the field can point at it", () => {
    const found = findDisallowedLabelChar("Clean\u200B label");
    assert.ok(found);
    assert.equal(found.index, 5);
    const check = validateLabel("Clean\u200B label");
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.error, /position 6/);
  });
});

describe("label policy: typed saves (address book)", () => {
  const ACCOUNT = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
  const OTHER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

  function memoryStorage(): StorageLike {
    const map = new Map<string, string>();
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
    };
  }

  it("refuses a typed label with an invisible character, and persists nothing", () => {
    const storage = memoryStorage();
    assert.throws(
      () => saveContact({ address: ACCOUNT, label: "Vault\u200BPromo" }, storage),
      /U\+200B/,
      "the refusal must name the offending character",
    );
    assert.deepEqual(loadAddressBook(storage), [], "nothing was written");
  });

  it("the two visually identical labels cannot both exist: one is saved, one is refused", () => {
    const storage = memoryStorage();
    saveContact({ address: ACCOUNT, label: "Vault Promo" }, storage);
    // Without the policy this would collide invisibly or slip past the
    // operator's eye; with it, the save is refused outright.
    assert.throws(
      () => saveContact({ address: OTHER, label: "Vault\u200B Promo" }, storage),
      /U\+200B/,
    );
    const book = loadAddressBook(storage);
    assert.equal(book.length, 1);
    assert.equal(book[0]!.label, "Vault Promo");
  });

  it("preserves ordinary accented text exactly as typed (after whitespace normalization)", () => {
    const storage = memoryStorage();
    const result = saveContact({ address: ACCOUNT, label: "  Équipe  Trésorière " }, storage);
    assert.equal(result.status, "saved");
    if (result.status === "saved") assert.equal(result.contact.label, "Équipe Trésorière");
  });

  it("drops a pre-policy deceptive entry when the stored book is loaded", () => {
    const storage = memoryStorage();
    storage.setItem(
      "stellar-agent-guard-dashboard.addressBook.v1",
      JSON.stringify([
        { address: ACCOUNT, label: "Vault\u200BPromo", addedAt: "2026-01-01T00:00:00.000Z" },
        { address: OTHER, label: "Clean", addedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    const book = loadAddressBook(storage);
    assert.deepEqual(
      book.map((contact) => contact.label),
      ["Clean"],
      "the deceptive entry is dropped; loading is a save path too",
    );
  });
});

describe("label policy: imported names", () => {
  const ACCOUNT = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
  const OTHER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

  function file(records: unknown[]): string {
    return JSON.stringify({
      schema: "stellar-agent-guard/address-book",
      version: 1,
      exportedAt: "2026-10-20T00:00:00.000Z",
      contacts: records,
    });
  }

  it("reports an imported label with a bidi override as invalid, record by record", () => {
    const preview = previewAddressBookImport(
      file([
        { address: ACCOUNT, label: "Treasury" },
        { address: OTHER, label: "invoice\u202Efdp.exe" },
      ]),
      [],
    );
    assert.equal(preview.mergeable.length, 1, "the clean record is still importable");
    assert.equal(preview.invalid.length, 1);
    const issue = preview.invalid[0]!;
    assert.equal(issue.index, 2, "the offending record is pointed at");
    assert.match(issue.reason, /Contact 2/);
    assert.match(issue.reason, /U\+202E/, "the reason names the code point");
    assert.equal(preview.result.merge.length, 1, "the deceptive label never lands");
  });

  it("imports ordinary accented and non-Latin labels unchanged", () => {
    const preview = previewAddressBookImport(
      file([
        { address: ACCOUNT, label: "Équipe Trésorière" },
        { address: OTHER, label: "日本語のラベル" },
      ]),
      [],
    );
    assert.equal(preview.invalid.length, 0);
    assert.deepEqual(
      preview.mergeable.map((contact) => contact.label),
      ["Équipe Trésorière", "日本語のラベル"],
    );
  });
});

describe("label policy: guard registry names", () => {
  const GUARD = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";

  it("refuses a deceptive registry label before any RPC call", async () => {
    let touched = 0;
    const server = new Proxy(
      {},
      {
        get: () => {
          touched += 1;
          throw new Error("the network must not be touched for a label rejection");
        },
      },
    ) as unknown as rpc.Server;
    const result = await addGuard({ server, address: GUARD, label: "Treasury\u200B" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "invalid");
      assert.match(result.error, /U\+200B/);
    }
    assert.equal(touched, 0, "no property of the server was ever read");
  });
});
