/**
 * The console's shareable-view URL state (issue #132).
 *
 * An operator debugging an incident with a teammate needs to hand over exactly
 * what they are looking at: this guard, on this network, this tab, this filter.
 * This module is the single codec for those four query parameters —
 *
 *   `/?guard=CA3D…&network=testnet&tab=telemetry&filter=blocked`
 *
 * — and it is deliberately split into pure functions over search strings
 * (`encode` / `decode` / `merge`) plus one thin browser binding
 * (`writeUrlState`). Three rules shape it, and all three come from the console's
 * existing commitments:
 *
 *   1. **Everything a link carries is untrusted input.** Each parameter is
 *      validated against its own vocabulary — a guard address must look like a
 *      contract address, the tab/filter/network must be values this build
 *      actually has — and anything that fails is *dropped*, never adopted. A
 *      malformed parameter can therefore never reach state, and the next write
 *      removes it from the address bar (see `mergeUrlState`).
 *   2. **Writing the URL is never navigation.** State is mirrored with
 *      `history.replaceState`: no reload, no history spam, no lost feed,
 *      wallet session or form draft. Unknown parameters (`?demo=true`, UTM
 *      noise, a hand-edited `?section=`) pass through untouched — this module
 *      owns four keys and only ever rewrites those four.
 *   3. **Defaults are omitted.** A URL is shareable exactly as it appears: the
 *      verdict filter is dropped while it is `all`, so a quiet view stays a
 *      clean `?guard=…&network=testnet&tab=console`.
 *
 * The network parameter is validated against {@link NETWORK.name} on purpose:
 * this build is single-network (one passphrase, one RPC endpoint — see
 * `network.ts`), so a link claiming any other network is not "a different
 * state to restore" but a link that cannot mean anything here. It is rejected
 * the same way a malformed address is.
 */

import { GUARD_QUERY_PARAM } from "./deeplink.ts";
import { looksLikeContractAddress } from "./instance.ts";
import { NETWORK } from "./network.ts";
import type { VerdictFilter } from "./telemetryExport.ts";

/** The four query parameters this module owns, in canonical URL order. */
export const URL_STATE_PARAMS = {
  guard: GUARD_QUERY_PARAM,
  network: "network",
  tab: "tab",
  filter: "filter",
} as const;

/**
 * Every value the `tab` parameter accepts.
 *
 * Two kinds share one namespace because a URL must read as one view:
 *
 *   - **Screen tabs** name a top-level route — the tabs the nav
 *     (`components/bits.tsx`) switches between, plus the two addressable
 *     screens it does not link (`deploy`, `panic`). They restore by navigating.
 *   - **Console panel tabs** name a panel of the console (`app/page.tsx`).
 *     They restore by bringing that panel into view on `/`.
 *
 * `panic` is a screen tab: the `/panic` screen hosts the console's Emergency
 * panel, so a shared `tab=panic` lands on the emergency view either way.
 */
export const URL_TABS = [
  "console",
  "fleet",
  "configure",
  "deploy",
  "panic",
  "status",
  "txhistory",
  "telemetry",
  "multisig",
  "xdr",
] as const;

/** A tab the URL can name — a screen or a console panel (see {@link URL_TABS}). */
export type UrlTab = (typeof URL_TABS)[number];

/**
 * Screen tab → route. Panels are absent by design: `routeForTab` returning
 * `null` is what tells a caller "this tab lives on the console".
 */
const SCREEN_ROUTES: Readonly<Record<string, string>> = {
  console: "/",
  fleet: "/fleet",
  configure: "/configure",
  deploy: "/deploy",
  panic: "/panic",
};

/** The verdict filter's three values, mirroring `VerdictFilter` in `telemetryExport.ts`. */
const VERDICT_FILTERS: readonly VerdictFilter[] = ["all", "allowed", "blocked"];

/**
 * A validated view state. Every field is optional: absent means "this URL
 * never said", and the console falls back to its normal default. Fields that
 * are present are guaranteed to have passed validation — `decodeUrlState` is
 * the only reader of the query string, and it never returns anything else.
 *
 * Each field also accepts an explicit `undefined` (`exactOptionalPropertyTypes`:
 * `field?: T | undefined`), which is the merge protocol's way of saying
 * "remove this parameter" — see {@link mergeUrlState}.
 */
export interface UrlState {
  /** Guard (contract) address. Validated as `C` + 55 base32 characters. */
  guard?: string | undefined;
  /** Network name; only this build's network validates. */
  network?: string | undefined;
  /** Active tab — a screen or a console panel (see {@link URL_TABS}). */
  tab?: UrlTab | undefined;
  /** Telemetry verdict filter preset (`all` is encoded away as the default). */
  filter?: VerdictFilter | undefined;
}

function isUrlTab(value: string): value is UrlTab {
  return (URL_TABS as readonly string[]).includes(value);
}

function isKnownNetwork(value: string): boolean {
  // Single-network build: the one name that validates is the one the console
  // runs against. Case-insensitive, because a hand-edited `?network=TESTNET`
  // states the right intent and costs nothing to accept.
  return value === NETWORK.name.toLowerCase();
}

function isVerdictFilter(value: string): value is VerdictFilter {
  return (VERDICT_FILTERS as readonly string[]).includes(value);
}

/**
 * Read a view state out of a search string. Strictly validating: each of the
 * four parameters is checked against its own vocabulary and silently dropped
 * when it fails — `?guard=<script>` and `?tab=bogus` decode to "not said",
 * not to the raw string.
 *
 * Takes any search-shaped input (`"?a=b"`, `"a=b"`, `""`) because
 * `URLSearchParams` does.
 */
export function decodeUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const state: UrlState = {};

  const guard = params.get(URL_STATE_PARAMS.guard)?.trim();
  if (guard !== undefined && looksLikeContractAddress(guard)) state.guard = guard;

  const network = params.get(URL_STATE_PARAMS.network)?.trim().toLowerCase();
  if (network !== undefined && isKnownNetwork(network)) state.network = network;

  const tab = params.get(URL_STATE_PARAMS.tab)?.trim().toLowerCase();
  if (tab !== undefined && isUrlTab(tab)) state.tab = tab;

  const filter = params.get(URL_STATE_PARAMS.filter)?.trim().toLowerCase();
  if (filter !== undefined && isVerdictFilter(filter)) state.filter = filter;

  return state;
}

/**
 * Render a view state as a query string (no leading `?`), in the canonical
 * order `guard → network → tab → filter`, omitting absent fields and the
 * default `filter: "all"`.
 *
 * Invalid values are dropped rather than thrown: encoding is also the last
 * line of validation before a string reaches the address bar, and a URL that
 * renders one parameter short is still a correct URL.
 */
export function encodeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.guard !== undefined && looksLikeContractAddress(state.guard)) {
    params.set(URL_STATE_PARAMS.guard, state.guard.trim());
  }
  if (state.network !== undefined && isKnownNetwork(state.network.toLowerCase())) {
    params.set(URL_STATE_PARAMS.network, state.network.trim().toLowerCase());
  }
  if (state.tab !== undefined && isUrlTab(state.tab)) {
    params.set(URL_STATE_PARAMS.tab, state.tab);
  }
  if (
    state.filter !== undefined &&
    isVerdictFilter(state.filter) &&
    state.filter !== "all" // the default stays out of a clean URL
  ) {
    params.set(URL_STATE_PARAMS.filter, state.filter);
  }
  return params.toString();
}

/** True when `key` is one of the four parameters this module owns. */
function isOwnedParam(key: string): boolean {
  return (Object.values(URL_STATE_PARAMS) as string[]).includes(key);
}

/**
 * Fold a partial update into an existing search string.
 *
 * The merge is what makes concurrent owners safe — the provider writes
 * `guard`/`network`/`tab` while the telemetry feed writes `filter`, and each
 * write leaves the other's parameters exactly as they were:
 *
 *   - owned parameters not mentioned by `partial` keep their *validated*
 *     current value — a malformed one already in the URL is dropped here,
 *     which is how a shared link gets cleaned without the writer knowing
 *     what was wrong with it;
 *   - an owned parameter mentioned in `partial` takes the new value, and
 *     `undefined` (or a value that encodes away, like `filter: "all"`)
 *     deletes it;
 *   - every other parameter passes through untouched, in its original order.
 */
export function mergeUrlState(search: string, partial: UrlState): string {
  const merged = new URLSearchParams(encodeUrlState({ ...decodeUrlState(search), ...partial }));
  for (const [key, value] of new URLSearchParams(search)) {
    if (isOwnedParam(key)) continue;
    merged.append(key, value);
  }
  return merged.toString();
}

/**
 * Mirror a view state into the address bar — `history.replaceState`, never a
 * navigation, so no state is lost and no reload runs (issue #132's "without
 * unnecessary page reloads"). No-op during server rendering and when nothing
 * would change.
 *
 * The current URL is merged first, so a write of one parameter never drops
 * another: guarding here, filtering there, and a `?demo=true` the operator
 * opened with all survive each other's writes.
 */
export function writeUrlState(partial: UrlState): void {
  if (typeof window === "undefined") return;
  const search = mergeUrlState(window.location.search, partial);
  const next =
    search.length > 0
      ? `${window.location.pathname}?${search}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  window.history.replaceState(window.history.state, "", next);
}

/**
 * The screen tab a pathname is on. Unknown pathnames fall back to `console`
 * rather than inventing a tab a URL could not validate.
 */
export function tabForPathname(pathname: string): UrlTab {
  for (const [tab, route] of Object.entries(SCREEN_ROUTES)) {
    if (route === pathname) return tab as UrlTab;
  }
  return "console";
}

/**
 * The route a screen tab restores to, or `null` for a console panel tab —
 * a panel lives on `/`, and restoring one is the console page's job.
 */
export function routeForTab(tab: UrlTab): string | null {
  return SCREEN_ROUTES[tab] ?? null;
}

/**
 * Validation result for a URL state parameter.
 */
export type ParamValidation<T> =
  | { status: "valid"; value: T }
  | { status: "malformed"; raw: string; reason: string }
  | { status: "conflicting"; requested: T; current: T }
  | { status: "ambiguous"; values: T[] }
  | { status: "absent" };

/**
 * Validation result for the complete URL state.
 */
export interface UrlStateValidation {
  guard: ParamValidation<string>;
  network: ParamValidation<string>;
  tab: ParamValidation<UrlTab>;
  filter: ParamValidation<VerdictFilter>;
  /** True when any parameter was malformed, ambiguous, or conflicting. */
  hasIssues: boolean;
}

/**
 * Validate the guard parameter.
 */
function validateGuard(raw: string | null | undefined, current?: string): ParamValidation<string> {
  if (raw === null || raw === undefined || raw.trim() === "") return { status: "absent" };
  const trimmed = raw.trim();
  if (!trimmed.startsWith("C"))
    return { status: "malformed", raw: trimmed, reason: "contract address must start with 'C'" };
  if (trimmed.length < 56)
    return { status: "malformed", raw: trimmed, reason: "contract address too short" };
  if (trimmed.length > 56)
    return { status: "malformed", raw: trimmed, reason: "contract address too long" };
  if (!looksLikeContractAddress(trimmed))
    return { status: "malformed", raw: trimmed, reason: "invalid base32 encoding" };
  if (current !== undefined && trimmed !== current)
    return { status: "conflicting", requested: trimmed, current };
  return { status: "valid", value: trimmed };
}

/**
 * Validate the network parameter.
 */
function validateNetwork(
  raw: string | null | undefined,
  current?: string,
): ParamValidation<string> {
  if (raw === null || raw === undefined || raw.trim() === "") return { status: "absent" };
  const trimmed = raw.trim().toLowerCase();
  if (!isKnownNetwork(trimmed))
    return { status: "malformed", raw: trimmed, reason: "unknown network" };
  if (current !== undefined && trimmed !== current)
    return { status: "conflicting", requested: trimmed, current };
  return { status: "valid", value: trimmed };
}

/**
 * Validate the tab parameter.
 */
function validateTab(raw: string | null | undefined, current?: UrlTab): ParamValidation<UrlTab> {
  if (raw === null || raw === undefined || raw.trim() === "") return { status: "absent" };
  const trimmed = raw.trim().toLowerCase() as UrlTab;
  if (!isUrlTab(trimmed)) return { status: "malformed", raw: trimmed, reason: "unknown tab" };
  if (current !== undefined && trimmed !== current)
    return { status: "conflicting", requested: trimmed, current };
  return { status: "valid", value: trimmed };
}

/**
 * Validate the filter parameter.
 */
function validateFilter(
  raw: string | null | undefined,
  current?: VerdictFilter,
): ParamValidation<VerdictFilter> {
  if (raw === null || raw === undefined || raw.trim() === "") return { status: "absent" };
  const trimmed = raw.trim().toLowerCase() as VerdictFilter;
  if (!isVerdictFilter(trimmed))
    return { status: "malformed", raw: trimmed, reason: "unknown filter" };
  if (current !== undefined && trimmed !== current)
    return { status: "conflicting", requested: trimmed, current };
  return { status: "valid", value: trimmed };
}

function checkAmbiguousGuards(values: string[]): ParamValidation<string> | null {
  if (values.length <= 1) return null;
  const unique = [...new Set(values)];
  if (unique.length > 1) return { status: "ambiguous", values: unique };
  return null;
}

function checkAmbiguousNetworks(values: string[]): ParamValidation<string> | null {
  if (values.length <= 1) return null;
  const unique = [...new Set(values)];
  if (unique.length > 1) return { status: "ambiguous", values: unique };
  return null;
}

function checkAmbiguousTabs(values: string[]): ParamValidation<UrlTab> | null {
  if (values.length <= 1) return null;
  const unique = [...new Set(values)];
  if (unique.length > 1) return { status: "ambiguous", values: unique as UrlTab[] };
  return null;
}

function checkAmbiguousFilters(values: string[]): ParamValidation<VerdictFilter> | null {
  if (values.length <= 1) return null;
  const unique = [...new Set(values)];
  if (unique.length > 1) return { status: "ambiguous", values: unique as VerdictFilter[] };
  return null;
}

/**
 * Validate all four URL state parameters from a search string, returning
 * detailed results for each so the UI can surface clear messages when
 * a parameter is rejected.
 */
export function validateUrlState(search: string, current?: Partial<UrlState>): UrlStateValidation {
  const params = new URLSearchParams(search);

  const tabVocabulary = new Set(URL_TABS);
  const filterVocabulary = new Set(VERDICT_FILTERS);

  const guardRaw = params.get(URL_STATE_PARAMS.guard)?.trim();
  const networkRaw = params.get(URL_STATE_PARAMS.network)?.trim().toLowerCase();
  const tabRaw = params.get(URL_STATE_PARAMS.tab)?.trim().toLowerCase();
  const filterRaw = params.get(URL_STATE_PARAMS.filter)?.trim().toLowerCase();

  // Check for ambiguous (duplicate) parameters
  const allGuards = params
    .getAll(URL_STATE_PARAMS.guard)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const allNetworks = params
    .getAll(URL_STATE_PARAMS.network)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  const allTabs = params
    .getAll(URL_STATE_PARAMS.tab)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  const allFilters = params
    .getAll(URL_STATE_PARAMS.filter)
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);

  const guardAmbiguous = checkAmbiguousGuards(allGuards);
  const networkAmbiguous = checkAmbiguousNetworks(allNetworks);
  const tabAmbiguous = checkAmbiguousTabs(allTabs);
  const filterAmbiguous = checkAmbiguousFilters(allFilters);

  const guard = guardAmbiguous ?? validateGuard(guardRaw, current?.guard);
  const network = networkAmbiguous ?? validateNetwork(networkRaw, current?.network);
  const tab = tabAmbiguous ?? validateTab(tabRaw, current?.tab);
  const filter = filterAmbiguous ?? validateFilter(filterRaw, current?.filter);

  const hasIssues = [guard, network, tab, filter].some(
    (p) => p.status !== "valid" && p.status !== "absent",
  );

  return { guard, network, tab, filter, hasIssues };
}
