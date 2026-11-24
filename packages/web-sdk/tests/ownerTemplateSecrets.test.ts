import "./support/browserGlobalsShim";
import { expect, test } from "bun:test";
import { extractRecapAttenuations } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";
import { signedLocationRecordForTest, signedRegistryResponseForTest } from "../../node-sdk/src/test-support/restored-policy-node";
import type { TinyCloudWeb as Web } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../dist/index.cjs") as { TinyCloudWeb: typeof Web };
const secret = "HERMETIC_DELEGATION_CANARY";
const value = "legacy secret fixture";

test.each(["get", "put"] as const)("a signed owner-template manifest allows a legacy secret %s without a new approval", async (action) => {
  const fixture = await createHermeticEncryptedNode({ secretPayloadValue: value });
  fixture.provisionSecret();
  if (action === "put") fixture.provisionKvSpace(fixture.ownerRestorableSession.spaceId);
  const account = privateKeyToAccount(`0x${fixture.ownerPrivateKey.replace(/^0x/, "")}`);
  const { nodeId: nodeDid } = await fetch(`${fixture.host}/info`).then((response) => response.json() as Promise<{ nodeId: string }>);
  const record = await signedLocationRecordForTest({
    host: fixture.host, ownerDid: fixture.ownerDid, ownerPrivateKey: fixture.ownerPrivateKey, nodeDid,
    spaces: [fixture.ownerRestorableSession.spaceId], sequence: 1,
  });
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    return signedRegistryResponseForTest(request, undefined, server.url.origin, record) ?? new Response(null, { status: 404 });
  } });
  let signatures = 0;
  let web: Web | undefined;
  try {
    web = await TinyCloudWeb.create({
      provider: { async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") {
          signatures++;
          const message = String(params?.[0]);
          return account.signMessage({ message: message.startsWith("0x") ? Buffer.from(message.slice(2), "hex").toString() : message });
        }
        throw new Error(`Unexpected wallet method ${method}`);
      } },
      manifest: {
        manifest_version: 1, app_id: "xyz.tinycloud.owner-template-secret-test", name: "Owner-template secrets fixture",
        space: "secrets", defaults: false, permissions: [
          { service: "tinycloud.kv", path: `vault/secrets/${secret}`, actions: [action], skipPrefix: true },
          { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default", actions: ["decrypt"] },
        ],
      },
      tinycloudHosts: [fixture.host], tinycloudRegistryUrl: registry.url.origin,
      autoDiscoverLocalNode: false, persistSession: false, autoCreateSpace: false, autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false, ui: false,
    });
    await web.signIn();
    const recap = extractRecapAttenuations(web.session()!.siwe);
    const network = `urn:tinycloud:encryption:${fixture.ownerDid}:default`;
    expect(recap[network]?.["tinycloud.encryption/decrypt"]).toBeDefined();
    expect(Object.keys(recap).some((path) => path.startsWith(`${network}/`))).toBe(false);
    if (action === "get") {
      expect(await web.secrets.get(secret)).toEqual({ ok: true, data: value });
      expect(fixture.decryptRequests()).toBe(1);
    } else {
      const before = fixture.nativeBearerStats().kvWrites;
      expect(await web.secrets.put(secret, value)).toMatchObject({ ok: true });
      expect(fixture.nativeBearerStats().kvWrites).toBe(before + 1);
    }
    expect(signatures).toBe(1);
  } finally {
    registry.stop(true);
    web?.cleanup();
    fixture.stop();
  }
});
