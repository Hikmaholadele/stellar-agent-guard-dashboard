"use client";

/**
 * Multi-wallet connector abstraction (issue #96), network-switch plumbing
 * (issue #97) and the read-only session rules that follow from both (issue #101).
 *
 * Until now `lib/guard/wallet.ts` was Freighter-only, which quietly made
 * Freighter a requirement for operating a guard rather than a convenience.
 * This module puts one interface over the three providers an operator actually
 * has — Freighter, Albedo and xBull — so the panels never name a wallet again:
 *
 *     const connector = createWalletConnector(preferred);
 *     const connection = await connector.connect();
 *     const signer = connectorSigner(connector, connection.address, NETWORK.passphrase);
 *
 * Two things are deliberate about the shape:
 *
 *   - **The provider objects are injected, not reached for.** Every connector is
 *     built from a `WalletScope` describing `window.freighter`, `window.albedo`
 *     and `window.xbull`, so the whole abstraction — including the error
 *     mapping — is exercised headlessly in `node --test` with object literals.
 *     That is the same reason `wallet.ts` loads the Freighter bundle on demand:
 *     a module that touches an extension at import time cannot be loaded by
 *     the test runner, and the test runner is what proves the security-relevant
 *     branches.
 *   - **A missing wallet is a state with a next step, not an error string.**
 *     `WalletNotInstalledError` carries the provider's install and guide URLs,
 *     which is what lets `WalletBar` offer a link instead of a dead end for an
 *     operator with no extension at all.
 *
 * The signing paths are unchanged in substance: whatever provider is used, the
 * key never leaves the wallet, the payload is shown to the operator by the
 * wallet, and the dashboard still cannot produce a signature itself.
 */

import { WalletError, type ConnectedWallet } from "./wallet.ts";
import { NETWORK } from "./network.ts";

export type { ConnectedWallet };

export type WalletProviderId = "freighter" | "albedo" | "xbull";

export interface WalletNetwork {
  /** Short provider-flavoured name, e.g. `testnet`. */
  name: string;
  /** The full Stellar network passphrase the wallet is pointed at. */
  passphrase: string;
}

export interface WalletConnection {
  address: string;
  network: WalletNetwork;
}

export interface SignOptions {
  /** The passphrase the transaction was built for, so the wallet can refuse a mismatch. */
  networkPassphrase?: string;
  /** The account to sign as, for wallets holding several. */
  address?: string;
}

/**
 * The one interface every wallet provider is adapted to.
 *
 * `connect()` returns the address *and* the network on purpose: a signer that
 * knows the address but not the network is how a testnet signature ends up on a
 * mainnet transaction, and every provider here can report both.
 */
export interface WalletConnector {
  readonly id: WalletProviderId;
  connect(): Promise<WalletConnection>;
  getPublicKey(): Promise<string>;
  getNetwork(): Promise<WalletNetwork>;
  /**
   * Re-read the active address *without* prompting, or null when the provider
   * is gone. Optional because a web wallet's only address read opens its
   * pop-up; a connector without it simply has no live binding check, rather
   * than reporting every write as a disconnect.
   */
  currentAddress?(): Promise<string | null>;
  signTransaction(transactionXdr: string, options?: SignOptions): Promise<string>;
  signAuthEntry(authEntryXdr: string, options?: SignOptions): Promise<string>;
}

// ── Provider registry ──────────────────────────────────────────────────────

export interface WalletProviderDescriptor {
  id: WalletProviderId;
  name: string;
  /** Where the wallet lives, which decides whether a missing wallet is installable or merely unreachable. */
  kind: "extension" | "web";
  /** Monogram rendered in the selection modal. */
  monogram: string;
  blurb: string;
  installUrl: string;
  guideUrl: string;
}

/**
 * The providers this console speaks to.
 *
 * `monogram` rather than a brand asset: shipping redrawn third-party logos
 * would be a trademark problem and an offline-asset problem at once, so the
 * modal labels each provider in words and leaves the branding alone.
 */
export const WALLET_PROVIDERS: readonly WalletProviderDescriptor[] = [
  {
    id: "freighter",
    name: "Freighter",
    kind: "extension",
    monogram: "FR",
    blurb: "LumenProject's browser extension. Also the wallet Ledger and Trezor connect through.",
    installUrl: "https://www.freighter.app",
    guideUrl: "https://www.freighter.app",
  },
  {
    id: "albedo",
    name: "Albedo",
    kind: "web",
    monogram: "AL",
    blurb: "Web-based wallet from the Albedo team; signs through a pop-up, no extension required.",
    installUrl: "https://albedo.link",
    guideUrl: "https://albedo.link",
  },
  {
    id: "xbull",
    name: "xBull",
    kind: "extension",
    monogram: "XB",
    blurb: "xBull wallet for Chrome, Edge, Brave and Firefox.",
    installUrl: "https://xbull.app",
    guideUrl: "https://xbull.app",
  },
];

export function walletProviderDescriptor(id: WalletProviderId): WalletProviderDescriptor {
  const found = WALLET_PROVIDERS.find((provider) => provider.id === id);
  if (!found) throw new WalletError(`Unknown wallet provider: ${String(id)}`);
  return found;
}

const PROVIDER_IDS = new Set<string>(WALLET_PROVIDERS.map((provider) => provider.id));

/** Is this string one of the providers we can actually drive? Guards `localStorage`. */
export function isWalletProviderId(value: unknown): value is WalletProviderId {
  return typeof value === "string" && PROVIDER_IDS.has(value);
}

// ── Errors: the provider vocabulary mapped onto ours ───────────────────────

/**
 * The operator has this provider but no wallet for it.
 *
 * Carrying the install and guide URLs on the error is what lets the UI send an
 * operator somewhere useful — the acceptance case of "gracefully handles users
 * without wallet extensions" — instead of showing a stack trace about
 * `window.xbull` being undefined.
 */
export class WalletNotInstalledError extends WalletError {
  readonly provider: WalletProviderId;
  readonly installUrl: string;
  readonly guideUrl: string;

  constructor(provider: WalletProviderId, detail?: string) {
    const descriptor = descriptorFor(provider);
    super(
      `${descriptor.name} is not available in this browser. ${
        detail ??
        (descriptor.kind === "extension"
          ? `Install the ${descriptor.name} extension, then reconnect.`
          : `Open ${descriptor.name} and connect again.`)
      }`,
    );
    this.name = "WalletNotInstalledError";
    this.provider = provider;
    this.installUrl = descriptor.installUrl;
    this.guideUrl = descriptor.guideUrl;
  }
}

/** The operator cancelled, or refused the permission prompt. */
export class WalletUserRejectedError extends WalletError {
  readonly provider: WalletProviderId;

  constructor(provider: WalletProviderId, action: string) {
    super(
      `You declined to ${action} in ${walletProviderDescriptor(provider).name}. Nothing was sent.`,
    );
    this.name = "WalletUserRejectedError";
    this.provider = provider;
  }
}

/** The provider is present but does not implement something this console needs. */
export class WalletUnsupportedError extends WalletError {
  readonly provider: WalletProviderId;

  constructor(provider: WalletProviderId, capability: string) {
    super(
      `${walletProviderDescriptor(provider).name} does not support ${capability} in this browser.`,
    );
    this.name = "WalletUnsupportedError";
    this.provider = provider;
  }
}

function descriptorFor(id: WalletProviderId): WalletProviderDescriptor {
  return WALLET_PROVIDERS.find((provider) => provider.id === id) ?? WALLET_PROVIDERS[0]!;
}

/**
 * Collapse a provider's failure onto one of the three outcomes the UI can act
 * on.
 *
 * Each wallet reports a refusal differently — Freighter through an `error`
 * field, xBull and Albedo by throwing strings that vary by build — so the
 * matching is deliberately loose and errs towards `WalletUserRejectedError`
 * only when the wording really does say so. Anything unrecognised keeps its
 * original message: a signing error the operator cannot read is worse than one
 * that names the wallet.
 */
export function mapConnectorError(
  error: unknown,
  provider: WalletProviderId,
  action: string,
): WalletError {
  if (error instanceof WalletError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalised = message.toLowerCase();

  if (
    /not (be )?(found|installed)|no provider|undefined|is not available|could not connect/.test(
      normalised,
    )
  ) {
    return new WalletNotInstalledError(provider, message);
  }
  if (/reject|denied|declin|cancel|abort|user.*(close|dismiss)/.test(normalised)) {
    return new WalletUserRejectedError(provider, action);
  }
  return new WalletError(
    `${walletProviderDescriptor(provider).name} could not ${action}: ${message}`,
  );
}

/** Freighter reports failures in a field rather than by throwing; surface them. */
function assertFreighterOk(
  result: { error?: { message?: string } | null } | null,
  action: string,
): void {
  const error = result?.error;
  if (error) {
    throw new WalletError(
      `Could not ${action} in Freighter: ${error.message ?? JSON.stringify(error)}`,
    );
  }
}

// ── The injected scope ─────────────────────────────────────────────────────

/** The npm `@stellar/freighter-api` surface this console uses. */
export interface FreighterApiModule {
  requestAccess(): Promise<{ address?: string; error?: { message?: string } | null }>;
  getAddress(): Promise<{ address?: string; error?: { message?: string } | null }>;
  getNetworkDetails(): Promise<{
    network?: string;
    networkPassphrase?: string;
    error?: { message?: string } | null;
  }>;
  signTransaction(
    xdr: string,
    options: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr?: string; error?: { message?: string } | null }>;
  signAuthEntry(
    xdr: string,
    options: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry?: string | null; error?: { message?: string } | null }>;
  /** Present in Freighter API v7+; the network-switch request added by issue #97. */
  requestNetworkAccess?(args: {
    network: string;
  }): Promise<{ isChanged?: boolean; isError?: boolean; error?: string } | undefined>;
}

/** Albedo's injected web API. */
export interface AlbedoProvider {
  connect(args: {
    onReady?: (response: { address: string; network?: string }) => void;
    [key: string]: unknown;
  }): Promise<{ address?: string; network?: string } | void>;
  network(
    args?: Record<string, unknown>,
  ): Promise<{ network?: string; networkPassphrase?: string }>;
  signedTx(args: Record<string, unknown>): Promise<{ tx_xdr?: string; error?: string } | string>;
  signedAuth(args: Record<string, unknown>): Promise<{ auth?: string; error?: string } | string>;
}

/** xBull's injected extension API. */
export interface XbullProvider {
  connect(): Promise<{ publicKey?: string; network?: string; address?: string } | string>;
  getPublicKey?(): Promise<string>;
  getNetwork?(): Promise<string>;
  signTransaction(xdr: string, options?: Record<string, unknown>): Promise<string>;
  signAuthEntry?(xdr: string, options?: Record<string, unknown>): Promise<string>;
}

/** Everything a browser can hand us about wallets, as data. */
export interface WalletScope {
  /**
   * The Freighter API bundle, as a loader rather than an instance.
   *
   * `null` means the console is not in a browser at all; a loader that rejects
   * means Freighter is installed nowhere. The distinction is `freighterIsAvailable`'s
   * to resolve, and it is why this is not simply a boolean.
   */
  freighterLoader: (() => Promise<FreighterApiModule>) | null;
  albedo: AlbedoProvider | null;
  xbull: XbullProvider | null;
}

interface WalletWindowLike {
  albedo?: AlbedoProvider;
  xbull?: XbullProvider;
}

/**
 * Read the live wallet objects.
 *
 * Freighter is the odd one out: its API is a module rather than an injected
 * global, so it arrives through `freighterLoader`, which is the same dynamic
 * import `wallet.ts` already uses — evaluating that bundle in Node is what
 * breaks a top-level import, and this keeps it out of the test path.
 */
export function readWalletScope(
  win?: WalletWindowLike | null,
  freighterLoader: (() => Promise<FreighterApiModule>) | null = loadFreighterApi,
): WalletScope {
  const scope =
    win ?? (typeof window === "undefined" ? null : (window as unknown as WalletWindowLike)) ?? null;
  return {
    freighterLoader,
    albedo: scope?.albedo ?? null,
    xbull: scope?.xbull ?? null,
  };
}

function loadFreighterApi(): Promise<FreighterApiModule> {
  return import("@stellar/freighter-api") as unknown as Promise<FreighterApiModule>;
}

/**
 * Which providers this browser can actually serve right now.
 *
 * Freighter answers without prompting (a cheap `getNetworkDetails` probe), so
 * detection stays non-invasive: no wallet here calls `connect()`, which on
 * several providers raises a permission prompt the operator did not ask for.
 */
export async function detectInstalledProviders(scope: WalletScope): Promise<WalletProviderId[]> {
  const installed: WalletProviderId[] = [];
  if (await freighterIsAvailable(scope.freighterLoader)) installed.push("freighter");
  if (scope.albedo) installed.push("albedo");
  if (scope.xbull) installed.push("xbull");
  return installed;
}

/** Whether the Freighter npm bundle evaluated and reached an extension. */
export async function freighterIsAvailable(
  loader: (() => Promise<FreighterApiModule>) | null,
): Promise<boolean> {
  if (!loader) return false;
  try {
    const api = await loader();
    if (typeof api.getNetworkDetails !== "function") return false;
    const details = await api.getNetworkDetails();
    return !details.error;
  } catch {
    // No extension: the bundle's transport throws rather than answering.
    return false;
  }
}

// ── Connectors ─────────────────────────────────────────────────────────────

/** Network names as the providers spell them, mapped onto passphrases. */
const NETWORK_ALIASES: Readonly<Record<string, string>> = {
  testnet: "testnet",
  testing: "testnet",
  public: "public",
  mainnet: "public",
  futurenet: "futurenet",
  standalone: "standalone",
};

const PASSPHRASE_BY_NAME: Readonly<Record<string, string>> = {
  testnet: "Test SDF Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

const NAME_BY_PASSPHRASE: Readonly<Record<string, string>> = {
  "Test SDF Network ; September 2015": "testnet",
  "Public Global Stellar Network ; September 2015": "public",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "standalone",
};

/**
 * Normalize a provider's idea of a network into a name and a passphrase.
 *
 * Providers hand back either a word or a passphrase — and some hand back the
 * empty string — so both directions are resolved here rather than in each
 * connector. The name is what the warning bar prints; the passphrase is what
 * the mismatch check compares, because names are not a stable identifier.
 */
export function normalizeWalletNetwork(value: {
  name?: string | null;
  passphrase?: string | null;
}): WalletNetwork {
  const rawName = (value.name ?? "").trim();
  const rawPassphrase = (value.passphrase ?? "").trim();
  if (rawPassphrase) {
    return {
      name:
        NAME_BY_PASSPHRASE[rawPassphrase] ||
        NETWORK_ALIASES[rawName.toLowerCase()] ||
        rawName ||
        "unknown",
      passphrase: rawPassphrase,
    };
  }
  const canonical = NETWORK_ALIASES[rawName.toLowerCase()] ?? rawName.toLowerCase();
  return {
    name: canonical || "unknown",
    passphrase: PASSPHRASE_BY_NAME[canonical] ?? "",
  };
}

function requireAddress(address: string | null | undefined, provider: WalletProviderId): string {
  if (!address) {
    throw new WalletError(
      `${walletProviderDescriptor(provider).name} returned no account address, so nothing could be signed.`,
    );
  }
  return address;
}

/** Freighter, through the official npm API — the behaviour `wallet.ts` had, unchanged. */
export function createFreighterConnector(
  loader: (() => Promise<FreighterApiModule>) | null,
): WalletConnector {
  const id: WalletProviderId = "freighter";
  const api = async (): Promise<FreighterApiModule> => {
    if (!loader) throw new WalletNotInstalledError(id, "The Freighter API bundle is unavailable.");
    try {
      return await loader();
    } catch (error) {
      throw new WalletNotInstalledError(id, error instanceof Error ? error.message : undefined);
    }
  };

  return {
    id,
    async connect() {
      const freighter = await api();
      const granted = await freighter.requestAccess();
      assertFreighterOk(granted, "get account access");
      const address = requireAddress(granted.address, id);
      return { address, network: await this.getNetwork() };
    },
    async getPublicKey() {
      const freighter = await api();
      const result = await freighter.getAddress();
      assertFreighterOk(result, "read the account address");
      return requireAddress(result.address, id);
    },
    async currentAddress() {
      // `getAddress` is silent after access was granted — no new prompt.
      const freighter = await api();
      const result = await freighter.getAddress();
      assertFreighterOk(result, "read the account address");
      return result.address ?? null;
    },
    async getNetwork() {
      const freighter = await api();
      const details = await freighter.getNetworkDetails();
      assertFreighterOk(details, "read the wallet network");
      return normalizeWalletNetwork({
        ...(details.network === undefined ? {} : { name: details.network }),
        ...(details.networkPassphrase === undefined
          ? {}
          : { passphrase: details.networkPassphrase }),
      });
    },
    async signTransaction(transactionXdr, options) {
      const freighter = await api();
      const result = await freighter.signTransaction(transactionXdr, {
        networkPassphrase: options?.networkPassphrase ?? NETWORK.passphrase,
        ...(options?.address === undefined ? {} : { address: options.address }),
      });
      assertFreighterOk(result, "sign the transaction");
      if (!result.signedTxXdr) throw new WalletError("Freighter returned no signed transaction");
      return result.signedTxXdr;
    },
    async signAuthEntry(authEntryXdr, options) {
      const freighter = await api();
      const result = await freighter.signAuthEntry(authEntryXdr, {
        networkPassphrase: options?.networkPassphrase ?? NETWORK.passphrase,
        ...(options?.address === undefined ? {} : { address: options.address }),
      });
      assertFreighterOk(result, "sign the authorization entry");
      if (!result.signedAuthEntry) {
        throw new WalletUserRejectedError(id, "sign the authorization entry");
      }
      return result.signedAuthEntry;
    },
  };
}

/**
 * xBull, through the object the extension injects as `window.xbull`.
 *
 * xBull hands back its network as a bare word and, depending on the build,
 * either an object or a string from `connect()`, so both shapes are accepted
 * here rather than in the UI.
 */
export function createXbullConnector(provider: XbullProvider | null): WalletConnector {
  const id: WalletProviderId = "xbull";
  if (!provider) throw new WalletNotInstalledError(id);
  const wallet = provider;

  return {
    id,
    async connect() {
      try {
        const connected = await wallet.connect();
        const address =
          typeof connected === "string"
            ? connected
            : requireAddress(connected.publicKey ?? connected.address, id);
        const network = normalizeWalletNetwork(
          typeof connected === "string"
            ? { name: null }
            : connected.network === undefined
              ? {}
              : { name: connected.network },
        );
        return { address, network: network.passphrase ? network : await this.getNetwork() };
      } catch (error) {
        throw mapConnectorError(error, id, "connect");
      }
    },
    async getPublicKey() {
      try {
        if (wallet.getPublicKey) {
          return requireAddress(await wallet.getPublicKey(), id);
        }
        const connected = await wallet.connect();
        return typeof connected === "string"
          ? connected
          : requireAddress(connected.publicKey ?? connected.address, id);
      } catch (error) {
        throw mapConnectorError(error, id, "read the account address");
      }
    },
    async getNetwork() {
      try {
        const name = wallet.getNetwork ? await wallet.getNetwork() : null;
        return normalizeWalletNetwork({ name });
      } catch (error) {
        throw mapConnectorError(error, id, "read the wallet network");
      }
    },
    // Only when the extension exposes a silent read; `connect()` would prompt,
    // which a write boundary must never do.
    ...(wallet.getPublicKey
      ? {
          async currentAddress(): Promise<string | null> {
            try {
              return (await wallet.getPublicKey!()) ?? null;
            } catch {
              return null;
            }
          },
        }
      : {}),
    async signTransaction(transactionXdr, options) {
      try {
        const signed = await wallet.signTransaction(transactionXdr, { ...(options ?? {}) });
        const xdr =
          typeof signed === "string"
            ? signed
            : ((signed as { tx_xdr?: string } | null)?.tx_xdr ?? null);
        if (!xdr) throw new WalletError("xBull returned no signed transaction");
        return xdr;
      } catch (error) {
        throw mapConnectorError(error, id, "sign the transaction");
      }
    },
    async signAuthEntry(authEntryXdr, options) {
      if (!wallet.signAuthEntry)
        throw new WalletUnsupportedError(id, "Soroban authorization entries");
      try {
        const signed = await wallet.signAuthEntry(authEntryXdr, { ...(options ?? {}) });
        const entry =
          typeof signed === "string"
            ? signed
            : ((signed as { auth?: string } | null)?.auth ?? null);
        if (!entry) throw new WalletUserRejectedError(id, "sign the authorization entry");
        return entry;
      } catch (error) {
        throw mapConnectorError(error, id, "sign the authorization entry");
      }
    },
  };
}

/**
 * Albedo, through `window.albedo`.
 *
 * Albedo is the web-based one: `connect({ onReady })` resolves through a
 * callback as well as a promise, and the signing calls take a single argument
 * object that also carries the callback. Both answer shapes are accepted
 * because the callback form is what the popup flow uses.
 */
export function createAlbedoConnector(provider: AlbedoProvider | null): WalletConnector {
  const id: WalletProviderId = "albedo";
  if (!provider) throw new WalletNotInstalledError(id);
  const wallet = provider;

  return {
    id,
    async connect() {
      try {
        const answer = await new Promise<{ address?: string; network?: string }>(
          (resolve, reject) => {
            let settled = false;
            const finish = (response: { address?: string; network?: string } | void) => {
              if (settled || !response || typeof response !== "object") return;
              settled = true;
              resolve(response);
            };
            wallet
              .connect({
                callback: (response: { address?: string; network?: string } | void) =>
                  finish(response),
                onReady: (response: { address: string; network?: string }) => finish(response),
              })
              .then(finish)
              .catch((error: unknown) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
              });
          },
        );
        const address = requireAddress(answer.address, id);
        const network = normalizeWalletNetwork(
          answer.network === undefined ? {} : { name: answer.network },
        );
        return { address, network: network.passphrase ? network : await this.getNetwork() };
      } catch (error) {
        throw mapConnectorError(error, id, "connect");
      }
    },
    async getPublicKey() {
      const connection = await this.connect();
      return connection.address;
    },
    async getNetwork() {
      try {
        const details = await wallet.network({});
        return normalizeWalletNetwork({
          name: details?.network ?? null,
          passphrase: details?.networkPassphrase ?? null,
        });
      } catch (error) {
        throw mapConnectorError(error, id, "read the wallet network");
      }
    },
    async signTransaction(transactionXdr) {
      try {
        const signed = await wallet.signedTx({ tx: transactionXdr });
        if (typeof signed !== "string" && signed.error) {
          throw new WalletError(`Albedo refused the transaction: ${signed.error}`);
        }
        const xdr = typeof signed === "string" ? signed : signed.tx_xdr;
        if (!xdr) throw new WalletError("Albedo returned no signed transaction");
        return xdr;
      } catch (error) {
        throw mapConnectorError(error, id, "sign the transaction");
      }
    },
    async signAuthEntry(authEntryXdr) {
      try {
        const signed = await wallet.signedAuth({ auth: authEntryXdr });
        if (typeof signed === "string") {
          if (!signed) throw new WalletUserRejectedError(id, "sign the authorization entry");
          return signed;
        }
        if (signed.error)
          throw new WalletError(`Albedo refused the authorization entry: ${signed.error}`);
        if (!signed.auth) throw new WalletUserRejectedError(id, "sign the authorization entry");
        return signed.auth;
      } catch (error) {
        throw mapConnectorError(error, id, "sign the authorization entry");
      }
    },
  };
}

/** The connector for one provider id, from whatever the browser offered. */
export function createWalletConnector(id: WalletProviderId, scope: WalletScope): WalletConnector {
  switch (id) {
    case "freighter":
      return createFreighterConnector(scope.freighterLoader ?? null);
    case "albedo":
      return createAlbedoConnector(scope.albedo);
    case "xbull":
      return createXbullConnector(scope.xbull);
  }
}

/**
 * The persisted choice is only a preference, so an unknown or stale value
 * falls back to Freighter rather than breaking the console on load.
 */
export function resolveConnector(
  id: WalletProviderId | null | undefined,
  scope: WalletScope,
): WalletConnector {
  return createWalletConnector(isWalletProviderId(id) ? id : "freighter", scope);
}

// ── Adapting a connector to the dashboard's signer ─────────────────────────

/**
 * The `WalletSigner` every panel already accepts, backed by any connector.
 *
 * The target passphrase is pinned here rather than read from the wallet, which
 * preserves the invariant `wallet.ts` was written around: the wallet is asked
 * to sign for the network the dashboard is configured for, and refuses
 * otherwise, so a signature produced for another network can never be
 * broadcast by mistake.
 */
export function connectorSigner(
  connector: WalletConnector,
  address: string,
  networkPassphrase: string = NETWORK.passphrase,
): {
  address: string;
  /** Present only when the provider has a silent live-address read. */
  currentAddress?: () => Promise<string | null>;
  signTransaction(transactionXdr: string): Promise<string>;
  signAuthEntry(entryXdr: string): Promise<string>;
} {
  return {
    address,
    ...(connector.currentAddress
      ? {
          // A reader that throws means the provider is gone; submit.ts maps that
          // to a phase-specific, recoverable interruption.
          currentAddress: async (): Promise<string | null> => {
            try {
              return await connector.currentAddress!();
            } catch {
              return null;
            }
          },
        }
      : {}),
    async signTransaction(transactionXdr: string): Promise<string> {
      try {
        return await connector.signTransaction(transactionXdr, { networkPassphrase, address });
      } catch (error) {
        throw mapConnectorError(error, connector.id, "sign the transaction");
      }
    },
    async signAuthEntry(entryXdr: string): Promise<string> {
      try {
        return await connector.signAuthEntry(entryXdr, { networkPassphrase, address });
      } catch (error) {
        throw mapConnectorError(error, connector.id, "sign the authorization entry");
      }
    },
  };
}

// ── Preferred provider persistence ─────────────────────────────────────────

export const PREFERRED_WALLET_STORAGE_KEY = "stellar-agent-guard-dashboard.walletProvider.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The wallet the operator last chose, or null when they never picked one. */
export function loadPreferredProvider(storage?: StorageLike | null): WalletProviderId | null {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return null;
  try {
    const raw = store.getItem(PREFERRED_WALLET_STORAGE_KEY);
    return isWalletProviderId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function savePreferredProvider(id: WalletProviderId, storage?: StorageLike | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(PREFERRED_WALLET_STORAGE_KEY, id);
  } catch {
    // A private-mode write only loses the preference; the modal still works.
  }
}

/**
 * Whether a reconnect should be attempted without asking.
 *
 * Auto-reconnecting is fine for Freighter, whose `getAddress` is silent once
 * access was granted, and wrong for a web popup wallet, which would open a
 * window on page load. The `kind` of the provider is what decides.
 */
export function canReconnectSilently(id: WalletProviderId | null): boolean {
  if (!isWalletProviderId(id)) return true;
  return walletProviderDescriptor(id).kind === "extension";
}

/** The header/badge wording for the active wallet. */
export function describeConnection(wallet: ConnectedWallet | null): string {
  if (!wallet) return "No wallet connected";
  return `${wallet.network} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
}
