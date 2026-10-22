import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WalletError } from "../../lib/guard/wallet.ts";
import {
  PREFERRED_WALLET_STORAGE_KEY,
  WALLET_PROVIDERS,
  WalletNotInstalledError,
  WalletUnsupportedError,
  WalletUserRejectedError,
  canReconnectSilently,
  connectorSigner,
  createAlbedoConnector,
  createFreighterConnector,
  createWalletConnector,
  createXbullConnector,
  detectInstalledProviders,
  isWalletProviderId,
  loadPreferredProvider,
  mapConnectorError,
  normalizeWalletNetwork,
  readWalletScope,
  resolveConnector,
  savePreferredProvider,
  walletProviderDescriptor,
  type AlbedoProvider,
  type FreighterApiModule,
  type WalletProviderId,
  type XbullProvider,
} from "../../lib/guard/walletConnector.ts";

/**
 * The connector abstraction is the seam between the console and three wallets
 * that disagree about everything except the fact that they hold the operator's
 * key. These tests hold that seam: each provider is faked at exactly the shape
 * it publishes, and the assertions are about the interface the panels see.
 */

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const ADDRESS = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

// ── Freighter ──────────────────────────────────────────────────────────────

function createFakeFreighterApi(
  overrides: Partial<FreighterApiModule> & {
    networkDetails?: { network?: string; networkPassphrase?: string };
  } = {},
): { api: FreighterApiModule; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (args: unknown) => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  const api: FreighterApiModule = {
    requestAccess: async () => {
      record("requestAccess")({});
      return { address: ADDRESS };
    },
    getAddress: async () => {
      record("getAddress")({});
      return { address: ADDRESS };
    },
    getNetworkDetails: async () => {
      record("getNetworkDetails")({});
      return (
        overrides.networkDetails ?? { network: "TESTNET", networkPassphrase: TESTNET_PASSPHRASE }
      );
    },
    signTransaction: async (xdr, options) => {
      record("signTransaction")({ xdr, options });
      return { signedTxXdr: `signed(${xdr})@${options.networkPassphrase}` };
    },
    signAuthEntry: async (xdr, options) => {
      record("signAuthEntry")({ xdr, options });
      return { signedAuthEntry: `auth(${xdr})` };
    },
    ...overrides,
  };
  return { api, calls };
}

function freighterLoader(api: FreighterApiModule) {
  return async (): Promise<FreighterApiModule> => api;
}

describe("the common connector interface", () => {
  it("exposes the five operations every panel is allowed to ask for", async () => {
    const { api } = createFakeFreighterApi();
    const connector = createFreighterConnector(freighterLoader(api));
    assert.deepEqual(
      [
        typeof connector.connect,
        typeof connector.getPublicKey,
        typeof connector.getNetwork,
        typeof connector.signTransaction,
        typeof connector.signAuthEntry,
      ],
      ["function", "function", "function", "function", "function"],
    );
    assert.equal(connector.id, "freighter");

    const connection = await connector.connect();
    assert.equal(connection.address, ADDRESS);
    assert.equal(connection.network.passphrase, TESTNET_PASSPHRASE);
    assert.equal(await connector.getPublicKey(), ADDRESS);
    assert.deepEqual(await connector.getNetwork(), {
      name: "testnet",
      passphrase: TESTNET_PASSPHRASE,
    });
  });

  it("drives all three providers through that same interface", async () => {
    const { api } = createFakeFreighterApi();
    const connectors = [
      createFreighterConnector(freighterLoader(api)),
      createXbullConnector(createFakeXbull()),
      createAlbedoConnector(createFakeAlbedo()),
    ];
    assert.deepEqual(
      connectors.map((connector) => connector.id),
      ["freighter", "xbull", "albedo"],
    );

    for (const connector of connectors) {
      const connection = await connector.connect();
      assert.match(
        connection.address,
        /^G[A-Z0-9]{55}$/,
        `${connector.id} reports an account address`,
      );
      const signed = await connector.signTransaction("TX_XDR", {
        networkPassphrase: TESTNET_PASSPHRASE,
      });
      assert.ok(signed.length > 0, `${connector.id} returns a signed envelope`);
    }
  });
});

describe("Freighter connector", () => {
  it("surfaces Freighter's error field as an error, because it never throws", async () => {
    const { api } = createFakeFreighterApi({
      requestAccess: async () => ({ error: { message: "user rejected" } }),
    });
    const connector = createFreighterConnector(freighterLoader(api));
    await assert.rejects(() => connector.connect(), /Freighter|rejected/);
  });

  it("refuses a connection that returned no address", async () => {
    const { api } = createFakeFreighterApi({ requestAccess: async () => ({}) });
    await assert.rejects(
      () => createFreighterConnector(freighterLoader(api)).connect(),
      /no account address/,
    );
  });

  it("pins the target passphrase when signing, so a wrong-network signature is impossible", async () => {
    const { api, calls } = createFakeFreighterApi();
    const connector = createFreighterConnector(freighterLoader(api));
    await connector.signTransaction("TX", {
      networkPassphrase: PUBLIC_PASSPHRASE,
      address: ADDRESS,
    });
    assert.deepEqual(calls.signTransaction, [
      { xdr: "TX", options: { networkPassphrase: PUBLIC_PASSPHRASE, address: ADDRESS } },
    ]);
  });

  it("reads a declined auth entry as a refusal, not an empty result", async () => {
    const { api } = createFakeFreighterApi({
      signAuthEntry: async () => ({ signedAuthEntry: null }),
    });
    await assert.rejects(
      () => createFreighterConnector(freighterLoader(api)).signAuthEntry("AUTH"),
      (error: unknown) =>
        error instanceof WalletUserRejectedError && error.provider === "freighter",
    );
  });

  it("reports a wallet that is not installed rather than throwing at import time", async () => {
    const connector = createFreighterConnector(null);
    await assert.rejects(
      () => connector.connect(),
      (error: unknown) => error instanceof WalletNotInstalledError,
    );

    const rejecting = createFreighterConnector(async () => {
      throw new Error("Cannot find module '@stellar/freighter-api'");
    });
    await assert.rejects(
      () => rejecting.getNetwork(),
      (error: unknown) => error instanceof WalletNotInstalledError && Boolean(error.installUrl),
    );
  });
});

// ── xBull ──────────────────────────────────────────────────────────────────

function createFakeXbull(overrides: Partial<XbullProvider> = {}): XbullProvider {
  return {
    connect: async () => ({ publicKey: ADDRESS, network: "testnet" }),
    getPublicKey: async () => ADDRESS,
    getNetwork: async () => "testnet",
    signTransaction: async (xdr) => `xbull:${xdr}`,
    signAuthEntry: async (xdr) => `xbullauth:${xdr}`,
    ...overrides,
  };
}

describe("xBull connector", () => {
  it("builds the passphrase from the network name the wallet reports", async () => {
    const connector = createXbullConnector(createFakeXbull());
    assert.deepEqual(await connector.getNetwork(), {
      name: "testnet",
      passphrase: TESTNET_PASSPHRASE,
    });
    const connection = await connector.connect();
    assert.equal(connection.network.passphrase, TESTNET_PASSPHRASE);
  });

  it("accepts the bare-string connect() some builds answer with", async () => {
    const connector = createXbullConnector(createFakeXbull({ connect: async () => ADDRESS }));
    assert.equal((await connector.connect()).address, ADDRESS);
  });

  it("maps a cancellation onto a refusal the operator can read", async () => {
    const connector = createXbullConnector(
      createFakeXbull({
        connect: async () => {
          throw new Error("User rejected the request");
        },
      }),
    );
    await assert.rejects(
      () => connector.connect(),
      (error: unknown) =>
        error instanceof WalletUserRejectedError &&
        error.provider === "xbull" &&
        /xBull/.test(error.message),
    );
  });

  it("says plainly when a provider cannot sign a Soroban auth entry", async () => {
    // A provider whose injected API has no signAuthEntry at all (as some xBull
    // builds do not): the absent method must read as "unsupported", not crash.
    // It is spelled as an omitted property because exactOptionalPropertyTypes
    // forbids assigning an explicit `undefined` over the fake's default.
    const connector = createXbullConnector({
      connect: async () => ({ publicKey: ADDRESS, network: "testnet" }),
      getNetwork: async () => "testnet",
      signTransaction: async (xdr) => `xbull:${xdr}`,
    });
    await assert.rejects(
      () => connector.signAuthEntry("AUTH"),
      (error: unknown) =>
        error instanceof WalletUnsupportedError && /authorization entries/.test(error.message),
    );
  });

  it("cannot be constructed at all when the extension is absent", () => {
    assert.throws(() => createXbullConnector(null), WalletNotInstalledError);
  });
});

// ── Albedo ─────────────────────────────────────────────────────────────────

function createFakeAlbedo(overrides: Partial<AlbedoProvider> = {}): AlbedoProvider {
  return {
    connect: (args) => {
      const response = { address: ADDRESS, network: "testnet" };
      args.onReady?.(response);
      return Promise.resolve(response);
    },
    network: async () => ({ network: "testnet", networkPassphrase: TESTNET_PASSPHRASE }),
    signedTx: async (args) => `albedo:${String(args.tx)}`,
    signedAuth: async (args) => `albedoauth:${String(args.auth)}`,
    ...overrides,
  };
}

describe("Albedo connector", () => {
  it("resolves through either the promise or the onReady callback", async () => {
    const callbackOnly = createAlbedoConnector({
      connect: (args) => {
        args.onReady?.({ address: ADDRESS, network: "public" });
        return Promise.resolve();
      },
      network: async () => ({ network: "public", networkPassphrase: PUBLIC_PASSPHRASE }),
      signedTx: async () => "x",
      signedAuth: async () => "y",
    });
    const connection = await callbackOnly.connect();
    assert.equal(connection.address, ADDRESS);
    assert.equal(connection.network.passphrase, PUBLIC_PASSPHRASE);

    const promiseOnly = createAlbedoConnector(createFakeAlbedo());
    assert.equal((await promiseOnly.connect()).address, ADDRESS);
  });

  it("prefers the passphrase Albedo reports over its own name lookup", async () => {
    const connector = createAlbedoConnector(
      createFakeAlbedo({
        network: async () => ({ network: "mystery", networkPassphrase: PUBLIC_PASSPHRASE }),
      }),
    );
    assert.deepEqual(await connector.getNetwork(), {
      name: "public",
      passphrase: PUBLIC_PASSPHRASE,
    });
  });

  it("turns Albedo's in-payload error into a refusal", async () => {
    const connector = createAlbedoConnector(
      createFakeAlbedo({ signedTx: async () => ({ error: "user_rejected" }) }),
    );
    await assert.rejects(() => connector.signTransaction("TX"), /Albedo refused the transaction/);
  });

  it("reads an empty auth answer as a decline", async () => {
    const connector = createAlbedoConnector(
      createFakeAlbedo({ signedAuth: async () => ({ auth: "" }) }),
    );
    await assert.rejects(
      () => connector.signAuthEntry("AUTH"),
      (error: unknown) => error instanceof WalletUserRejectedError && error.provider === "albedo",
    );
  });
});

describe("network normalization", () => {
  it("resolves a name to a passphrase and back, which is what makes a mismatch detectable", () => {
    assert.deepEqual(normalizeWalletNetwork({ name: "TESTNET" }), {
      name: "testnet",
      passphrase: TESTNET_PASSPHRASE,
    });
    assert.deepEqual(normalizeWalletNetwork({ name: "public" }).passphrase, PUBLIC_PASSPHRASE);
    assert.deepEqual(normalizeWalletNetwork({ passphrase: TESTNET_PASSPHRASE }), {
      name: "testnet",
      passphrase: TESTNET_PASSPHRASE,
    });
  });

  it("keeps an unfamiliar network identifiable rather than guessing testnet", () => {
    assert.equal(normalizeWalletNetwork({ name: "gorbnet" }).passphrase, "");
    assert.equal(normalizeWalletNetwork({}).name, "unknown");
    assert.equal(
      normalizeWalletNetwork({ passphrase: "Local ; 2030" }).name,
      "unknown",
      "a passphrase we do not recognise is not quietly relabelled",
    );
  });
});

describe("error mapping across providers", () => {
  it("maps each provider's failure vocabulary onto one of three outcomes", () => {
    for (const id of ["freighter", "albedo", "xbull"] as WalletProviderId[]) {
      assert.ok(
        mapConnectorError(new Error("No provider found"), id, "connect") instanceof
          WalletNotInstalledError,
        `${id}: a missing wallet is installable, not broken`,
      );
      assert.ok(
        mapConnectorError(new Error("User rejected the request"), id, "connect") instanceof
          WalletUserRejectedError,
        `${id}: a decline is the operator's own choice`,
      );
      assert.ok(
        mapConnectorError("something odd", id, "connect") instanceof WalletError,
        `${id}: anything else keeps its message`,
      );
    }
    assert.match(
      mapConnectorError("boom", "xbull", "sign the transaction").message,
      /xBull could not sign/,
    );
  });

  it("passes an already-mapped WalletError through unchanged, so nothing is double-wrapped", () => {
    const original = new WalletError("original");
    assert.equal(mapConnectorError(original, "freighter", "connect"), original);
  });

  it("gives a missing wallet somewhere to go", () => {
    const error = new WalletNotInstalledError("xbull");
    assert.match(error.installUrl, /^https:\/\/xbull\.app/);
    assert.ok(error.message.includes("xBull"));
    assert.equal(walletProviderDescriptor("albedo").kind, "web");
  });
});

describe("provider detection and selection", () => {
  it("lists only the wallets this browser can serve", async () => {
    assert.deepEqual(
      await detectInstalledProviders({ freighterLoader: null, albedo: null, xbull: null }),
      [],
    );
    assert.deepEqual(
      await detectInstalledProviders({
        freighterLoader: async () => {
          throw new Error("no extension");
        },
        albedo: createFakeAlbedo(),
        xbull: null,
      }),
      ["albedo"],
    );
    const { api } = createFakeFreighterApi();
    assert.deepEqual(
      await detectInstalledProviders({
        freighterLoader: freighterLoader(api),
        albedo: null,
        xbull: createFakeXbull(),
      }),
      ["freighter", "xbull"],
    );
  });

  it("never prompts for access while detecting", async () => {
    const { api, calls } = createFakeFreighterApi();
    await detectInstalledProviders({
      freighterLoader: freighterLoader(api),
      albedo: null,
      xbull: null,
    });
    assert.equal(calls.requestAccess, undefined, "detection must not open a permission prompt");
    assert.ok(calls.getNetworkDetails);
  });

  it("reads the injected wallet objects off a window-like scope", () => {
    const xbull = createFakeXbull();
    const scope = readWalletScope({ xbull }, null);
    assert.equal(scope.xbull, xbull);
    assert.equal(scope.albedo, null);
  });

  it("knows the three providers and rejects anything else", () => {
    assert.deepEqual(
      WALLET_PROVIDERS.map((provider) => provider.id),
      ["freighter", "albedo", "xbull"],
    );
    assert.equal(isWalletProviderId("metamask"), false);
    assert.equal(isWalletProviderId("xbull"), true);
    assert.equal(isWalletProviderId(null), false);
    assert.equal(isWalletProviderId(42), false);
  });

  it("falls back to Freighter for a stale or unknown stored preference", () => {
    const scope = readWalletScope({ xbull: createFakeXbull() }, null);
    assert.equal(resolveConnector("metamask" as WalletProviderId, scope).id, "freighter");
    assert.equal(resolveConnector(null, scope).id, "freighter");
    assert.equal(resolveConnector("xbull", scope).id, "xbull");
  });

  it("reconnects silently only where reconnecting is silent", () => {
    assert.equal(canReconnectSilently("freighter"), true);
    assert.equal(canReconnectSilently("xbull"), true);
    assert.equal(
      canReconnectSilently("albedo"),
      false,
      "a web wallet must never open a popup on load",
    );
    assert.equal(canReconnectSilently(null), true);
  });
});

describe("preferred provider persistence", () => {
  function createMockStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      raw: () => map.get(PREFERRED_WALLET_STORAGE_KEY) ?? null,
    };
  }

  it("round-trips the operator's choice", () => {
    const storage = createMockStorage();
    assert.equal(loadPreferredProvider(storage), null);
    savePreferredProvider("albedo", storage);
    assert.equal(storage.raw(), "albedo");
    assert.equal(loadPreferredProvider(storage), "albedo");
  });

  it("ignores a value that is not a provider we can drive", () => {
    const storage = createMockStorage({ [PREFERRED_WALLET_STORAGE_KEY]: "evil" });
    assert.equal(loadPreferredProvider(storage), null);
  });

  it("is inert without storage", () => {
    assert.equal(loadPreferredProvider(null), null);
    assert.doesNotThrow(() => savePreferredProvider("xbull", null));
  });
});

describe("adapting a connector to the dashboard's signer", () => {
  it("is shaped exactly like WalletSigner and pins the target passphrase", async () => {
    const { api, calls } = createFakeFreighterApi();
    const signer = connectorSigner(
      createFreighterConnector(freighterLoader(api)),
      ADDRESS,
      TESTNET_PASSPHRASE,
    );
    assert.equal(typeof signer.signTransaction, "function");
    assert.equal(typeof signer.signAuthEntry, "function");
    assert.equal(signer.address, ADDRESS);

    assert.equal(await signer.signTransaction("TX"), `signed(TX)@${TESTNET_PASSPHRASE}`);
    assert.equal(await signer.signAuthEntry("AUTH"), "auth(AUTH)");
    assert.deepEqual((calls.signTransaction as unknown[])[0], {
      xdr: "TX",
      options: { networkPassphrase: TESTNET_PASSPHRASE, address: ADDRESS },
    });
  });

  it("maps a provider failure through the signer boundary too", async () => {
    const { api } = createFakeFreighterApi({
      signTransaction: async () => ({ error: { message: "user rejected" } }),
    });
    const signer = connectorSigner(
      createFreighterConnector(freighterLoader(api)),
      ADDRESS,
      TESTNET_PASSPHRASE,
    );
    await assert.rejects(
      () => signer.signTransaction("TX"),
      (error: unknown) => error instanceof WalletError,
    );
  });
});

/**
 * The live account binding (#340).
 *
 * The signer a write uses must be able to re-read the active address at each
 * write boundary without raising a wallet prompt. A provider with no silent
 * read exposes no reader at all, rather than reporting every write as a
 * disconnect.
 */
describe("the signer's live account binding", () => {
  const SECOND_ADDRESS = "GA76DICZHOAA3L2OUCHG4X6J6DMM2NDEPLUWMK4PVLR2YTXZADHJZIXD";

  it("exposes a silent live-address reader on the Freighter signer", async () => {
    const { api, calls } = createFakeFreighterApi();
    const signer = connectorSigner(
      createFreighterConnector(freighterLoader(api)),
      ADDRESS,
      TESTNET_PASSPHRASE,
    );
    assert.equal(await signer.currentAddress!(), ADDRESS);
    assert.equal((calls.getAddress ?? []).length, 1);
  });

  it("reports a newly selected account immediately", async () => {
    let active = ADDRESS;
    const { api } = createFakeFreighterApi({
      getAddress: async () => ({ address: active }),
    });
    const signer = connectorSigner(
      createFreighterConnector(freighterLoader(api)),
      ADDRESS,
      TESTNET_PASSPHRASE,
    );
    active = SECOND_ADDRESS;
    assert.equal(await signer.currentAddress!(), SECOND_ADDRESS);
  });

  it("returns null when the extension has gone away", async () => {
    const { api } = createFakeFreighterApi({
      getAddress: async () => {
        throw new Error("the provider disconnected");
      },
    });
    const signer = connectorSigner(
      createFreighterConnector(freighterLoader(api)),
      ADDRESS,
      TESTNET_PASSPHRASE,
    );
    assert.equal(await signer.currentAddress!(), null);
  });

  it("omits the reader for a provider whose only address read prompts", () => {
    const albedo: AlbedoProvider = {
      connect: async () => ({ address: ADDRESS, network: "testnet" }),
      network: async () => ({ network: "testnet", networkPassphrase: TESTNET_PASSPHRASE }),
      signedTx: async () => "signed",
      signedAuth: async () => "auth",
    };
    const signer = connectorSigner(createAlbedoConnector(albedo), ADDRESS, TESTNET_PASSPHRASE) as {
      currentAddress?: () => Promise<string | null>;
    };
    assert.equal("currentAddress" in signer, false);
  });
});
