import { NETWORK } from "../lib/guard/network.ts";

export function rpcHostname(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).hostname || rpcUrl;
  } catch (error) {
    if (error instanceof TypeError) return rpcUrl;
    throw error;
  }
}

export function ConfigureNetworkContext({
  networkName = NETWORK.name,
  rpcUrl = NETWORK.rpcUrl,
}: {
  networkName?: string;
  rpcUrl?: string;
}) {
  return (
    <div className="configure-network-context" aria-label="Configured network">
      <span className="pill" data-testid="configure-network-name">
        {networkName}
      </span>
      <code className="configure-network-host" data-testid="configure-rpc-hostname" title={rpcUrl}>
        {rpcHostname(rpcUrl)}
      </code>
    </div>
  );
}
