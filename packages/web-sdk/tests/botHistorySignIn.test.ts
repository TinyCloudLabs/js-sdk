import "./support/browserGlobalsShim";
import { expect, test } from "bun:test";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { startUnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";
import type { TinyCloudWeb as Web } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../dist/index.cjs") as { TinyCloudWeb: typeof Web };
const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("OpenKey base sign-in refuses the reserved bot-history key before asking for a signature", async () => {
  const registry = startUnregisteredLocationRegistry();
  const node = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/info") {
      return Response.json({ protocol: 1, version: "1.26.21", features: ["encryption-named-keys-v1"] });
    }
    return new Response(null, { status: 404 });
  }});
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener: () => undefined, removeEventListener: () => undefined,
  } as unknown as Window & typeof globalThis;
  let signRequests = 0;
  try {
    const web = await TinyCloudWeb.create({
      provider: {
        async request({ method }: { method: string }) {
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
          if (method === "eth_chainId") return "0x1";
          throw new Error(`Unexpected wallet request: ${method}`);
        },
      } as never,
      openkey: { client: { authorizeTinyCloud() { signRequests++; throw new Error("Unexpected OpenKey approval"); } } as never },
      manifest: {
        manifest_version: 1, app_id: "xyz.tinycloud.bot-history-fixture", name: "Bot history fixture",
        space: "applications", defaults: false, permissions: [{
          service: "tinycloud.encryption",
          path: `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default/${BOT_HISTORY_KEY_PATH}`,
          actions: ["decrypt", "key.create"],
        }],
      },
      tinycloudHosts: [node.url.origin], tinycloudRegistryUrl: registry.url.origin,
      autoDiscoverLocalNode: false, persistSession: false, autoCreateSpace: false, autoBootstrapAccount: false, ui: false,
    });
    await expect(web.prepareSignIn()).rejects.toThrow("named keys go in manifest.keys");
    expect(signRequests).toBe(0);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    node.stop(true);
    registry.stop(true);
  }
});
