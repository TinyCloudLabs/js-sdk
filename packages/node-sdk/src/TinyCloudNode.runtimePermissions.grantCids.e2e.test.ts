import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { activateValidatedRuntimeDelegation } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode, type PortableDelegation } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/grant-cids.");
if (!testHome.startsWith("/var/tmp/grant-cids.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

// Two apps asking for the same access each get a grant signed for them; a check names the grants it counts; a grant
// kept as JSON (the way a page reload keeps it) is activated again from its signed bytes.
describe.skipIf(!nodeBinary)(
  "runtime grants per app on a real node",
  () => {
    let node: LocalNode | undefined;
    let registry: UnregisteredLocationRegistry;
    let owner: TinyCloudNode;
    let wallet: PrivateKeySigner;
    let space: string;

    const approvals: string[] = [];
    const signMessage = (siwe: string) => {
      approvals.push(siwe);
      return wallet.signMessage(siwe);
    };
    const entry = (): PermissionEntry => ({
      service: "tinycloud.kv",
      space,
      path: "apps/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    });

    beforeAll(async () => {
      registry = startUnregisteredLocationRegistry();
      node = await startLocalNode(nodeBinary!, "/var/tmp/grant-cids-node-");
      const privateKey = randomBytes(32).toString("hex");
      wallet = new PrivateKeySigner(privateKey);
      owner = new TinyCloudNode({
        host: node.host,
        tinycloudRegistryUrl: registry.url.origin,
        privateKey,
        wasmBindings: new NodeWasmBindings(),
        domain: "grant-cids.test",
        autoCreateSpace: true,
      });
      await owner.signIn();
      await owner.waitForAccountRegistrySync();
      space = await owner.ensureOwnedSpaceHosted("alpha");
    }, 120_000);

    afterAll(async () => {
      await node?.stop();
      registry?.stop(true);
    });

    let first: PortableDelegation;
    let second: PortableDelegation;

    test("a second app gets its own signed grant for access the first app's grant already covers", async () => {
      approvals.length = 0;
      [first] = await owner.grantRuntimePermissions([entry()], { signMessage });
      expect(approvals).toHaveLength(1);

      const reused = await owner.grantRuntimePermissions([entry()], { signMessage });
      expect(reused.map((delegation) => delegation.cid)).toEqual([first!.cid]);
      expect(approvals).toHaveLength(1);

      [second] = await owner.grantRuntimePermissions([entry()], { signMessage, reuseExisting: false });
      expect(approvals).toHaveLength(2);
      expect(second!.cid).not.toBe(first!.cid);

      expect(owner.hasRuntimePermissions([entry()], { grantCids: [first!.cid] })).toBe(true);
      expect(owner.hasRuntimePermissions([entry()], { grantCids: [second!.cid] })).toBe(true);
      expect(owner.hasRuntimePermissions([entry()], { grantCids: ["bafy-not-installed"] })).toBe(false);
      expect(owner.getRuntimePermissionDelegations([entry()], { grantCids: [second!.cid] }).map((delegation) => delegation.cid)).toEqual([second!.cid]);
      const put = await owner.kvForSpace(space).put("apps/key", "value");
      expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
    }, 120_000);

    test("a grant kept as JSON is activated again from its signed bytes and keeps its signed expiry", async () => {
      const kept = JSON.parse(JSON.stringify(second!)) as Record<string, unknown>;
      const restored = { ...kept, expiry: new Date(String(kept.expiry)) } as unknown as PortableDelegation;
      Reflect.set(owner, "runtimePermissionGrants", []);
      expect(owner.hasRuntimePermissions([entry()])).toBe(false);

      const validated = await activateValidatedRuntimeDelegation(owner, restored, { host: node!.host, authorize: () => true });

      expect(validated.cid).toBe(second!.cid);
      expect(validated.expiry.getTime()).toBe(second!.expiry.getTime());
      expect(owner.hasRuntimePermissions([entry()], { grantCids: [second!.cid] })).toBe(true);
      expect(owner.hasRuntimePermissions([entry()], { grantCids: [first!.cid] })).toBe(false);
      const got = await owner.kvForSpace(space).get<string>("apps/key");
      expect(got.ok && got.data.data).toBe("value");
    }, 120_000);
  },
);
