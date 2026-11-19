import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { MissingSpacesError } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/multi-space-grant.");
if (!testHome.startsWith("/var/tmp/multi-space-grant.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

// A runtime permission request across N spaces is one SIWE with a per-space
// ReCap, so the owner approves (signs) once; each space's grant then works.
describe.skipIf(!nodeBinary)(
  "grantRuntimePermissions across spaces on a real node",
  () => {
    let node: LocalNode | undefined;
    let registry: UnregisteredLocationRegistry;
    let owner: TinyCloudNode;
    let wallet: PrivateKeySigner;
    let spaces: Record<"alpha" | "beta" | "gamma", string>;
    let missingSpace: string;

    // The owner's approval: every SIWE the grant asks to have signed.
    const approvals: string[] = [];
    const signMessage = (siwe: string) => {
      approvals.push(siwe);
      return wallet.signMessage(siwe);
    };

    const kvEntry = (space: string, path: string): PermissionEntry => ({
      service: "tinycloud.kv",
      space,
      path,
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    });

    async function expectKvWorks(space: string, key: string): Promise<void> {
      const put = await owner.kvForSpace(space).put(key, "value");
      expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
      const got = await owner.kvForSpace(space).get<string>(key);
      expect(got.ok && got.data.data).toBe("value");
    }

    beforeAll(async () => {
      registry = startUnregisteredLocationRegistry();
      node = await startLocalNode(nodeBinary!, "/var/tmp/multi-space-grant-node-");
      const privateKey = randomBytes(32).toString("hex");
      wallet = new PrivateKeySigner(privateKey);
      owner = new TinyCloudNode({
        host: node.host,
        tinycloudRegistryUrl: registry.url.origin,
        privateKey,
        wasmBindings: new NodeWasmBindings(),
        domain: "multi-space-grant.test",
        autoCreateSpace: true,
      });
      await owner.signIn();
      await owner.waitForAccountRegistrySync();
      spaces = {
        alpha: await owner.ensureOwnedSpaceHosted("alpha"),
        beta: await owner.ensureOwnedSpaceHosted("beta"),
        gamma: await owner.ensureOwnedSpaceHosted("gamma"),
      };
      missingSpace = owner.spaceId!.replace(/:default$/, `:missing${randomBytes(4).toString("hex")}`);
    }, 120_000);

    afterAll(async () => {
      await node?.stop();
      registry?.stop(true);
    });

    test("two spaces: one approval, and each space's access works", async () => {
      // The session alone does not reach these spaces.
      const before = await owner.kvForSpace(spaces.alpha).get("two/key");
      expect(before.ok ? undefined : before.error.code).toBe("AUTH_UNAUTHORIZED");

      approvals.length = 0;
      const delegations = await owner.grantRuntimePermissions(
        [kvEntry(spaces.alpha, "two/"), kvEntry(spaces.beta, "two/")],
        { signMessage },
      );
      expect(approvals).toHaveLength(1);
      expect(delegations.map((delegation) => delegation.spaceId)).toEqual([spaces.alpha, spaces.beta]);
      expect(new Set(delegations.map((delegation) => delegation.cid)).size).toBe(1);
      await expectKvWorks(spaces.alpha, "two/key");
      await expectKvWorks(spaces.beta, "two/key");
    }, 120_000);

    test("three spaces: one approval, and each space's access works", async () => {
      approvals.length = 0;
      const delegations = await owner.grantRuntimePermissions(
        [kvEntry(spaces.alpha, "three/"), kvEntry(spaces.beta, "three/"), kvEntry(spaces.gamma, "three/")],
        { signMessage },
      );
      expect(approvals).toHaveLength(1);
      expect(delegations.map((delegation) => delegation.spaceId)).toEqual([spaces.alpha, spaces.beta, spaces.gamma]);
      for (const space of Object.values(spaces)) await expectKvWorks(space, "three/key");
    }, 120_000);

    test("a missing space gets no grant and is reported; the existing space's grant works", async () => {
      approvals.length = 0;
      const error = await owner.grantRuntimePermissions(
        [kvEntry(spaces.alpha, "mixed/"), kvEntry(missingSpace, "mixed/")],
        { signMessage },
      ).then(() => undefined, (caught: unknown) => caught);
      expect(approvals).toHaveLength(1);
      expect(error).toBeInstanceOf(MissingSpacesError);
      const missing = error as MissingSpacesError;
      expect(missing.code).toBe("SPACE_NOT_FOUND");
      expect(missing.missingSpaceIds).toEqual([missingSpace]);
      expect(missing.delegations.map((delegation) => delegation.spaceId)).toEqual([spaces.alpha]);
      await expectKvWorks(spaces.alpha, "mixed/key");
      // Nothing is installed for the missing space.
      expect(owner.getRuntimePermissionDelegations([kvEntry(missingSpace, "mixed/")])).toEqual([]);
    }, 120_000);

    test("a request for only a missing space returns no delegation and does not create the space", async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        approvals.length = 0;
        const error = await owner.grantRuntimePermissions([kvEntry(missingSpace, `only${attempt}/`)], { signMessage })
          .then(() => undefined, (caught: unknown) => caught);
        expect(approvals).toHaveLength(1);
        expect(error).toBeInstanceOf(MissingSpacesError);
        expect((error as MissingSpacesError).missingSpaceIds).toEqual([missingSpace]);
        expect((error as MissingSpacesError).delegations).toEqual([]);
      }
      // The second attempt was answered by the node: the space still does not
      // exist, so the first attempt did not create it.
    }, 120_000);

    test("a space the account does not own is refused before any approval", async () => {
      const otherAddress = await new PrivateKeySigner(randomBytes(32).toString("hex")).getAddress();
      const foreign = `tinycloud:pkh:eip155:1:${otherAddress}:default`;
      approvals.length = 0;
      const error = await owner.grantRuntimePermissions(
        [kvEntry(spaces.alpha, "foreign/"), kvEntry(foreign, "foreign/")],
        { signMessage },
      ).then(() => undefined, (caught: unknown) => caught);
      expect(approvals).toHaveLength(0);
      expect(error).toMatchObject({ code: "SPACE_NOT_OWNED", spaceIds: [foreign] });
    }, 120_000);
  },
);
