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
const testHome = mkdtempSync("/var/tmp/generic-folder-port.");
if (!testHome.startsWith("/var/tmp/generic-folder-port.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

// An app that declares nothing gets a folder named by its host and port. Two apps on one host
// and different ports, signed in by the same owner, each work in their own folder only.
describe.skipIf(!nodeBinary)("the generic folder keeps the port", () => {
  let node: LocalNode | undefined;
  let registry: UnregisteredLocationRegistry;
  let withPort: TinyCloudNode;
  let withoutPort: TinyCloudNode;

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    node = await startLocalNode(nodeBinary!, "/var/tmp/generic-folder-port-node-");
    const privateKey = randomBytes(32).toString("hex");
    const client = (domain: string) => new TinyCloudNode({
      host: node!.host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey,
      wasmBindings: new NodeWasmBindings(),
      domain,
      autoCreateSpace: true,
    });
    withPort = client("notes.example.com:8443");
    await withPort.signIn();
    withoutPort = client("notes.example.com");
    await withoutPort.signIn();
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
    registry?.stop(true);
  });

  test("each app writes and reads its own folder", async () => {
    expect(withPort.capabilityRequest?.manifests.map((manifest) => manifest.app_id)).toEqual(["com.example.notes_8443"]);
    expect(withoutPort.capabilityRequest?.manifests.map((manifest) => manifest.app_id)).toEqual(["com.example.notes"]);
    for (const [client, folder] of [[withPort, "com.example.notes_8443"], [withoutPort, "com.example.notes"]] as const) {
      const put = await client.kv.withPrefix(folder).put("note", folder);
      expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
      const read = await client.kv.withPrefix(folder).get<string>("note");
      expect(read.ok ? read.data.data : read.error.code).toBe(folder);
    }
  }, 120_000);

  test("neither app can read or write the other's folder", async () => {
    for (const [client, other] of [[withPort, "com.example.notes"], [withoutPort, "com.example.notes_8443"]] as const) {
      const read = await client.kv.withPrefix(other).get("note");
      expect(read.ok ? "read" : read.error.code).toBe("AUTH_UNAUTHORIZED");
      const put = await client.kv.withPrefix(other).put("note", "overwritten");
      expect(put.ok ? "written" : put.error.code).toBe("AUTH_UNAUTHORIZED");
    }
  }, 120_000);
});
