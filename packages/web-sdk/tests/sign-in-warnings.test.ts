import "./support/browserGlobalsShim";
import { expect, test } from "bun:test";
import { extractRecapAttenuations, REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudWeb as Web } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../dist/index.cjs") as { TinyCloudWeb: typeof Web };

test("Web sign-in adds the node's omitted-resource warning to the returned session only", async () => {
  const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const key = `urn:tinycloud:encryption:did:pkh:eip155:1:${account.address}:default/secrets/api_key`;
  const spaceId = `tinycloud:pkh:eip155:1:${account.address}:default`;
  const feature = "encryption-named-keys-v1";
  let features = ["encryption"];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (/^\/v[12]\/locations\//.test(path)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/info") return Response.json({ protocol: 1, version: "test", features });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [spaceId], skipped: [] });
    return new Response(`Unexpected request: ${request.method} ${path}`, { status: 500 });
  } });
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: new URL("https://home.tinycloud.xyz"), addEventListener() {}, removeEventListener() {},
  } as unknown as typeof globalThis.window;
  let web: Web | undefined;
  try {
    web = await TinyCloudWeb.create({
      provider: { async request({ method, params }: { method: string; params?: [`0x${string}`] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") return account.signMessage({ message: { raw: params![0] } });
        throw new Error(`Unexpected wallet method: ${method}`);
      } },
      manifest: {
        app_id: "test", name: "Sign-in warnings fixture", space: "default", prefix: "", defaults: false,
        includePublicSpace: false,
        permissions: [
          { service: "tinycloud.kv", path: "notes/", actions: ["get"] },
          { service: "tinycloud.encryption", path: key, actions: ["decrypt"] },
        ],
      },
      tinycloudHosts: [server.url.origin], tinycloudRegistryUrl: server.url.origin,
      autoDiscoverLocalNode: false, autoCreateSpace: false, autoBootstrapAccount: false, persistSession: false, ui: false,
    });
    const result = await web.signIn();
    expect(result.address).toBe(account.address);
    expect(result.warnings).toEqual([{
      code: "NODE_FEATURE_UNAVAILABLE", feature, resources: [key],
    }]);
    expect(extractRecapAttenuations(result.siwe)[key]).toBeUndefined();
    expect(web.session()!.siwe).toBe(result.siwe);
    expect(web.session()).not.toHaveProperty("warnings");

    features = [...features, feature];
    const named = await web.signIn();
    expect(named).not.toHaveProperty("warnings");
    expect(extractRecapAttenuations(named.siwe)[key]?.["tinycloud.encryption/decrypt"]).toBeDefined();
  } finally {
    web?.cleanup();
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    server.stop(true);
  }
});
