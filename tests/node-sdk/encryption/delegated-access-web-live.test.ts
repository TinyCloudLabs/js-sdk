import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { TinyCloudNode, ownerFullAccess, serializeDelegation } from "@tinycloud/node-sdk";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { TinyCloudWeb, deserializeDelegation } from "@tinycloud/web-sdk";
import { checkServerHealth, SERVER_URL } from "../setup";

/**
 * The embedded-app recipe in a browser child: a session-only TinyCloudWeb (no
 * wallet) activates the host's per-space delegation with `useDelegation` and
 * reads a Secrets-app secret through the returned DelegatedAccess.
 */
describe("web DelegatedAccess reads a secret under the delegation (live)", () => {
  // New owners have no location record; never consult the public registry.
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(REGISTRY_NOT_FOUND_BODY, {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  });
  const registryUrl = registry.url.origin;
  let owner: TinyCloudNode;
  let secretsSpace: string;
  let networkId: string;

  beforeAll(async () => {
    await checkServerHealth();
    owner = new TinyCloudNode({
      host: SERVER_URL,
      tinycloudRegistryUrl: registryUrl,
      newUserHost: SERVER_URL,
      autoDiscoverLocalNode: false,
      privateKey: randomBytes(32).toString("hex"),
      autoCreateSpace: true,
      ...ownerFullAccess(),
    });
    await owner.signIn();
    secretsSpace = await owner.ensureOwnedSpaceHosted("secrets");
    networkId = (await owner.ensureEncryptionNetwork()).networkId;
    const put = await owner.secretsForSpace(secretsSpace).put("API_KEY", "web-child-value");
    expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
  }, 120_000);

  afterAll(() => registry.stop(true));

  test("tcw.useDelegation exposes readSecret and decrypt for a session-only child", async () => {
    const tcw = await TinyCloudWeb.create({
      persistSession: false,
      tinycloudHosts: [SERVER_URL],
      tinycloudRegistryUrl: registryUrl,
      autoDiscoverLocalNode: false,
    });
    expect(tcw.isSessionOnly).toBe(true);
    const issued = await owner.delegateTo(tcw.sessionDid.split("#")[0]!, [
      { service: "tinycloud.kv", space: secretsSpace, path: "vault/secrets/", actions: ["get"] },
      { service: "tinycloud.encryption", path: networkId, actions: ["decrypt"] },
    ], { expiry: "1h", disableSubDelegation: true });
    const access = await tcw.useDelegation(deserializeDelegation(serializeDelegation(issued.delegation)));

    expect(await access.readSecret({ name: "API_KEY" })).toEqual({ status: "ok", value: "web-child-value" });
    expect(await access.readSecret({ name: "MISSING" })).toEqual({ status: "not_found" });
    expect(tcw.isSessionOnly).toBe(true);
  }, 120_000);
});
