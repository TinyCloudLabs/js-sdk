import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NAMED_KEYS_UNSUPPORTED_MESSAGE, ownerFullAccess } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/legacy-node-secrets.");
if (!testHome.startsWith("/var/tmp/legacy-node-secrets.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

/** A tinycloud-node 1.20.6 binary: the last release before per-secret keys (encryption-named-keys-v1). */
const legacyBinary = process.env.TC_LEGACY_NODE_E2E_BIN;
const LEGACY_VERSION = "1.20.6";

// TC-3801: against a real node that cannot parent a grant on a secret's own key, a secrets put is refused up front
// (no wallet prompt, nothing written), sign-in still works with a request that names secret keys, and what is
// already stored can be read, listed and deleted.
describe.skipIf(!legacyBinary)("secrets against a real node without per-secret keys (1.20.6)", () => {
  let node: LocalNode | undefined;
  let host: string;
  let registry: UnregisteredLocationRegistry;

  async function ownerFor(capabilityRequest: unknown, privateKey = randomBytes(32).toString("hex")) {
    const signed = new TinyCloudNode({
      host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey,
      wasmBindings: new NodeWasmBindings(),
      domain: "legacy-node-secrets.test",
      autoCreateSpace: true,
      // The plain sign-in is the owner's full-access session: it covers `vault/secrets/` and the default encryption network.
      ...(capabilityRequest === undefined ? ownerFullAccess() : { capabilityRequest: capabilityRequest as never }),
    });
    await signed.signIn();
    await signed.waitForAccountRegistrySync();
    const space = await signed.ensureOwnedSpaceHosted("secrets");
    // A v1 record: sealed to the network key, as every secret was before per-secret keys.
    const vaults = signed as unknown as {
      getBaseVault(space: string): { put(key: string, value: unknown): Promise<{ ok: boolean }> };
    };
    const planted = await vaults.getBaseVault(space).put("secrets/LEGACY_KEY", {
      value: "legacy-value", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(planted.ok).toBe(true);
    return { owner: signed, space };
  }

  // The request a client composes today: the plain defaults, the secrets vault, and the owner's secret keys.
  async function requestNamingSecretKeys(privateKey: string) {
    const { PrivateKeySigner } = await import("./signers/PrivateKeySigner");
    const { composeManifestRequest } = await import("@tinycloud/sdk-core");
    const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${await new PrivateKeySigner(privateKey).getAddress()}:default`;
    const request = composeManifestRequest([{
      app_id: "legacy-node-secrets.test", name: "Legacy node secrets e2e", prefix: "", space: "default", defaults: "all",
      permissions: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/", actions: ["get", "put", "del", "list", "metadata"] }],
    }]);
    request.resources.push(
      { service: "tinycloud.encryption", space: "encryption", path: network, actions: ["tinycloud.encryption/decrypt"], skipPrefix: true },
      { service: "tinycloud.encryption", space: "encryption", path: `${network}/secrets/`, actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"], skipPrefix: true },
      { service: "tinycloud.encryption", space: "encryption", path: `${network}/secrets/api_key`, actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"], skipPrefix: true },
    );
    return request;
  }

  function countSignatures(owner: TinyCloudNode) {
    const signer = (owner as unknown as { signer: { signMessage(message: string): Promise<string> } }).signer;
    const original = signer.signMessage;
    const counter = { signatures: 0, restore: () => { signer.signMessage = original; } };
    signer.signMessage = (message) => {
      counter.signatures++;
      return original.call(signer, message);
    };
    return counter;
  }

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    node = await startLocalNode(legacyBinary!, "/var/tmp/legacy-node-secrets-node-");
    host = node.host;
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
    registry?.stop(true);
  });

  test("the node under test is 1.20.6 and does not list named keys", async () => {
    const version = await (await fetch(`${host}/version`)).json() as { version?: string; features?: string[] };
    expect(version.version).toBe(LEGACY_VERSION);
    expect(version.features).not.toContain("encryption-named-keys-v1");
  });

  for (const [label, request] of [["the plain sign-in", false], ["a sign-in whose request names secret keys", true]] as const) {
    describe(label, () => {
      let owner: TinyCloudNode;
      let space: string;

      beforeAll(async () => {
        const privateKey = randomBytes(32).toString("hex");
        ({ owner, space } = await ownerFor(request ? await requestNamingSecretKeys(privateKey) : undefined, privateKey));
      }, 120_000);

      test("put is refused with NAMED_KEYS_UNSUPPORTED, no wallet prompt, and nothing is written", async () => {
        const secrets = owner.secretsForSpace(space);
        const before = await secrets.list();
        const counter = countSignatures(owner);
        try {
          const put = await secrets.put("API_KEY", "new-value", { namedKey: true });
          expect(put.ok ? undefined : put.error).toMatchObject({
            code: "NAMED_KEYS_UNSUPPORTED", service: "secrets", message: NAMED_KEYS_UNSUPPORTED_MESSAGE,
          });
          expect(counter.signatures).toBe(0);
        } finally {
          counter.restore();
        }
        expect(await secrets.list()).toEqual(before);
        const read = await secrets.get("API_KEY");
        expect(read.ok).toBe(false);
      }, 120_000);

      test("a stored v1 secret can be read, listed and deleted", async () => {
        const secrets = owner.secretsForSpace(space);
        expect(await secrets.get("LEGACY_KEY")).toEqual({ ok: true, data: "legacy-value" });
        const entry = await secrets.getEntry("LEGACY_KEY");
        expect(entry.ok ? entry.data.value : undefined).toBe("legacy-value");
        const listed = await secrets.list();
        expect(listed.ok ? listed.data : []).toContain("LEGACY_KEY");
        const deleted = await secrets.delete("LEGACY_KEY");
        expect(deleted.ok, JSON.stringify(deleted.ok ? undefined : deleted.error)).toBe(true);
        const after = await secrets.list();
        expect(after.ok ? after.data : ["still there"]).not.toContain("LEGACY_KEY");
      }, 120_000);
    });
  }

  // A restored session (the CLI's) never learned the node's features, and the node's /info may be unreachable.
  // The put cannot tell this node from one with per-secret keys, and on this one it would ask the wallet to sign
  // before the node refuses it with 401. So it fails closed: retryable, no signature, nothing written.
  describe("a session that never learned the node's features, with /info unreachable", () => {
    let owner: TinyCloudNode;
    let space: string;

    beforeAll(async () => {
      ({ owner, space } = await ownerFor(undefined));
    }, 120_000);

    test("put fails closed with NAMED_KEYS_CHECK_FAILED: 0 signatures, nothing written; once /info answers it is the unsupported refusal", async () => {
      const secrets = owner.secretsForSpace(space);
      const before = await secrets.list();
      (owner as unknown as { auth: { _nodeFeaturesKnown: boolean } }).auth._nodeFeaturesKnown = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/info")) throw new Error("info unreachable");
        return realFetch(input, init);
      }) as typeof fetch;
      const counter = countSignatures(owner);
      try {
        const put = await secrets.put("API_KEY", "new-value", { namedKey: true });
        expect(put.ok ? undefined : put.error).toMatchObject({
          code: "NAMED_KEYS_CHECK_FAILED", service: "secrets", meta: { retryable: true },
          message: "Couldn't reach this TinyCloud node to check that it can save secrets. Nothing was saved. Try again in a moment.",
        });
        expect(counter.signatures).toBe(0);
      } finally {
        counter.restore();
        globalThis.fetch = realFetch;
      }
      expect(await secrets.list()).toEqual(before);
      const retried = await secrets.put("API_KEY", "new-value", { namedKey: true });
      expect(retried.ok ? undefined : retried.error.code).toBe("NAMED_KEYS_UNSUPPORTED");
      expect(await secrets.list()).toEqual(before);
    }, 120_000);
  });
});
