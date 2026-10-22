import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { ThemeProvider, useTheme } from "../../components/ThemeProvider.tsx";

let dom: ReturnType<typeof installDom>;
let React: Awaited<ReturnType<typeof loadReact>>["react"];
let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
let act: Awaited<ReturnType<typeof loadReact>>["act"];
let root: ReturnType<typeof createRoot> | null = null;
let mediaQueryCallbacks: Set<Function> = new Set();
let matchMediaResult = false;

before(async () => {
  dom = installDom();
  const reactDeps = await loadReact();
  React = reactDeps.react;
  createRoot = reactDeps.createRoot;
  act = reactDeps.act;

  // Mock matchMedia
  window.matchMedia = ((query: string) => {
    return {
      matches: matchMediaResult,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (type: string, listener: Function) => {
        if (type === "change") mediaQueryCallbacks.add(listener);
      },
      removeEventListener: (type: string, listener: Function) => {
        if (type === "change") mediaQueryCallbacks.delete(listener);
      },
      dispatchEvent: () => true,
    } as any;
  }) as any;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  mediaQueryCallbacks.clear();
  matchMediaResult = false;
});

test("initializes with prefers-color-scheme when no localStorage", async () => {
  matchMediaResult = true; // prefers light
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let currentTheme = "";
  function TestChild() {
    const { theme } = useTheme();
    currentTheme = theme;
    return React.createElement("div", null, theme);
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  assert.equal(currentTheme, "light");
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
});

test("initializes with localStorage if set", async () => {
  localStorage.setItem("theme", "high-contrast");
  matchMediaResult = true; // prefers light but localStorage should win

  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let currentTheme = "";
  function TestChild() {
    const { theme } = useTheme();
    currentTheme = theme;
    return React.createElement("div", null, theme);
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  assert.equal(currentTheme, "high-contrast");
  assert.equal(document.documentElement.getAttribute("data-theme"), "high-contrast");
});

test("updates theme and persists to localStorage on change", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  let setThemeFn: any;
  function TestChild() {
    const { setTheme } = useTheme();
    setThemeFn = setTheme;
    return null;
  }

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement(TestChild)));
  });

  await act(() => {
    setThemeFn("dark");
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(localStorage.getItem("theme"), "dark");
});

test("listens to media query changes if no localStorage set", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  await act(() => {
    root!.render(React.createElement(ThemeProvider, null, React.createElement("div")));
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "dark"); // initial matchMedia=false

  await act(() => {
    mediaQueryCallbacks.forEach((cb) => cb({ matches: true })); // Change to light
  });

  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
});

/**
 * Reduced-motion contract (#339).
 *
 * The behaviour is a stylesheet contract: when the OS preference is on, every
 * animation and transition is reduced to its end state; when it is absent, the
 * normal motion is untouched. jsdom has no media-query engine, so the rules
 * themselves are the artifact under test.
 */

const reducedMotionBlocks = (() => {
  const sheet = readFileSync("app/globals.css", "utf8");
  const blocks: string[] = [];
  const marker = "@media (prefers-reduced-motion: reduce)";
  let from = 0;
  for (;;) {
    const start = sheet.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    let i = sheet.indexOf("{", start);
    for (; i < sheet.length; i++) {
      if (sheet[i] === "{") depth += 1;
      if (sheet[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(sheet.slice(start, i + 1));
    from = i + 1;
  }
  return blocks;
})();

test("reduced motion: a single rule disables non-essential movement", () => {
  const combined = reducedMotionBlocks.join("\n");
  assert.ok(combined.length > 0, "expected a prefers-reduced-motion block");
  assert.match(
    combined,
    /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.001ms\s*!important/,
  );
  assert.match(
    combined,
    /\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-duration:\s*0\.001ms\s*!important/,
  );
  assert.match(
    combined,
    /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-iteration-count:\s*1\s*!important/,
  );
  assert.match(combined, /scroll-behavior:\s*auto\s*!important/);
});

test("reduced motion: end states still apply, so state changes stay visible", () => {
  const combined = reducedMotionBlocks.join("\n");
  // Duration is clamped, not removed: a status banner or toast still reaches
  // its final styling instead of animating and disappearing with the frame.
  assert.equal(/animation:\s*none\s*!important/.test(combined), false);
  assert.equal(/transition:\s*none\s*!important/.test(combined), false);
});

test("reduced motion: normal motion is unchanged when the preference is absent", () => {
  const sheet = readFileSync("app/globals.css", "utf8");
  assert.match(sheet, /\.toast-enter\s*\{[^}]*animation:\s*toast-in/);
  assert.match(sheet, /\.skeleton\s*\{[^}]*animation:\s*skeleton-shimmer/);
  assert.match(sheet, /\.sim-bar::after\s*\{[^}]*transition:\s*width/);
});

test("reduced motion: status is still readable as text, not only as colour or motion", () => {
  const feed = readFileSync("components/TelemetryFeed.tsx", "utf8");
  // The feed row carries its tier as text as well as via the row class, and the
  // decision cell states blocked/allowed in words.
  assert.match(feed, /Severity: \{severity\}/);
  assert.match(feed, />allowed</);
  assert.match(feed, /event\.decision\.reason/);
  // Panels are static sections with no animation of their own to lose.
  const grid = readFileSync("components/DashboardGrid.tsx", "utf8");
  assert.equal(/animation/.test(grid), false);
});
