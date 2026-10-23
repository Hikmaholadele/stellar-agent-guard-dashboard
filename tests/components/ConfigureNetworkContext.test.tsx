import assert from "node:assert/strict";
import { test } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { ConfigureNetworkContext, rpcHostname } from "../../components/ConfigureNetworkContext.tsx";

test("configure network context shows the network and full RPC hostname", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "futurenet",
          rpcUrl: "https://rpc.example.test/soroban",
        }),
      );
    });

    assert.equal(
      container.querySelector('[data-testid="configure-network-name"]')?.textContent,
      "futurenet",
    );
    const hostname = container.querySelector<HTMLElement>('[data-testid="configure-rpc-hostname"]');
    assert.equal(hostname?.textContent, "rpc.example.test");
    assert.equal(hostname?.title, "https://rpc.example.test/soroban");
    assert.equal(container.querySelector("button, select"), null);
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("RPC hostname extraction keeps malformed endpoint configuration visible", () => {
  assert.equal(rpcHostname("not a URL"), "not a URL");
});
