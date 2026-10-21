/**
 * The Freighter wallet adapter.
 *
 * This is the only module in the guard library that touches a browser
 * extension, which is deliberate: everything else takes a `WalletSigner`, so the
 * same code paths run headlessly in Node against a keypair-backed signer and in
 * the browser against the operator's wallet.
 *
 * The dashboard never receives, stores or transmits a secret key. Every
 * signature is produced inside the wallet, over a payload the wallet displays.
 */

import type { WalletSigner } from "./submit.ts";

/**
 * The extension API, loaded on demand rather than at module load.
 *
 * The package ships a minified CJS bundle, and Node's ESM loader cannot see
 * its named exports — a top-level import would make this module, and every
 * panel that transitively imports it, unloadable in unit tests. The browser
 * build bundles it either way (this module already used a dynamic import for
 * `getNetworkDetails`), so this only defers *when* the bundle is evaluated.
 */
function freighter(): Promise<typeof import("@stellar/freighter-api")> {
  return import("@stellar/freighter-api");
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

/** Freighter reports failures in a field rather than by throwing; surface them as errors. */
interface WithError {
  error?: { message?: string } | null;
}

function assertNoError(result: unknown, action: string): void {
  const error = (result as WithError | null)?.error;
  if (error) {
    throw new WalletError(
      `${action} failed in the wallet: ${error.message ?? JSON.stringify(error)}`,
    );
  }
}

export interface ConnectedWallet {
  address: string;
  networkPassphrase: string;
  network: string;
}

/**
 * Ask the wallet for access and report which network it is on.
 *
 * The network is returned rather than assumed because it decides whether the
 * dashboard may proceed at all: signing a call against a guard address on
 * testnet while the wallet is pointed at pubnet produces a signature over a
 * different network id, so the correct behaviour is to refuse up front rather
 * than to let the operator approve something that cannot work.
 */
export async function connectWallet(): Promise<ConnectedWallet> {
  const { requestAccess } = await freighter();
  const granted = await requestAccess();
  assertNoError(granted, "requestAccess");
  const address = (granted as { address?: string }).address;
  if (!address) throw new WalletError("the wallet returned no address");

  const network = await getNetworkPassphrase();
  return { address, networkPassphrase: network.passphrase, network: network.network };
}

/** The wallet's current address, if access was already granted. */
export async function currentAddress(): Promise<string | null> {
  const { getAddress } = await freighter();
  const result = await getAddress();
  if ((result as WithError).error) return null;
  return (result as { address?: string }).address ?? null;
}

/**
 * The wallet's current connection without prompting for access, or null when it
 * has not granted any.
 *
 * The network is *read* rather than assumed, for the same reason
 * `connectWallet` reads it: a wallet on a different network cannot authorize a
 * call on this one. Adopting the dashboard's network here instead would let a
 * mismatched wallet quietly enable writes after a navigation, which is the
 * exact failure this pairing exists to prevent.
 */
export async function currentWallet(): Promise<ConnectedWallet | null> {
  const address = await currentAddress();
  if (!address) return null;
  const network = await getNetworkPassphrase();
  return { address, networkPassphrase: network.passphrase, network: network.network };
}

async function getNetworkPassphrase(): Promise<{ network: string; passphrase: string }> {
  const details = await import("@stellar/freighter-api").then((api) => api.getNetworkDetails());
  assertNoError(details, "getNetworkDetails");
  const record = details as { network?: string; networkPassphrase?: string };
  return {
    network: record.network ?? "UNKNOWN",
    passphrase: record.networkPassphrase ?? "",
  };
}

/**
 * A `WalletSigner` backed by the extension.
 *
 * `networkPassphrase` is pinned by the caller to the network the dashboard is
 * configured for, so the wallet is asked to sign for that network explicitly
 * rather than for whatever it happens to be showing.
 */
export function freighterSigner(address: string, networkPassphrase: string): WalletSigner {
  return {
    address,
    async signTransaction(transactionXdr: string): Promise<string> {
      const { signTransaction } = await freighter();
      const result = await signTransaction(transactionXdr, { networkPassphrase, address });
      assertNoError(result, "signTransaction");
      const signed = (result as { signedTxXdr?: string }).signedTxXdr;
      if (!signed) throw new WalletError("the wallet returned no signed transaction");
      return signed;
    },
    async signAuthEntry(entryXdr: string): Promise<string> {
      const { signAuthEntry } = await freighter();
      const result = await signAuthEntry(entryXdr, { networkPassphrase, address });
      assertNoError(result, "signAuthEntry");
      const signed = (result as { signedAuthEntry?: string | null }).signedAuthEntry;
      if (!signed) {
        throw new WalletError(
          "the wallet declined to sign the authorization entry; the call was not submitted",
        );
      }
      return signed;
    },
  };
}
