import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import {
  FORM_VALIDATION_DEBOUNCE_MS,
  useFormValidation,
} from "../../lib/guard/useFormValidation.ts";

interface Values {
  address: string;
  cap: string;
}

const validate = (values: Values) => {
  const errors: Record<string, string> = {};
  if (values.address !== "GVALID") errors.address = "Enter a valid address";
  if (!/^\d+$/.test(values.cap)) errors.cap = "Enter a whole-number cap";
  return errors;
};

test("field validation is debounced and corrected errors disappear immediately", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness({ values }: { values: Values }) {
    return react.createElement("output", null, JSON.stringify(useFormValidation(values, validate)));
  }

  const show = (values: Values) =>
    act(() => {
      root.render(react.createElement(Harness, { values }));
    });
  const errors = () => JSON.parse(container.textContent ?? "{}");

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The address is invalid at mount, but nobody has edited it yet.
    await show({ address: "", cap: "12" });
    await act(() => {
      mock.timers.tick(FORM_VALIDATION_DEBOUNCE_MS);
    });
    assert.deepEqual(errors(), {});

    // A bad cap is reported only after typing pauses, and only for the field
    // that was actually edited.
    await show({ address: "", cap: "1.2" });
    await act(() => {
      mock.timers.tick(FORM_VALIDATION_DEBOUNCE_MS - 1);
    });
    assert.deepEqual(errors(), {});

    await act(() => {
      mock.timers.tick(1);
    });
    assert.deepEqual(errors(), { cap: "Enter a whole-number cap" });

    // Editing the address schedules its message; the cap message stays while
    // its own value is unchanged.
    await show({ address: "bad", cap: "1.2" });
    assert.deepEqual(errors(), { cap: "Enter a whole-number cap" });

    await act(() => {
      mock.timers.tick(FORM_VALIDATION_DEBOUNCE_MS);
    });
    assert.deepEqual(errors(), {
      address: "Enter a valid address",
      cap: "Enter a whole-number cap",
    });

    // Correcting one field clears its message at once, without a debounce.
    await show({ address: "bad", cap: "12" });
    assert.deepEqual(errors(), { address: "Enter a valid address" });

    await show({ address: "GVALID", cap: "12" });
    assert.deepEqual(errors(), {});
  } finally {
    await act(() => root.unmount());
    container.remove();
    mock.timers.reset();
  }
});
