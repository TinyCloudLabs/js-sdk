import "../../operations/test-support/test-bootstrap.mjs";
/*
 * TC-4322: a sign-in request may carry the reserved bot-history key on the signer's own default network, with decrypt
 * and key.create only, as it may carry a secret's own key.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { extractRecapAttenuations, type Manifest } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { TinyCloudNode, type TinyCloudNodeConfig } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { startUnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

const OTHER_OWNER = "did:pkh:eip155:1:0x0000000000000000000000000000000000000002";

const signer = new PrivateKeySigner("1".padStart(64, "0"));
const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${await signer.getAddress()}:default`;
const KEY = `${network}/${BOT_HISTORY_KEY_PATH}`;
const registry = startUnregisteredLocationRegistry();
const node = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/info") return Response.json({
    protocol: 1, version: "1.26.21", features: ["encryption-named-keys-v1"],
    nodeId: "did:key:z6MkvSbonMn1Xgewrb4EsbjTmvMT8T9Y3PTb5PcnQcQUbzjc",
  });
  if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
  return new Response(null, { status: 404 });
}});

afterAll(() => {
  registry.stop(true);
  node.stop(true);
});

type Entry = { path: string; actions: string[]; space?: string };

/** Signs in from a manifest, the path TinyChat uses, so the request goes through the manifest composer. */
function fromManifest({ path, actions }: Entry): TinyCloudNode {
  const manifest: Manifest = {
    manifest_version: 1, app_id: "xyz.tinycloud.bot-history-sign-in", name: "Bot history sign-in",
    space: "applications", defaults: false,
    permissions: [{ service: "tinycloud.encryption", path, actions, skipPrefix: true }],
  };
  return sdkWith({ manifest });
}

/** Signs in from an explicit capability request, which reaches the sign-in resolver without the composer's checks. */
function fromRequest({ path, actions, space = "encryption" }: Entry): TinyCloudNode {
  return sdkWith({ capabilityRequest: {
    manifests: [], delegationTargets: [], registryRecords: [], expiryMs: 60 * 60_000, includePublicSpace: false,
    resources: [{ service: "tinycloud.encryption", space, path, actions: actions.map((action) => `tinycloud.encryption/${action}`) }],
  } });
}

function sdkWith(request: Pick<TinyCloudNodeConfig, "manifest" | "capabilityRequest">): TinyCloudNode {
  return new TinyCloudNode({
    host: node.url.origin, tinycloudRegistryUrl: registry.url.origin, signer, wasmBindings: new NodeWasmBindings(),
    domain: "fixture.example", autoCreateSpace: false, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, ...request,
  });
}

const signedEncryption = (sdk: TinyCloudNode) => Object.entries(extractRecapAttenuations(sdk.session!.siwe))
  .filter(([resource]) => resource.startsWith("urn:tinycloud:encryption:"))
  .map(([resource, actions]) => [resource, Object.keys(actions).sort()]);

describe("the reserved bot-history key in a sign-in request", () => {
  test("is signed on the owner's own default network with decrypt and key.create only", async () => {
    for (const sdk of [fromManifest({ path: KEY, actions: ["decrypt", "key.create"] }), fromRequest({ path: KEY, actions: ["decrypt", "key.create"] })]) {
      await sdk.signIn();

      expect(signedEncryption(sdk)).toEqual([[KEY, ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]]]);
    }
    const decryptOnly = fromManifest({ path: KEY, actions: ["decrypt"] });
    await decryptOnly.signIn();
    expect(signedEncryption(decryptOnly)).toEqual([[KEY, ["tinycloud.encryption/decrypt"]]]);
  });

  test("is refused with any other action", async () => {
    for (const extra of ["delete", "put", "network.create"]) {
      const entry = { path: KEY, actions: ["decrypt", "key.create", extra] };

      await expect(fromManifest(entry).signIn()).rejects.toThrow("Manifest validation failed");
      await expect(fromRequest(entry).signIn()).rejects.toThrow("named keys go in manifest.keys");
    }
  });

  test("is refused on another owner's network, on another network and outside the encryption space", async () => {
    const otherOwner = { path: `urn:tinycloud:encryption:${OTHER_OWNER}:default/${BOT_HISTORY_KEY_PATH}`, actions: ["decrypt"] };
    const otherNetwork = { path: `${network.replace(/:default$/, ":work")}/${BOT_HISTORY_KEY_PATH}`, actions: ["decrypt"] };

    await expect(fromManifest(otherOwner).signIn()).rejects.toThrow("named keys go in manifest.keys");
    await expect(fromRequest(otherOwner).signIn()).rejects.toThrow("named keys go in manifest.keys");
    await expect(fromRequest(otherNetwork).signIn()).rejects.toThrow("named keys go in manifest.keys");
    await expect(fromRequest({ path: KEY, actions: ["decrypt"], space: "applications" }).signIn())
      .rejects.toThrow("named keys go in manifest.keys");
  });

  test("does not open other hyphenated keys under secrets/scoped", async () => {
    for (const path of [
      "secrets/scoped/tinychat-bot-history/bot-history-2",
      "secrets/scoped/tinychat-bot-history/other-key",
      "secrets/scoped/other-scope/bot-history",
      "secrets/scoped/tinychat-bot-history/",
    ]) {
      const entry = { path: `${network}/${path}`, actions: ["decrypt", "key.create"] };

      await expect(fromManifest(entry).signIn()).rejects.toThrow("Manifest validation failed");
      await expect(fromRequest(entry).signIn()).rejects.toThrow("named keys go in manifest.keys");
    }
  });
});
