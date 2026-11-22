import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { secretReadPermissions, type InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import type { DelegatedAccess } from "./DelegatedAccess";
import { deserializeDelegation, serializeDelegation, type PortableDelegation } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/delegated-encryption.");
if (!testHome.startsWith("/var/tmp/delegated-encryption.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

// An embedded app runs a session-only node (no wallet, no SIWE session of its
// own) and receives one delegation per space from the host's session. Its
// DelegatedAccess decrypts and reads secrets under that delegation alone.
describe.skipIf(!nodeBinary)(
  "DelegatedAccess decrypts under the delegation on a real node",
  () => {
    let node: LocalNode | undefined;
    let host: string;
    let registry: UnregisteredLocationRegistry;
    let owner: TinyCloudNode;
    let secretsSpace: string;
    let primarySpace: string;
    let networkId: string;
    let envelope: InlineEncryptedEnvelope;

    const plaintext = new TextEncoder().encode("delegated plaintext");

    const sessionOnlyChild = () =>
      new TinyCloudNode({
        host,
        tinycloudRegistryUrl: registry.url.origin,
        wasmBindings: new NodeWasmBindings(),
        autoBootstrapAccount: false,
      });

    // The host side: `delegateTo` the child's bare session DID, then the wire
    // round trip an iframe sees.
    async function grant(
      recipient: TinyCloudNode,
      entries: Parameters<TinyCloudNode["delegateTo"]>[1],
      expiry: string | number = "1h",
    ): Promise<{ delegation: PortableDelegation; access: DelegatedAccess }> {
      const issued = await owner.delegateTo(recipient.did.split("#")[0]!, entries, {
        expiry,
        disableSubDelegation: true,
      });
      const delegation = deserializeDelegation(serializeDelegation(issued.delegation));
      return { delegation, access: await recipient.useDelegation(delegation) };
    }

    // Decrypt on the secret's own key (TC-3284), derived from the KV path. A
    // child can't hold the `secrets/` key prefix (TC-2140), so the
    // all-secrets grant names API_KEY's key: the one secret those tests read.
    const secretsEntries = (path = "vault/secrets/") => [
      { service: "tinycloud.kv", space: secretsSpace, path, actions: ["get"] },
      secretReadPermissions(networkId, path.slice("vault/secrets/".length) || "API_KEY")[1],
    ];

    const decrypt = (access: DelegatedAccess) =>
      access.encryption.decryptEnvelope(envelope, { proofs: [access.restorable.delegationCid] });

    beforeAll(async () => {
      registry = startUnregisteredLocationRegistry();
      node = await startLocalNode(nodeBinary!, "/var/tmp/delegated-encryption-node-");
      host = node.host;

      owner = new TinyCloudNode({
        host,
        tinycloudRegistryUrl: registry.url.origin,
        privateKey: randomBytes(32).toString("hex"),
        wasmBindings: new NodeWasmBindings(),
        domain: "delegated-encryption.test",
        autoCreateSpace: true,
      });
      await owner.signIn();
      await owner.waitForAccountRegistrySync();
      primarySpace = owner.spaceId!;
      secretsSpace = await owner.ensureOwnedSpaceHosted("secrets");
      const network = await owner.ensureEncryptionNetwork();
      networkId = network.networkId;
      for (const [space, name, value] of [
        [secretsSpace, "API_KEY", "secrets-space-value"],
        [secretsSpace, "OTHER_KEY", "other-value"],
        [primarySpace, "PRIMARY_KEY", "primary-space-value"],
      ] as const) {
        const put = await owner.secretsForSpace(space).put(name, value);
        expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
      }
      const encrypted = await owner.encryption.encryptToNetwork(networkId, plaintext);
      if (!encrypted.ok) throw new Error(JSON.stringify(encrypted.error));
      envelope = encrypted.data;
    }, 120_000);

    afterAll(async () => {
      await node?.stop();
      registry?.stop(true);
    });

    test("a session-only child decrypts and reads a secret with only the delegation", async () => {
      const recipient = sessionOnlyChild();
      expect(recipient.isSessionOnly).toBe(true);
      const { access } = await grant(recipient, secretsEntries());

      expect(await access.readSecret({ name: "API_KEY" })).toEqual({
        status: "ok",
        value: "secrets-space-value",
      });
      const decrypted = await decrypt(access);
      expect(decrypted.ok, JSON.stringify(decrypted.ok ? undefined : decrypted.error)).toBe(true);
      expect(decrypted.ok && new TextDecoder().decode(decrypted.data)).toBe("delegated plaintext");
      // The child never became signed in: nothing outside the access gained authority.
      expect(recipient.isSessionOnly).toBe(true);
      expect(recipient.restorableSession).toBeUndefined();
    }, 120_000);

    test("without a decrypt grant the secret read is refused at decrypt", async () => {
      const { access } = await grant(sessionOnlyChild(), [secretsEntries()[0]!]);
      const result = await access.readSecret({ name: "API_KEY" });
      expect(result.status).toBe("permission_required");
      expect(result.status === "permission_required" && result.hint.service).toBe("tinycloud.encryption");
    }, 120_000);

    test("after the owner revokes the delegation, decrypt and secret reads fail", async () => {
      const { delegation, access } = await grant(sessionOnlyChild(), secretsEntries());
      expect((await access.readSecret({ name: "API_KEY" })).status).toBe("ok");

      const receipt = await owner.revokeDelegation(delegation.cid);
      expect(receipt.ok, JSON.stringify(receipt.ok ? undefined : receipt.error)).toBe(true);

      const decrypted = await decrypt(access);
      expect(decrypted.ok).toBe(false);
      expect((await access.readSecret({ name: "API_KEY" })).status).not.toBe("ok");
    }, 120_000);

    test("a delegation for one space cannot read another space's secret", async () => {
      const recipient = sessionOnlyChild();
      const { delegation, access } = await grant(recipient, secretsEntries());
      // The other space's record is not in this space.
      expect(await access.readSecret({ name: "PRIMARY_KEY" })).toEqual({ status: "not_found" });

      // Point the same signed chain at the owner's primary space: the node
      // binds it to the space it was issued for.
      const retargeted = await recipient.useDelegation({ ...delegation, spaceId: primarySpace });
      const result = await retargeted.readSecret({ name: "PRIMARY_KEY" });
      expect(result).not.toHaveProperty("value");
      expect(["permission_required", "read_failed"]).toContain(result.status);
      const record = await retargeted.kv.get("vault/secrets/PRIMARY_KEY");
      expect(record.ok ? undefined : record.error.code).toBe("AUTH_UNAUTHORIZED");
    }, 120_000);

    test("a delegation for one secret cannot read another secret", async () => {
      const { access } = await grant(sessionOnlyChild(), secretsEntries("vault/secrets/API_KEY"));
      expect(await access.readSecret({ name: "API_KEY" })).toEqual({
        status: "ok",
        value: "secrets-space-value",
      });
      const other = await access.readSecret({ name: "OTHER_KEY" });
      expect(other).not.toHaveProperty("value");
      expect(["permission_required", "read_failed"]).toContain(other.status);
      const record = await access.kv.get("vault/secrets/OTHER_KEY");
      expect(record.ok ? undefined : record.error.code).toBe("AUTH_UNAUTHORIZED");
    }, 120_000);

    test("a named-key grant for secret A decrypts A and is refused on B", async () => {
      const { access } = await grant(sessionOnlyChild(), [
        { service: "tinycloud.kv", space: secretsSpace, path: "vault/secrets/", actions: ["get"] },
        secretReadPermissions(networkId, "API_KEY")[1],
      ]);
      expect(await access.readSecret({ name: "API_KEY" })).toEqual({ status: "ok", value: "secrets-space-value" });
      // B's record is readable under the KV grant; its key is not.
      expect(await access.readSecret({ name: "OTHER_KEY" })).toEqual({
        status: "permission_required",
        hint: {
          service: "tinycloud.encryption",
          path: `${networkId}/secrets/other_key`,
          actions: ["tinycloud.encryption/decrypt"],
        },
      });
    }, 120_000);

    test("an exact-key grant refuses a network-sealed secret without a network decrypt; the owner reads both", async () => {
      // A record an older client sealed to the network key. `getBaseVault` is
      // private; only a vault write without a key path can make one now.
      const ownerVaults = owner as unknown as {
        getBaseVault(space: string): { put(key: string, value: unknown): Promise<{ ok: boolean }> };
      };
      const legacy = await ownerVaults.getBaseVault(secretsSpace).put("secrets/LEGACY_KEY", {
        value: "legacy-value", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(legacy.ok).toBe(true);
      const { access } = await grant(sessionOnlyChild(), [
        { service: "tinycloud.kv", space: secretsSpace, path: "vault/secrets/LEGACY_KEY", actions: ["get"] },
        secretReadPermissions(networkId, "LEGACY_KEY")[1],
      ]);
      expect(await access.readSecret({ name: "LEGACY_KEY" })).toEqual({ status: "legacy_envelope" });

      for (const [name, value] of [["API_KEY", "secrets-space-value"], ["LEGACY_KEY", "legacy-value"]] as const) {
        expect(await owner.readSecret({ space: secretsSpace, name })).toEqual({ status: "ok", value });
      }
    }, 120_000);

    test("each access decrypts only with its own delegation", async () => {
      const recipient = sessionOnlyChild();
      // X carries decrypt; Y reads the record but has no decrypt of its own.
      await grant(recipient, secretsEntries("vault/secrets/API_KEY"));
      const { access: accessY } = await grant(recipient, [secretsEntries("vault/secrets/OTHER_KEY")[0]!]);
      const result = await accessY.readSecret({ name: "OTHER_KEY" });
      expect(result.status).toBe("permission_required");
      expect(result.status === "permission_required" && result.hint.service).toBe("tinycloud.encryption");
    }, 120_000);

    test("an access with its own decrypt keeps working after another delegation is revoked", async () => {
      const recipient = sessionOnlyChild();
      const { delegation: x } = await grant(recipient, secretsEntries("vault/secrets/API_KEY"));
      const { access: accessY } = await grant(recipient, secretsEntries("vault/secrets/OTHER_KEY"));
      const receipt = await owner.revokeDelegation(x.cid);
      expect(receipt.ok, JSON.stringify(receipt.ok ? undefined : receipt.error)).toBe(true);
      expect(await accessY.readSecret({ name: "OTHER_KEY" })).toEqual({ status: "ok", value: "other-value" });
    }, 120_000);

    test("an expired delegation no longer decrypts", async () => {
      const { access } = await grant(sessionOnlyChild(), secretsEntries(), 5_000);
      expect((await access.readSecret({ name: "API_KEY" })).status).toBe("ok");

      // A real wait: the node checks expiry against its own wall clock, in
      // whole seconds, which fake timers in this process cannot move.
      await Bun.sleep(access.delegation.expiry.getTime() - Date.now() + 2_000);
      const decrypted = await decrypt(access);
      expect(decrypted.ok).toBe(false);
      expect((await access.readSecret({ name: "API_KEY" })).status).not.toBe("ok");
    }, 120_000);
  },
);
