import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/manifest-first-sign-in.");
if (!testHome.startsWith("/var/tmp/manifest-first-sign-in.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

// A wallet-mode client signs its account's setup sessions itself on the first
// sign-in. Its own calls must still run on the manifest's session afterwards.
describe.skipIf(!nodeBinary)("a wallet-mode first sign-in is bounded by its manifest", () => {
  let node: LocalNode | undefined;
  let registry: UnregisteredLocationRegistry;
  let client: TinyCloudNode;
  const proofs: unknown[] = [];
  const networkCreates: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    node = await startLocalNode(nodeBinary!, "/var/tmp/manifest-first-sign-in-node-");
    client = new TinyCloudNode({
      host: node.host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey: randomBytes(32).toString("hex"),
      wasmBindings: new NodeWasmBindings(),
      domain: "notes.example.com",
      autoCreateSpace: true,
      manifest: {
        app_id: "com.example.notes",
        name: "Notes",
        defaults: false,
        permissions: [{ service: "tinycloud.kv", path: "first-record", actions: ["get", "put"] }],
      },
    });
    await client.signIn();
    expect(client.bootstrapStatus.skipped).toBe(false);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/encryption/networks") && init?.method === "POST") networkCreates.push(url);
      if (url.endsWith("/invoke")) {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        proofs.push(JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString()).prf);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await node?.stop();
    registry?.stop(true);
  });

  test("the declared key works and anything else in applications is refused, both on the app's own session", async () => {
    const mainSession = client.session!.delegationCid;
    expect(client.spaceId).toEndWith(":applications");

    proofs.length = 0;
    const declared = await client.kv.withPrefix("com.example.notes").put("first-record", 1);
    expect(declared.ok, JSON.stringify(declared.ok ? undefined : declared.error)).toBe(true);
    const undeclared = await client.kv.put("zzz-other", 1);
    expect(undeclared.ok ? undefined : undeclared.error.code).toBe("AUTH_UNAUTHORIZED");

    expect(proofs).toEqual([[mainSession], [mainSession]]);
  }, 120_000);

  test("createEncryptionNetwork on the network setup already created returns it without a network.create", async () => {
    networkCreates.length = 0;
    const created = await client.createEncryptionNetwork("default");
    expect(created.networkId).toBe(client.getDefaultEncryptionNetworkId("default"));
    expect(networkCreates).toEqual([]);
  }, 120_000);
});
