"use client";

/**
 * The console's client-side state: the wallet, the selected guard, a polled
 * snapshot of that guard, and the event feed.
 *
 * Two rules shape this provider, and both come from the same commitment — the
 * interface must never show a number it did not read from the chain:
 *
 *   1. A failed read is stored as an error, never as a default. `snapshot` keeps
 *      each field's own success/failure, and the panels render the failure.
 *   2. The feed is fed from two clearly-labelled sources. Ledger events are
 *      settled history; diagnostic events come from a refused write this console
 *      performed, and are labelled as such, because a rolled-back event is
 *      evidence of a refusal rather than of state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { rpc } from "@stellar/stellar-sdk";
import { createServer } from "../lib/guard/chain.ts";
import { readGuardSnapshot, type GuardSnapshot } from "../lib/guard/guardOps.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { POLLING, jitteredInterval, startRefreshTimer } from "../lib/guard/polling.ts";
import {
  FEED_SWITCH_HISTORY_LEDGERS,
  GuardFeed,
  GuardFeedCoordinator,
  clearStreamRows,
  emptyStreamBuffer,
  historicalBuffer,
  ingestEvents,
  pauseStream as pauseBuffer,
  resumeStream as resumeBuffer,
  type StreamBuffer,
  type TelemetryEvent,
} from "../lib/guard/telemetry.ts";
import {
  FEED_GUARD_CAP,
  MultiGuardFeed,
  feedGapNotices,
  type FeedGapNotice,
  type FeedSource,
} from "../lib/guard/feedSubscriptions.ts";
import {
  loadTailSelection,
  planTailSources,
  prunePinned,
  saveTailSelection,
} from "../lib/guard/feedSelection.ts";
import { POLL_OFF, pollHealth, type PollHealth } from "../lib/guard/feedHealth.ts";
import {
  createRegistryAnnouncer,
  createRegistryChangeFilter,
  createTabSync,
  type TabSyncEventType,
} from "../lib/guard/tabSync.ts";
import { resolveGuardFromSearch } from "../lib/guard/deeplink.ts";
import {
  decodeUrlState,
  routeForTab,
  tabForPathname,
  writeUrlState,
} from "../lib/guard/urlState.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { clearGuardScopedState } from "../lib/guard/guardScoped.ts";
import {
  KNOWN_INSTANCES,
  defaultGuard,
  loadInstances,
  removeInstance as removeSavedInstance,
  renameInstance as renameSavedInstance,
  type GuardInstance,
} from "../lib/guard/instance.ts";
import { addGuard, fallbackAfterRemoval, registryAfterChange } from "../lib/guard/registry.ts";
import { readStatus, readPolicy, readWindow, verifyWasmIdentity } from "../lib/guard/chain.ts";
import { currentAddress, freighterSigner, type ConnectedWallet } from "../lib/guard/wallet.ts";
import {
  WalletNotInstalledError,
  canReconnectSilently,
  connectorSigner,
  createWalletConnector,
  detectInstalledProviders,
  loadPreferredProvider,
  readWalletScope,
  savePreferredProvider,
  type WalletConnector,
  type WalletProviderId,
} from "../lib/guard/walletConnector.ts";
import {
  detectNetworkMismatch,
  loadFreighterNetworkApi,
  requestFreighterNetworkSwitch,
  type NetworkMismatch,
  type NetworkSwitchOutcome,
} from "../lib/guard/networkSwitch.ts";
import { isObserverSession, readSourceFor } from "../lib/guard/observerMode.ts";
import { memoryWiper } from "../lib/guard/memoryWiper.ts";
import type { WalletSigner } from "../lib/guard/submit.ts";
import {
  useIdleTimer,
  loadIdleTimeoutMs,
  saveIdleTimeoutMs,
  type IdleState,
} from "../lib/guard/useIdleTimer.ts";
import {
  DEMO_BASE_LEDGER,
  DEMO_GUARD,
  DEMO_INSTANCE,
  demoEvents,
  demoFlagFromQuery,
  demoSnapshot,
  isDemoMode,
  syntheticDemoEvent,
} from "../lib/guard/demoFixtures.ts";
import {
  resolvePreset,
  validateRange,
  type RangePreset,
  type TimeRange,
} from "../lib/guard/ledgerTime.ts";

const SNAPSHOT_INTERVAL_MS = jitteredInterval(POLLING.snapshotMs);
const FEED_INTERVAL_MS = jitteredInterval(POLLING.feedMs);

/** The individually-read fields of a guard snapshot (issue #36 retry keys). */
export type SnapshotField = "status" | "policy" | "window" | "identity";

/** Display labels for the historical-range presets, mirroring `ledgerTime.ts`. */
const RANGE_PRESET_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
  "1h": "last 1 hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
};

/**
 * The raw liveness inputs for one tab's tail (#311).
 *
 * Kept as its own state object, separate from the event buffer, because the two
 * answer different questions: this one answers "is the poller alive", and the
 * buffer answers "what did the guard do". A round that returned zero events moves
 * `lastSuccessAt` forward and leaves `eventsInLastRound` at 0 — that combination
 * is the state this issue is about, and it only survives if the two are stored
 * apart.
 */
interface PollRaw {
  /** A round is in flight right now. */
  polling: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  error: string | null;
  eventsInLastRound: number;
}

const INITIAL_POLL: PollRaw = {
  polling: false,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastFailureAt: null,
  error: null,
  eventsInLastRound: 0,
};

export interface GuardContextValue {
  server: rpc.Server;
  wallet: ConnectedWallet | null;
  walletError: string | null;
  connecting: boolean;
  /** Connect with an explicit provider, or with the one the operator last chose. */
  connect: (provider?: WalletProviderId) => Promise<void>;
  disconnect: () => void;
  /** A signer for the connected wallet, or a thrown error explaining why not. */
  signer: () => WalletSigner;
  /** The wallet this session connected through, once it has. */
  providerId: WalletProviderId | null;
  /** Wallets this browser can actually serve, probed without prompting. */
  availableProviders: WalletProviderId[];
  /** True while nobody is signing: reads work, writes are refused. */
  observer: boolean;
  /** The wallet/dashboard network disagreement, if there is one. */
  networkMismatch: NetworkMismatch | null;
  /** Ask the wallet to move to this dashboard's network; null when declined. */
  switchNetwork: () => Promise<NetworkSwitchOutcome | null>;
  instances: GuardInstance[];
  /** The active guard address. Every read/write derives from this, never a constant. */
  guard: string;
  /** The active instance (address + network + label), or null if it is not saved. */
  activeInstance: GuardInstance | null;
  selectGuard: (guard: string) => void;
  /**
   * Validate and live-verify an address, then save it and switch to it (#22).
   * Resolves with `{ ok: false, error }` rather than throwing, so the caller can
   * render an inline error beside the input.
   */
  addInstance: (guard: string, label: string) => Promise<{ ok: boolean; error?: string }>;
  /** Delete an operator-saved guard, clearing the state scoped to it. */
  removeInstance: (guard: string) => void;
  /** Rename a saved guard (a known instance gets a saved override). */
  renameInstance: (guard: string, label: string) => void;
  snapshot: GuardSnapshot | null;
  snapshotError: string | null;
  refreshing: boolean;
  /** Last successful chain read refresh timestamp (ms since epoch). */
  lastRefresh: number | null;
  refresh: () => Promise<void>;
  /**
   * Per-read retry (issue #36, #386): re-invoke ONLY one failed snapshot read.
   *
   * Bound to the guard/network context it started in: when the active guard or
   * the RPC server changes while the re-read is in flight, the late response
   * belongs to a world the operator has left and is discarded — no merge, no
   * announcement — instead of painting over the new context's view.
   */
  retryRead: (field: SnapshotField) => Promise<void>;
  /** The snapshot field currently re-reading, if any. */
  retryingField: SnapshotField | null;
  feed: {
    watching: boolean;
    latestLedger: number | null;
    error: string | null;
    /** ISO time of the last poll *attempt*. Not a success claim — see `health`. */
    lastPolledAt: string | null;
    /** The guards currently tailed (up to `FEED_GUARD_CAP`), with their labels. */
    guards: FeedSource[];
    /** How many registry entries the cap is excluding right now. */
    capped: number;
    /** Labels of the excluded guards, so the cap can be named, not just counted. */
    cappedLabels: string[];
    /**
     * Poll liveness, kept apart from whether events arrived (#311). Derived from
     * the last successful round, the in-flight flag and the last failure — never
     * from the row count, so a quiet guard reads as healthy rather than broken.
     */
    health: PollHealth;
    /**
     * Guards whose feed has a known hole or an unsettled position. Empty does
     * not mean complete — only that no discontinuity has been detected.
     */
    gaps: FeedGapNotice[];
  };
  startWatching: () => void;
  stopWatching: () => void;
  /**
   * The guards the operator chose to spend feed capacity on (#310), in their own
   * order. The guard on screen is always tailed regardless, and the remaining
   * slots fill from the registry.
   */
  tailSelection: string[];
  /** Add or remove one guard from the tailed set, then re-tail immediately. */
  toggleTailedGuard: (guard: string) => void;
  /**
   * Stream display controls. Pausing freezes the table while polling carries on
   * in the background; new events queue until resume.
   */
  stream: {
    paused: boolean;
    pendingCount: number;
    /** Queued events that fell past the buffer limit during a long pause. */
    dropped: number;
  };
  pauseStream: () => void;
  resumeStream: () => void;
  /** Empty the visible list. The poll cursor and any queued events are kept. */
  clearEvents: () => void;
  /** Surface refused-write diagnostics in the feed, labelled as diagnostics. */
  pushEvents: (events: TelemetryEvent[]) => void;
  /**
   * Query the feed's guard over a historical time range (#148). Replaces the
   * live view with the window's events and labels it, so a historical result
   * is never mistaken for the live tail. In demo mode the window is answered
   * from the fixtures, since demo mode never touches RPC.
   */
  queryRange: (range: TimeRange, preset: RangePreset) => Promise<void>;
  /** Human-readable label of the range currently displayed, or null when live. */
  rangeLabel: string | null;
  /**
   * The bounds of the range currently displayed, or null when the feed is on the
   * live tail. #309: an export preview must name the range it applied, and a label
   * like "Last 24 Hours" is not a bound — this is the same `TimeRange` that was
   * queried, so the preview and the rows on screen cannot disagree.
   */
  exportRange: TimeRange | null;
  /**
   * Tell the other open tabs that this one changed something. The provider adds
   * the active guard, so callers only name the change.
   */
  /**
   * Tell the other tabs something changed. `guard` names the guard the change was
   * made to; it defaults to the active one, which is wrong for a write that
   * settled after the operator had moved on.
   */
  notifyTabs: (
    type: TabSyncEventType,
    options?: { guard?: string; payload?: Record<string, unknown> },
  ) => void;
  /** Operator session auto-lock state and its configuration. */
  session: {
    state: IdleState;
    timeoutMs: number;
    setTimeoutMs: (valueMs: number) => void;
    stayConnected: () => void;
  };
}

const GuardContext = createContext<GuardContextValue | null>(null);

/**
 * The event feed lives in its own context, deliberately separate from the
 * console's general state.
 *
 * The feed is the only high-churn state here: batches arrive on every poll (or,
 * under the #114 benchmark's seam, on every animation frame), and if `events`
 * rode along on `GuardContext` then every value's identity would change with
 * every batch — re-rendering the wallet bar, status panel, panic panel and the
 * rest for a change only the telemetry table can see. Splitting the feed out
 * keeps the cost of a batch proportional to the one panel that renders it.
 * Only `TelemetryFeed` subscribes.
 */
const GuardEventsContext = createContext<TelemetryEvent[] | null>(null);

export function GuardProvider({
  children,
  server: serverOverride,
}: {
  children: ReactNode;
  /**
   * Test seam: the RPC server the console reads through. Production callers omit
   * it and get one bound to the build's network; the provider test injects a
   * controllable server to drive the stale-read race deterministically.
   */
  server?: rpc.Server;
}) {
  const server = useMemo(() => serverOverride ?? createServer(NETWORK.rpcUrl), [serverOverride]);
  // The cross-tab coordinator. It is transport-agnostic (BroadcastChannel with a
  // localStorage fallback) and inert where neither exists, so the provider never
  // branches on availability. Created once per tab.
  const tabSync = useMemo(() => createTabSync(), []);
  // Registry changes made here are announced to the other tabs, and the ones
  // they announce are filtered through a per-tab replay guard. Each is created
  // once per tab, so a re-render can never register a second listener or reset
  // the revision counter that duplicate suppression depends on.
  const announceRegistry = useMemo(() => createRegistryAnnouncer(tabSync), [tabSync]);
  const registryChangeFilter = useMemo(() => createRegistryChangeFilter(), []);
  // Demo mode is settled synchronously from the build-time flag, then re-checked
  // for `?demo=true` in an effect — the query string is not visible during SSR,
  // and reading it during render would desynchronise hydration.
  const [demo, setDemo] = useState<boolean>(() => isDemoMode());
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The wallet scope is read once per tab: an injected `window.xbull` does not
  // appear mid-session, and re-probing on every render would mean a popup.
  const scope = useMemo(() => readWalletScope(), []);
  const [providerId, setProviderId] = useState<WalletProviderId | null>(() =>
    loadPreferredProvider(),
  );
  const [availableProviders, setAvailableProviders] = useState<WalletProviderId[]>([]);
  const [networkMismatch, setNetworkMismatch] = useState<NetworkMismatch | null>(null);
  // The connector that produced the current session. Kept in a ref because a
  // re-render must never rebuild it — a fresh connector has not been granted
  // access, and rebuilding on render would prompt the operator again.
  const connectorRef = useRef<WalletConnector | null>(null);
  const [instances, setInstances] = useState<GuardInstance[]>(() =>
    isDemoMode() ? [DEMO_INSTANCE] : [...KNOWN_INSTANCES],
  );
  const [guard, setGuard] = useState<string>(() => {
    if (typeof window !== "undefined") {
      // The shared link's guard, validated before it becomes state: a
      // malformed or unsafe address is rejected here, not adopted (issue #132).
      const shared = decodeUrlState(window.location.search).guard;
      if (shared) return shared;
    }
    return isDemoMode() ? DEMO_GUARD : defaultGuard();
  });
  const [snapshot, setSnapshot] = useState<GuardSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  // Per-read retry state (issue #36): which single field is re-reading. Only
  // one retry is in flight at a time — the same in-flight discipline the panel
  // refresh button follows — and a retry never touches the other fields.
  const [retryingField, setRetryingField] = useState<SnapshotField | null>(null);
  const [buffer, setBuffer] = useState<StreamBuffer>(emptyStreamBuffer);
  const [rangeLabel, setRangeLabel] = useState<string | null>(null);
  const [exportRange, setExportRange] = useState<TimeRange | null>(null);
  // #310: the operator's chosen tail set, read once from this network's bucket.
  const [tailSelection, setTailSelection] = useState<string[]>(() => loadTailSelection());
  // Poll liveness (#311), held apart from the event buffer so the two can never
  // be confused by a later edit. `lastSuccessAt` is written ONLY by a round that
  // returned; the attempt stamp lives on `feed.lastPolledAt`.
  const [poll, setPoll] = useState<PollRaw>(INITIAL_POLL);
  const [feed, setFeed] = useState<Omit<GuardContextValue["feed"], "health">>({
    watching: false,
    latestLedger: null,
    error: null,
    lastPolledAt: null,
    guards: [],
    capped: 0,
    cappedLabels: [],
    gaps: [],
  });

  /**
   * The two event resets, declared beside the state they reset.
   *
   * `clearEvents` empties the table but keeps the dedupe set, so a poll cannot
   * re-deliver what the operator just cleared. `resetEvents` drops the set too —
   * required whenever the *guard* changes, or the new account's events would be
   * swallowed as already-seen. Both are declared here rather than with the rest
   * of the feed wiring because the deep-link effect below adopts a different
   * guard before that wiring is reached.
   */
  const clearEvents = useCallback(() => {
    setBuffer(clearStreamRows);
    setRangeLabel(null);
    setExportRange(null);
  }, []);
  const resetEvents = useCallback(() => {
    setBuffer(emptyStreamBuffer());
    setRangeLabel(null);
    setExportRange(null);
  }, []);

  // The active feed is reached only through an identity-keyed coordinator, so a
  // guard switch can never resume the previous guard's cursor onto a different
  // stream — the coordinator replaces the feed, it does not re-point it. The
  // ref holds the coordinator itself; losing it on re-render would drop cursors.
  const feedRef = useRef<GuardFeedCoordinator<GuardFeed> | null>(null);
  if (!feedRef.current) {
    feedRef.current = new GuardFeedCoordinator((guardId: string) => new GuardFeed(server, guardId));
  }
  // The multi-guard supervisor fans the tail out across the registry (#23): one
  // listener per tailed guard, capped, reconciled whenever the registry changes.
  // It is layered *over* the coordinator rather than replacing it, so each guard
  // still gets an identity-keyed, cursor-preserving feed from the coordinator
  // while the supervisor owns the set. Both live in refs so a re-render can never
  // reset a cursor and silently re-deliver events.
  const multiFeedRef = useRef<MultiGuardFeed | null>(null);
  // The freshest ledger head this tab has observed from any feed's polls.
  // Ledgers are chain-global, so a head learned while watching guard A is the
  // valid priming point for guard B's history window (FEED_SWITCH_HISTORY_LEDGERS).
  const knownLedgerRef = useRef<number | null>(null);

  /**
   * Drop every guard-scoped feed cursor at once.
   *
   * Both layers must go together: the supervisor holds references to feeds the
   * coordinator created, so clearing only the coordinator would leave it polling
   * orphans whose cursors are no longer the ones this tab is allowed to resume.
   */
  const dropFeedState = useCallback(() => {
    multiFeedRef.current?.stopAll();
    multiFeedRef.current = null;
    feedRef.current = null;
  }, []);

  /**
   * The guards to tail, in the order that decides who gets the capped slots.
   *
   * The active guard leads so the cap can never exclude the account on screen —
   * a full registry must not starve the one the operator is looking at. After it
   * come the guards the operator *chose* (#310), then the rest of the registry.
   * `MultiGuardFeed.sync()` keeps the first `cap` sources it is handed, so this
   * ordering is what makes selection authoritative rather than incidental: with
   * plain registry order the five oldest saved guards were tailed by accident,
   * and a guard added last — often the one being investigated — sat outside the
   * feed with nothing on screen to say so.
   */
  const feedSources = useMemo<FeedSource[]>(() => {
    const registry: FeedSource[] = instances.map((instance) => ({
      guard: instance.guard,
      label: instance.label,
    }));
    return planTailSources({
      registry,
      active: guard,
      pinned: tailSelection,
      cap: FEED_GUARD_CAP,
    }).ordered;
  }, [guard, instances, tailSelection]);
  // The active guard, readable from the (long-lived) sync listener without
  // re-subscribing on every guard change.
  const guardRef = useRef(guard);

  useEffect(() => {
    guardRef.current = guard;
  }, [guard]);

  // Demo mode, readable from the long-lived sync listener for the same reason.
  const demoRef = useRef(demo);
  useEffect(() => {
    demoRef.current = demo;
  }, [demo]);

  // Monotonic read epoch: bumped whenever the active guard changes. A read that
  // started under guard A and resolves after the switch to B is dropped instead
  // of painted, because it belongs to a world the operator has left. This is the
  // abort/ignore-stale pattern the issue's concurrency test pins; without it the
  // slower of two overlapping `refresh()` calls wins the `setSnapshot` race.
  const readEpochRef = useRef(0);

  // A change of RPC server (the test seam, and any future network switch) is a
  // context change for every in-flight read, exactly like a guard switch: the
  // epoch moves so a read issued against the old server is discarded rather
  // than merged. On mount there is no previous server, so nothing is bumped.
  const lastServerRef = useRef(server);
  useEffect(() => {
    if (lastServerRef.current === server) return;
    lastServerRef.current = server;
    readEpochRef.current += 1;
  }, [server]);

  // The coordinator is deliberately never closed by an effect cleanup: React's
  // development StrictMode mount/unmount/mount cycle would close the channel on
  // the simulated unmount and leave the tab permanently unable to broadcast. The
  // provider lives as long as the document, and the browser closes the channel
  // with the page.

  useEffect(() => {
    // Demo mode pins the selector to the single fixture instance, so a value the
    // fixtures do not describe can never be selected. Leaving demo mode restores
    // the remembered instances.
    if (demo) {
      setInstances([DEMO_INSTANCE]);
      // Invalidate any in-flight read: switching worlds must not let the old
      // guard's status land in the fixture view.
      readEpochRef.current += 1;
      setGuard(DEMO_GUARD);
      return;
    }
    setInstances(loadInstances());
  }, [demo]);

  // `?demo=true` is only visible in the browser, so demo mode is settled here.
  useEffect(() => {
    if (demoFlagFromQuery(window.location.search)) setDemo(true);
    return memoryWiper.registerBrowserEvents();
  }, []);

  // Adopt the guard a link named, so a call to action that deep-links into the
  // configurator does not quietly show a *different* account's state: this page
  // mounts its own provider, which would otherwise fall back to the first known
  // instance. An address outside the registry is added to it for the session (not
  // persisted — a link is not the operator choosing to remember an instance), so
  // the selector always has an option matching the selection. Demo mode pins the
  // fixture instance and is left alone.
  useEffect(() => {
    if (demo) return;
    const registry = loadInstances();
    const requested = resolveGuardFromSearch({
      search: window.location.search,
      registry,
      current: guardRef.current,
    });
    if (!requested) return;
    setInstances(
      requested.addToRegistry
        ? [
            ...registry,
            {
              guard: requested.guard,
              label: `Guard ${requested.guard.slice(0, 6)}…${requested.guard.slice(-4)}`,
              network: NETWORK.name,
              addedAt: new Date().toISOString(),
              provenance: "Opened from a link in this browser.",
            },
          ]
        : registry,
    );
    setGuard(requested.guard);
    setSnapshot(null);
    setSnapshotError(null);
    resetEvents();
  }, [demo, resetEvents]);

  // ── Shareable-view URL state (issue #132) ──────────────────────────────
  // The address bar mirrors what the console shows — the guard and network
  // here, the active tab below — through `history.replaceState`, never a
  // navigation: a guard switch must not reload the page (a reload would drop
  // the in-memory feed, the connected session and any form draft). Because a
  // write merges into the current query and re-validates every owned
  // parameter, it also *cleans* a shared link: a malformed `?guard=` or
  // `?network=` that decode refused to adopt is dropped from the URL by this
  // first write, while unrelated parameters (`?demo=true`) pass through.
  useEffect(() => {
    writeUrlState({ guard, network: NETWORK.name });
  }, [guard]);

  // The active tab, in both directions. On the first run a tab the shared URL
  // already named is *preserved* — it is what the console page's restore reads
  // — and a screen tab that disagrees with the path wins by navigating to its
  // route, so `/?tab=fleet` restores the Fleet view. Every later run follows
  // navigation: whatever route the operator lands on is the active tab.
  const pathname = usePathname();
  const router = useRouter();
  const tabAdopted = useRef(false);
  useEffect(() => {
    if (!tabAdopted.current) {
      tabAdopted.current = true;
      const shared = decodeUrlState(window.location.search).tab;
      if (shared !== undefined) {
        const route = routeForTab(shared);
        // Panel tabs only mean something on the console; anywhere else the
        // path's own tab is the honest state.
        if (route !== null || pathname === "/") {
          writeUrlState({ tab: shared });
          if (route !== null && route !== pathname) router.replace(route);
          return;
        }
      }
    }
    writeUrlState({ tab: tabForPathname(pathname) });
  }, [pathname, router]);

  // In demo mode the feed is seeded and watching immediately: a visitor should
  // see realistic telemetry without having to click "Start watching" first. The
  // fixtures never touch RPC, so this cannot fire a chain read.
  useEffect(() => {
    if (!demo) return;
    setBuffer(ingestEvents(emptyStreamBuffer(), demoEvents(), { dedupe: false }));
    setFeed((current) => ({
      ...current,
      watching: true,
      latestLedger: DEMO_BASE_LEDGER,
      error: null,
    }));
  }, [demo]);

  // Which wallets this browser can serve, probed without prompting so the
  // selection modal can show what is installable rather than what is guessed.
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void detectInstalledProviders(scope).then((found) => {
      if (!cancelled) setAvailableProviders(found);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, demo]);

  // Pick up an already-authorized wallet without prompting for access again.
  // The network is read rather than assumed, so a wallet on the wrong network
  // cannot quietly enable writes after client-side navigation.
  useEffect(() => {
    if (demo) return;
    const preferred = loadPreferredProvider();
    if (!canReconnectSilently(preferred)) return;
    let cancelled = false;
    void (async () => {
      try {
        const id = preferred ?? "freighter";
        const connector = createWalletConnector(id, scope);
        const address = await connector.getPublicKey();
        if (!address || cancelled) return;
        const network = await connector.getNetwork();
        if (cancelled) return;
        const mismatch = detectNetworkMismatch(network.passphrase, NETWORK.passphrase, {
          targetNetwork: NETWORK.name,
          walletNetwork: network.name,
        });
        if (mismatch) {
          connectorRef.current = null;
          setWallet(null);
          setNetworkMismatch(mismatch);
          return;
        }
        connectorRef.current = connector;
        setProviderId(id);
        setNetworkMismatch(null);
        setWallet({
          address,
          networkPassphrase: network.passphrase,
          network: network.name,
        });
      } catch {
        // A wallet that is not installed is a normal state, not an error to show.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, scope]);

  const connect = useCallback(
    async (preferred?: WalletProviderId) => {
      const id = preferred ?? providerId ?? "freighter";
      setConnecting(true);
      setWalletError(null);
      setNetworkMismatch(null);
      try {
        const connector = createWalletConnector(id, scope);
        const connection = await connector.connect();
        const mismatch = detectNetworkMismatch(connection.network.passphrase, NETWORK.passphrase, {
          targetNetwork: NETWORK.name,
          walletNetwork: connection.network.name,
        });
        if (mismatch) {
          // The session stays unconnected on purpose. A wallet on another
          // network can be *read* with, but a signature it produces is for a
          // different transaction id, so offering it would be offering a
          // guaranteed failure.
          connectorRef.current = null;
          setWallet(null);
          setNetworkMismatch(mismatch);
          return;
        }
        connectorRef.current = connector;
        setProviderId(id);
        savePreferredProvider(id);
        setWallet({
          address: connection.address,
          networkPassphrase: connection.network.passphrase,
          network: connection.network.name,
        });
      } catch (error) {
        connectorRef.current = null;
        setWallet(null);
        setWalletError(
          error instanceof WalletNotInstalledError
            ? `${error.message} Setup guide: ${error.guideUrl}`
            : error instanceof Error
              ? error.message
              : String(error),
        );
      } finally {
        setConnecting(false);
      }
    },
    [providerId, scope],
  );

  /**
   * Ask the connected wallet to switch to this dashboard's network.
   *
   * Only Freighter exposes a switch request; for any other wallet the outcome
   * is `unsupported`, and the panel falls back to telling the operator which
   * setting to change rather than pretending the button did something.
   */
  const switchNetwork = useCallback(async (): Promise<NetworkSwitchOutcome | null> => {
    const api = await loadFreighterNetworkApi(scope.freighterLoader);
    const outcome = await requestFreighterNetworkSwitch({
      api,
      targetPassphrase: NETWORK.passphrase,
      targetNetwork: NETWORK.name,
    });
    if (outcome.kind === "switched") {
      setNetworkMismatch(null);
      setWalletError(null);
      await connect("freighter");
    }
    return outcome;
  }, [scope, connect]);

  const disconnect = useCallback(() => {
    connectorRef.current = null;
    setWallet(null);
    setNetworkMismatch(null);
    tabSync.broadcast("WALLET_DISCONNECTED", { guard: guardRef.current });
    memoryWiper.wipe();
  }, [tabSync]);

  const notifyTabs = useCallback(
    (type: TabSyncEventType, options?: { guard?: string; payload?: Record<string, unknown> }) => {
      tabSync.broadcast(type, {
        guard: options?.guard ?? guardRef.current,
        ...(options?.payload === undefined ? {} : { payload: options.payload }),
      });
    },
    [tabSync],
  );

  const signer = useCallback((): WalletSigner => {
    if (demo) {
      throw new Error(
        "Demo mode shows static fixture data, so writes are disabled. Unset " +
          "NEXT_PUBLIC_DEMO_MODE and drop ?demo=true to sign with a real wallet.",
      );
    }
    if (!wallet) {
      throw new Error(
        "This console is in observer mode: no admin wallet is connected, so nothing can be signed. " +
          "Connect the admin wallet to perform this action.",
      );
    }
    // The connector that opened the session signs with it. The Freighter
    // fallback covers the silent reconnect on page load, where an address was
    // read from an already-authorized extension without a connector being built.
    const connector = connectorRef.current;
    if (connector) return connectorSigner(connector, wallet.address, NETWORK.passphrase);
    return freighterSigner(wallet.address, NETWORK.passphrase);
  }, [wallet, demo]);

  const refresh = useCallback(async () => {
    if (!guard) return;
    // Capture the epoch this read belongs to. If the operator switches guard
    // while it is in flight, `readEpochRef` moves on and the result below is
    // discarded — guard A's status must never paint over guard B's view.
    const epoch = readEpochRef.current;
    setRefreshing(true);
    try {
      // In demo mode the snapshot is a fixture, so no read (and no failure) is
      // possible; outside demo mode this is unchanged and always hits the chain.
      // The source account falls back to a known testnet address while
      // observing, because a read-only simulation needs a payer but is never
      // charged and mutates nothing.
      const next = demo
        ? demoSnapshot()
        : await readGuardSnapshot(server, guard, readSourceFor(wallet));
      if (epoch !== readEpochRef.current) return;
      setSnapshot(next);
      setSnapshotError(null);
      setLastRefresh(Date.now());
    } catch (error) {
      if (epoch !== readEpochRef.current) return;
      // A transport failure is not the guard's state: report it as a failure and
      // drop the previous snapshot rather than leaving stale numbers on screen.
      setSnapshot(null);
      setSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      if (epoch === readEpochRef.current) setRefreshing(false);
    }
  }, [guard, server, wallet, demo]);

  // The sync listener below is installed once, but `refresh` changes identity
  // with the guard and wallet, so it reaches it through a ref rather than
  // forcing a re-subscription (and a possible missed event) on every change.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  /**
   * Re-run exactly one snapshot read (issue #36, #386).
   *
   * Discrete reads get discrete retries: retrying `status` must not re-invoke
   * `policy`, `window` or `identity` — the operator's per-read error report
   * names one failed read, and the fix re-reads that one. The other fields stay
   * exactly as they are, including their own failures, so the panel never
   * blanks a good value because a sibling read failed. Re-entry follows the
   * render triple: the failed read shows its error block, then a pending
   * skeleton while the re-read is in flight, then the value or the error again
   * (with the retry still available — a failing retry is not a dead end).
   *
   * The retry is bound to the context it started in (#386): the read epoch is
   * captured before the network call, and a retry that resolves after the
   * active guard or the RPC server changed is discarded whole — its result is
   * neither merged into the snapshot nor announced, because "policy read
   * recovered" about a guard the operator is no longer looking at is noise at
   * best and a lie about the current view at worst.
   */
  const retryRead = useCallback(
    async (field: SnapshotField) => {
      if (!guard || retryingField !== null) return; // one in flight at a time
      const epoch = readEpochRef.current;
      setRetryingField(field);
      try {
        const failure = (error: unknown): { ok: false; error: string } => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        let next:
          | GuardSnapshot["status"]
          | GuardSnapshot["policy"]
          | GuardSnapshot["window"]
          | GuardSnapshot["identity"];
        switch (field) {
          case "status":
            next = await readStatus(server, guard, wallet?.address).catch(failure);
            break;
          case "policy":
            next = await readPolicy(server, guard, wallet?.address).catch(failure);
            break;
          case "window":
            next = await readWindow(server, guard).catch(failure);
            break;
          case "identity":
            next = await verifyWasmIdentity(server, guard)
              .then((value): GuardSnapshot["identity"] => ({ ok: true, value }))
              .catch(failure);
            break;
        }
        // Discard a late response: the guard or the RPC server changed while
        // this read was in flight, so the result belongs to a context the
        // operator has left. Nothing is merged and nothing is announced.
        if (epoch !== readEpochRef.current) return;
        // Merge only this field into the existing snapshot. A snapshot that has
        // been replaced wholesale (guard switch, full refresh) since the retry
        // started is left alone: the retry result is for a guard this panel may
        // no longer be showing.
        setSnapshot((current) =>
          current && current.guard === guard ? { ...current, [field]: next } : current,
        );
        announce(
          next.ok ? `${field} read recovered` : `${field} read failed again`,
          next.ok ? "polite" : "assertive",
        );
      } finally {
        setRetryingField(null);
      }
    },
    [guard, server, wallet?.address, retryingField],
  );

  // React to what the other tabs announce. Nothing crosses the wire as state:
  // `GUARD_CHANGED` carries an address to select, and the freeze/policy events
  // only prompt a re-read of the chain. Form drafts live in the panel's own
  // component state, so a remote refresh can never overwrite an edit in progress.
  useEffect(() => {
    return tabSync.subscribe((event) => {
      switch (event.type) {
        case "GUARD_CHANGED": {
          const next = event.guard;
          if (!next || next === guardRef.current) return;
          readEpochRef.current += 1;
          setGuard(next);
          setSnapshot(null);
          setSnapshotError(null);
          setBuffer(emptyStreamBuffer());
          // The feed cursor is guard-scoped: never carry the previous guard's
          // cursor into the new stream.
          dropFeedState();
          return;
        }
        case "FREEZE_STATE_CHANGED":
        case "POLICY_UPDATED":
          // Scope to the guard this tab is showing; an event about another
          // instance would only cause a pointless read.
          if (event.guard !== undefined && event.guard !== guardRef.current) return;
          void refreshRef.current();
          return;
        case "WALLET_DISCONNECTED":
          connectorRef.current = null;
          setWallet(null);
          setNetworkMismatch(null);
          return;
        case "REGISTRY_CHANGED": {
          // The announcement says only that the saved registry changed; the
          // list itself is re-read from storage here, never taken from the
          // message. Demo mode pins a single fixture instance and ignores it.
          if (demoRef.current) return;
          const notice = registryChangeFilter(event);
          if (notice === null) return;
          const saved = loadInstances();
          const activeGuard = guardRef.current;
          setInstances((current) => registryAfterChange({ saved, current, activeGuard, notice }));
          // The guard on screen was deleted in another tab: stop reading it and
          // fall back the way a local delete does. This tab does not broadcast
          // the fallback — the tab that deleted it already announced its own.
          const fallback = fallbackAfterRemoval({
            saved,
            activeGuard,
            notice,
            defaultGuard: defaultGuard(),
          });
          if (fallback !== null) {
            readEpochRef.current += 1;
            setGuard(fallback);
            setSnapshot(null);
            setSnapshotError(null);
            setBuffer(emptyStreamBuffer());
            setRangeLabel(null);
            dropFeedState();
          }
          return;
        }
      }
    });
  }, [tabSync, dropFeedState, registryChangeFilter]);

  useEffect(() => {
    void refresh();
    const stop = startRefreshTimer(() => void refresh(), SNAPSHOT_INTERVAL_MS);
    const unregister = memoryWiper.add(stop);
    return () => {
      stop();
      unregister();
    };
  }, [refresh]);

  const selectGuard = useCallback(
    (next: string) => {
      // Invalidate in-flight reads first: the epoch bump makes the guard switch
      // atomic with respect to `refresh`, even though the state update is async.
      readEpochRef.current += 1;
      setGuard(next);
      setSnapshot(null);
      setSnapshotError(null);
      setBuffer(emptyStreamBuffer());
      setRangeLabel(null);
      // Drop the (guard-scoped) feed cursor so a switch can never bleed guard A's
      // events into guard B; the poll effect rebuilds it for the new guard.
      dropFeedState();
      // Every other tab follows the operator's selection instead of continuing to
      // poll a guard they are no longer looking at.
      tabSync.broadcast("GUARD_CHANGED", { guard: next });
    },
    [tabSync, dropFeedState],
  );

  const addInstance = useCallback(
    async (address: string, label: string): Promise<{ ok: boolean; error?: string }> => {
      if (demo) {
        return {
          ok: false,
          error: "Demo mode pins a single static fixture; adding a guard needs a real network.",
        };
      }
      const result = await addGuard({ server, address, label });
      if (!result.ok) return { ok: false, error: result.error };
      readEpochRef.current += 1;
      setInstances(loadInstances());
      setGuard(result.instance.guard);
      setSnapshot(null);
      setSnapshotError(null);
      dropFeedState();
      // Registry first: a tab that follows the selection must already know the
      // guard it is being moved to.
      announceRegistry("add", result.instance.guard);
      tabSync.broadcast("GUARD_CHANGED", { guard: result.instance.guard });
      return { ok: true };
    },
    [server, demo, tabSync, dropFeedState, announceRegistry],
  );

  const removeInstance = useCallback(
    (target: string) => {
      const removed = instances.find((instance) => instance.guard === target);
      const remaining = removeSavedInstance(target);
      setInstances(remaining);
      // Cascade: state scoped to the deleted guard (drafts, filters) is removed
      // too, so re-adding the same address later starts clean rather than
      // resurrecting work the operator discarded with the guard.
      clearGuardScopedState(removed?.network ?? NETWORK.name, target);
      // A build-seeded guard cannot be deleted, so nothing changed to announce.
      if (remaining.length < instances.length) announceRegistry("remove", target);
      if (target === guard) {
        const fallback = remaining[0]?.guard ?? defaultGuard();
        readEpochRef.current += 1;
        setGuard(fallback);
        setSnapshot(null);
        setSnapshotError(null);
        setBuffer(emptyStreamBuffer());
        setRangeLabel(null);
        dropFeedState();
        tabSync.broadcast("GUARD_CHANGED", { guard: fallback });
      }
    },
    [instances, guard, tabSync, dropFeedState, announceRegistry],
  );

  const renameInstance = useCallback(
    (target: string, label: string) => {
      setInstances(renameSavedInstance(target, label));
      // A blank label is ignored by the rename, so there is nothing to announce.
      if (label.trim() !== "") announceRegistry("rename", target);
    },
    [announceRegistry],
  );

  const activeInstance = useMemo(
    () => instances.find((instance) => instance.guard === guard) ?? null,
    [instances, guard],
  );

  const pushEvents = useCallback((incoming: TelemetryEvent[]) => {
    if (incoming.length === 0) return;
    // `ingestEvents` is pure — it copies `seen` rather than mutating it — so it
    // is safe inside the updater even when StrictMode double-invokes it.
    setBuffer((current) => ingestEvents(current, incoming));
  }, []);

  const pauseStream = useCallback(() => setBuffer(pauseBuffer), []);
  const resumeStream = useCallback(() => setBuffer((current) => resumeBuffer(current)), []);

  // Benchmark seam (issue #114): the perf spec streams thousands of synthetic
  // events through the feed at a controlled rate instead of waiting on the 5s
  // poll cadence, so FPS and heap growth can be measured under sustained load.
  // It is the same `pushEvents` the diagnostic path uses — no second write
  // route — and it is stripped from production builds, where the only events
  // are the ones actually polled from the chain.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const target = window as typeof window & {
      __guardFeedInject?: (incoming: TelemetryEvent[]) => void;
    };
    target.__guardFeedInject = pushEvents;
    return () => {
      delete target.__guardFeedInject;
    };
  }, [pushEvents]);

  const startWatching = useCallback(() => {
    if (!demo) {
      // One supervisor for the tab's whole tail. `createFeed` defers to the
      // coordinator so every guard still gets an identity-keyed feed, and
      // primes a genuinely fresh one so a newly added guard arrives with recent
      // context instead of a blank page.
      const coordinator = feedRef.current;
      if (!multiFeedRef.current && coordinator) {
        multiFeedRef.current = new MultiGuardFeed({
          cap: FEED_GUARD_CAP,
          createFeed: (target: string) => {
            const runner = coordinator.ensure(target);
            const position = runner.position();
            if (
              position.cursor === null &&
              position.latestLedger === null &&
              knownLedgerRef.current !== null
            ) {
              runner.resetFrom(knownLedgerRef.current - FEED_SWITCH_HISTORY_LEDGERS);
            }
            return runner;
          },
        });
      }
      const supervisor = multiFeedRef.current;
      supervisor?.sync(feedSources);
      const capped = supervisor?.dropped() ?? [];
      setPoll(INITIAL_POLL);
      setFeed((current) => ({
        ...current,
        watching: true,
        error: null,
        guards: supervisor?.guards() ?? [],
        capped: capped.length,
        cappedLabels: capped.map((source) => source.label),
      }));
      return;
    }
    setFeed((current) => ({ ...current, watching: true, error: null }));
  }, [feedSources, demo]);

  const stopWatching = useCallback(() => {
    // Release every listener rather than just hiding the table: a stopped
    // supervisor refuses further polls, so a reconciled-away guard's stream
    // cannot keep running behind a "not watching" header.
    multiFeedRef.current?.stopAll();
    multiFeedRef.current = null;
    setPoll(INITIAL_POLL);
    setFeed((current) => ({
      ...current,
      watching: false,
      guards: [],
      capped: 0,
      cappedLabels: [],
      gaps: [],
    }));
  }, []);

  /**
   * Choose, or un-choose, one guard for a tailed slot (#310).
   *
   * The change is persisted to this network's bucket and reconciled at once, so
   * picking a guard starts its listener without waiting for the next poll and
   * dropping one stops it — the supervisor's `sync()` is the only place listeners
   * are created or stopped, so a toggle cannot leak a listener in either
   * direction. A storage rejection (private mode, quota) is not announced as a
   * failure: the choice holds for this session, which is the truth.
   */
  const toggleTailedGuard = useCallback(
    (target: string) => {
      const next = tailSelection.includes(target)
        ? tailSelection.filter((entry) => entry !== target)
        : [...tailSelection, target];
      const pinned = prunePinned(
        next,
        instances.map((instance) => ({
          guard: instance.guard,
          label: instance.label,
        })),
      );
      setTailSelection(pinned);
      saveTailSelection(pinned);
      const supervisor = multiFeedRef.current;
      if (supervisor && feed.watching) {
        const registry: FeedSource[] = instances.map((instance) => ({
          guard: instance.guard,
          label: instance.label,
        }));
        supervisor.sync(
          planTailSources({ registry, active: guard, pinned, cap: FEED_GUARD_CAP }).ordered,
        );
        const capped = supervisor.dropped();
        setFeed((current) => ({
          ...current,
          guards: supervisor.guards(),
          capped: capped.length,
          cappedLabels: capped.map((source) => source.label),
        }));
      }
    },
    [tailSelection, instances, feed.watching, guard],
  );

  // Keep the running listeners aligned with the registry while watching (#23).
  // This is what starts a listener for a newly added guard and stops one whose
  // guard was deleted or renamed, without ever exceeding the cap.
  useEffect(() => {
    if (demo || !feed.watching) return;
    const supervisor = multiFeedRef.current;
    if (!supervisor) return;
    supervisor.sync(feedSources);
    const capped = supervisor.dropped();
    setFeed((current) => ({
      ...current,
      guards: supervisor.guards(),
      capped: capped.length,
      cappedLabels: capped.map((source) => source.label),
    }));
  }, [feedSources, feed.watching, demo]);

  // The supervisor is deliberately never torn down by an effect cleanup: React's
  // development StrictMode mount/unmount/mount cycle would stop the listeners on
  // the simulated unmount and leave the tab unable to tail. The provider lives as
  // long as the document, and the polling effect below clears its own interval.

  // ── Historical range queries (#148) ──────────────────────────────────
  // The demo feed never touches RPC, so a demo-mode range query is answered
  // from the fixtures filtered by the same timestamps — the demo's honesty
  // note stays true and the picker still demonstrably works.
  const queryRange = useCallback(
    async (range: TimeRange, preset: RangePreset) => {
      const invalid = validateRange(range);
      if (invalid) {
        setFeed((current) => ({ ...current, error: invalid }));
        return;
      }
      const label =
        preset === "custom"
          ? `${new Date((range.fromUnixSecs ?? 0) * 1000).toLocaleString()} → ${
              range.toUnixSecs === null ? "now" : new Date(range.toUnixSecs * 1000).toLocaleString()
            }`
          : RANGE_PRESET_LABELS[preset];
      // #309: remember the *bounds*, not just the caption. An export preview has
      // to state the range it applied, and "last 24 hours" is a label whose
      // endpoint moves with the clock — the resolved range is the checkable value.
      setExportRange(range);
      if (demo) {
        const from = range.fromUnixSecs ?? 0;
        const to = range.toUnixSecs ?? Number.MAX_SAFE_INTEGER;
        const inRange = demoEvents().filter((event) => {
          if (!event.ledgerClosedAt) return false;
          const closedAt = Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000);
          return closedAt >= from && closedAt <= to;
        });
        setBuffer(historicalBuffer(inRange));
        setRangeLabel(label);
        return;
      }
      const feedRunner = feedRef.current?.ensure(guard);
      if (!feedRunner) return;
      setFeed((current) => ({ ...current, error: null }));
      try {
        const page = await feedRunner.pollRange(range);
        // `seen` is rebuilt from the window so returning to the live tail does
        // not re-suppress rows this historical view already displayed.
        setBuffer(historicalBuffer(page.events));
        setRangeLabel(label);
      } catch (error) {
        setFeed((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [demo, guard],
  );

  // ── Operator session auto-lock ───────────────────────────────────────────
  // The countdown only runs while a wallet is connected: there is nothing to
  // lock until there is a signing session. On expiry the wallet is disconnected
  // and the in-memory event feed is dropped, so a walk-up cannot resume an
  // authorised session or read the last operator's diagnostics.
  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number>(() => loadIdleTimeoutMs());
  const handleIdleExpire = useCallback(() => {
    disconnect();
    resetEvents();
  }, [disconnect, resetEvents]);
  const { state: idleState, stayConnected } = useIdleTimer({
    timeoutMs: idleTimeoutMs,
    enabled: wallet !== null,
    onExpire: handleIdleExpire,
  });
  const idleWarningRef = useRef<HTMLDivElement>(null);
  const stayConnectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (idleState.phase === "warning" && wallet) idleWarningRef.current?.focus();
  }, [idleState.phase, wallet]);
  useEffect(() => {
    const seconds = idleState.secondsLeft;
    if (idleState.phase === "warning" && wallet && (seconds <= 10 || seconds % 10 === 0)) {
      announce(`Session expires in ${seconds} seconds`);
    }
  }, [idleState.phase, idleState.secondsLeft, wallet]);
  const setIdleTimeout = useCallback((valueMs: number) => {
    saveIdleTimeoutMs(valueMs);
    setIdleTimeoutMs(valueMs);
  }, []);

  /**
   * Re-evaluate liveness on a clock, not only on poll results (#311).
   *
   * This is the part the issue would silently defeat if it were skipped: an
   * `overdue` feed is defined by a poll that *did not happen*, so a health reading
   * that only recomputed on a poll could never reach that state — the very
   * condition it exists to report would be the one that stops it from being
   * evaluated. A stopped clock advances anyway.
   */
  const [healthNowMs, setHealthNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!feed.watching) return;
    const timer = setInterval(() => setHealthNowMs(Date.now()), FEED_INTERVAL_MS);
    const unregister = memoryWiper.add(() => clearInterval(timer));
    return () => {
      clearInterval(timer);
      unregister();
    };
  }, [feed.watching]);

  const health = useMemo<PollHealth>(() => {
    if (!feed.watching && poll.lastSuccessAt === null && poll.lastFailureAt === null) {
      return POLL_OFF;
    }
    return pollHealth({
      ...poll,
      watching: feed.watching,
      nowMs: healthNowMs,
      intervalMs: FEED_INTERVAL_MS,
    });
  }, [feed.watching, poll, healthNowMs]);

  useEffect(() => {
    if (!feed.watching) return;

    // Demo mode generates its own event stream on a timer. It deliberately does
    // not construct a `GuardFeed`, so demo mode makes no RPC call at all.
    if (demo) {
      let demoCancelled = false;
      let sequence = 1;
      const emit = () => {
        if (demoCancelled) return;
        const event = syntheticDemoEvent(sequence, Date.now());
        sequence += 1;
        // Demo events can repeat fields (two identical refusals), so skip
        // dedupe: each synthetic event is a distinct occurrence.
        setBuffer((current) => ingestEvents(current, [event], { dedupe: false }));
        setFeed((current) => ({
          ...current,
          latestLedger: DEMO_BASE_LEDGER + sequence,
          lastPolledAt: new Date().toISOString(),
          error: null,
        }));
        // `poll` is deliberately left alone: demo mode makes no RPC round, so the
        // health reading stays `pending` rather than claiming a poll succeeded.
        // Fixture rows are already labelled as fixtures elsewhere on the panel.
      };
      const demoTimer = setInterval(emit, POLLING.demoEventMs);
      const unregister = memoryWiper.add(() => clearInterval(demoTimer));
      return () => {
        demoCancelled = true;
        clearInterval(demoTimer);
        unregister();
      };
    }

    let cancelled = false;
    const tick = async () => {
      // Identity-check on every tick: the supervisor holds one listener per tailed
      // guard, and it is reconciled against the registry rather than pinned to
      // whichever guard the loop was born with. A feed added mid-watch is primed
      // for recent history so the operator arrives with context rather than a
      // blank page (see FEED_SWITCH_HISTORY_LEDGERS).
      const supervisor = multiFeedRef.current;
      if (!supervisor) return;
      const attemptedAt = new Date().toISOString();
      setPoll((current) => ({ ...current, polling: true, lastAttemptAt: attemptedAt }));
      try {
        const page = await supervisor.pollAll();
        if (cancelled) return;
        if (page.latestLedger !== null) {
          knownLedgerRef.current = Math.max(knownLedgerRef.current ?? 0, page.latestLedger);
        }
        pushEvents(page.events as TelemetryEvent[]);
        // One guard failing to poll is reported on its own line and does not
        // blank the guards that answered. `error` carries the first failure so
        // the panel still has a headline to show.
        const failed = page.watch.find((entry) => !entry.ok);
        const anyAnswered = page.watch.some((entry) => entry.ok);
        const completedAt = new Date().toISOString();
        setFeed((current) => ({
          ...current,
          latestLedger: page.latestLedger ?? current.latestLedger,
          // An *attempt* stamp. #311: it is not a success claim, which is why the
          // success stamp below is a separate field with its own writer.
          lastPolledAt: completedAt,
          guards: supervisor.guards(),
          gaps: feedGapNotices(page.watch),
          error: failed ? `${failed.label}: ${failed.error}` : null,
        }));
        setPoll((current) => ({
          polling: false,
          lastAttemptAt: completedAt,
          // A round that returned is a live poll even when it carried nothing:
          // an empty page from a quiet guard must advance the success stamp and
          // leave the event count at zero, which is the pairing the panel reads
          // as "alive, nothing happened" rather than "broken".
          lastSuccessAt: completedAt,
          // Only a round where *no* guard answered counts as a poll failure. A
          // partial failure keeps the feed healthy and shows its own error line,
          // because "three of five guards answered" is not a dead endpoint.
          lastFailureAt: anyAnswered ? current.lastFailureAt : completedAt,
          error: failed ? `${failed.label}: ${failed.error}` : null,
          eventsInLastRound: page.events.length,
        }));
      } catch (error) {
        if (cancelled) return;
        const failedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        setFeed((current) => ({ ...current, error: message, lastPolledAt: failedAt }));
        // The success stamp is left exactly where it was: a failed round cannot
        // make the feed look recently-healthy, and a later success has to be able
        // to overtake this failure — which is the recovery the issue asks to show.
        setPoll((current) => ({
          ...current,
          polling: false,
          lastAttemptAt: failedAt,
          lastFailureAt: failedAt,
          error: message,
        }));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), FEED_INTERVAL_MS);
    const unregister = memoryWiper.add(() => {
      cancelled = true;
      clearInterval(timer);
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unregister();
    };
  }, [feed.watching, pushEvents, demo]);

  // Built from primitives so a live batch — which replaces `buffer` but leaves
  // these unchanged — does not change the context value's identity.
  const { paused, dropped } = buffer;
  const pendingCount = buffer.pending.length;
  const stream = useMemo(
    () => ({ paused, pendingCount, dropped }),
    [paused, pendingCount, dropped],
  );

  // Memoised so an `events` batch — the frequent update — cannot change this
  // object's identity and re-render every consumer that has nothing to do with
  // the feed. All fields below are the context's own deps.
  const value = useMemo<GuardContextValue>(
    () => ({
      server,
      wallet,
      walletError,
      connecting,
      connect,
      disconnect,
      signer,
      providerId,
      availableProviders,
      observer: isObserverSession(wallet),
      networkMismatch,
      switchNetwork,
      instances,
      guard,
      activeInstance,
      selectGuard,
      addInstance,
      removeInstance,
      renameInstance,
      snapshot,
      lastRefresh,
      snapshotError,
      refreshing,
      refresh,
      retryRead,
      retryingField,
      feed: { ...feed, health },
      stream,
      pauseStream,
      resumeStream,
      startWatching,
      stopWatching,
      tailSelection,
      toggleTailedGuard,
      clearEvents,
      pushEvents,
      queryRange,
      rangeLabel,
      exportRange,
      notifyTabs,
      session: {
        state: idleState,
        timeoutMs: idleTimeoutMs,
        setTimeoutMs: setIdleTimeout,
        stayConnected,
      },
    }),
    [
      server,
      wallet,
      walletError,
      connecting,
      connect,
      disconnect,
      signer,
      lastRefresh,
      providerId,
      availableProviders,
      networkMismatch,
      switchNetwork,
      instances,
      guard,
      activeInstance,
      selectGuard,
      addInstance,
      removeInstance,
      renameInstance,
      snapshot,
      snapshotError,
      refreshing,
      refresh,
      retryRead,
      retryingField,
      feed,
      health,
      stream,
      pauseStream,
      resumeStream,
      startWatching,
      stopWatching,
      tailSelection,
      toggleTailedGuard,
      clearEvents,
      pushEvents,
      queryRange,
      rangeLabel,
      exportRange,
      notifyTabs,
      idleState,
      idleTimeoutMs,
      setIdleTimeout,
      stayConnected,
    ],
  );

  return (
    <GuardContext.Provider value={value}>
      <GuardEventsContext.Provider value={buffer.rows}>
        {children}
        {idleState.phase === "warning" && wallet && (
          <div className="modal-backdrop">
            <div
              className="modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="session-lock-title"
              aria-describedby="session-lock-body"
              ref={idleWarningRef}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  event.preventDefault();
                  stayConnectedRef.current?.focus();
                }
              }}
            >
              <strong id="session-lock-title">
                Session expiring due to inactivity. Click to stay connected.
              </strong>
              <p className="tiny" id="session-lock-body">
                You will be disconnected in {idleState.secondsLeft}s. The admin wallet will be
                unlinked and unsaved work dropped; reconnecting is required before anything can be
                signed again.
              </p>
              <div className="row">
                <button ref={stayConnectedRef} onClick={stayConnected}>
                  Stay connected
                </button>
              </div>
            </div>
          </div>
        )}
      </GuardEventsContext.Provider>
    </GuardContext.Provider>
  );
}

export function useGuard(): GuardContextValue {
  const value = useContext(GuardContext);
  if (!value) throw new Error("useGuard must be used inside <GuardProvider>");
  return value;
}

/** The live event feed, newest first — see `GuardEventsContext`. */
export function useGuardEvents(): TelemetryEvent[] {
  const value = useContext(GuardEventsContext);
  if (value === null) throw new Error("useGuardEvents must be used inside <GuardProvider>");
  return value;
}

export { GuardContext, GuardEventsContext };
