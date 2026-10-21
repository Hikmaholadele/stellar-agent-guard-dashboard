"use client";

import { useTheme } from "./ThemeProvider.tsx";
import { usePrivacy } from "../lib/guard/privacyStore.ts";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <select
      className="theme-toggle"
      value={theme}
      onChange={(e) => setTheme(e.target.value as any)}
      aria-label="Select theme"
      style={{ width: "auto", padding: "4px 8px", fontSize: "13px" }}
    >
      <option value="dark">Dark</option>
      <option value="light">Light</option>
      <option value="high-contrast">High Contrast</option>
    </select>
  );
}

/**
 * Toggle presentation privacy mask for balances and long identifiers (#383).
 */
export function PrivacyToggle() {
  const { masked, togglePrivacy } = usePrivacy();

  return (
    <button
      type="button"
      className={`secondary privacy-toggle${masked ? " active" : ""}`}
      onClick={() => togglePrivacy()}
      aria-pressed={masked}
      aria-label={masked ? "Disable privacy mask" : "Enable privacy mask"}
      title={masked ? "Privacy mask active (presentation text masked)" : "Privacy mask inactive"}
      style={{
        padding: "4px 8px",
        fontSize: "13px",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      <span aria-hidden="true">{masked ? "🔒" : "👁"}</span>
      <span>{masked ? "Masked" : "Privacy"}</span>
    </button>
  );
}
