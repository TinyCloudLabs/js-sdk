import { afterEach, expect, test } from "bun:test";
import { NodeUserAuthorization } from "./NodeUserAuthorization";

// TC-2923: sign-in activates the registry record's encryption node on the
// production node's TEE origin, identity-checked there first; data hosts keep
// their own origin. (Harness by Bobbie's TC-2923 review.)
const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const DATA = "https://data.test";
const DID = "did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const NETWORK = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const dataHost of [DATA, PROXIED]) {
  for (const encryptionHost of [PROXIED, TEE, "https://custom.test"]) {
    test(`sign-in activates encryption on the mapped ${encryptionHost} and keeps data on ${dataHost}`, async () => {
      // Seeds an admitted session and a verified registry verdict; runs the real activation method.
      const recap = Buffer.from(JSON.stringify({
        att: { [`${SPACE}/kv/`]: { "tinycloud.kv/get": [{}] }, [NETWORK]: { "tinycloud.encryption/decrypt": [{}] } },
      })).toString("base64url");
      const auth = Object.create(NodeUserAuthorization.prototype) as NodeUserAuthorization;
      Object.assign(auth, {
        _tinyCloudSession: { spaceId: SPACE, siwe: `Resources:\n- urn:recap:${recap}`, delegationHeader: { Authorization: "synthetic-session" } },
        registryVerdict: { status: "registered", record: { nodes: [{ did: DID, url: encryptionHost }], spaces: [], encryptionNode: DID } },
        resolveResourceDestinations: async () => [{ url: dataHost, nodeDid: DID }],
      });
      const calls: { url: string; redirect?: RequestRedirect }[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, redirect: init?.redirect });
        if (url.endsWith("/info")) return Response.json({ nodeId: DID });
        if (url.endsWith("/.well-known/tinycloud/node-keys")) return Response.json({ nodeDid: DID });
        if (url.endsWith("/delegate")) return Response.json({ activated: [SPACE], skipped: [] });
        throw new Error(`Unexpected request ${url}`);
      }) as typeof fetch;

      await auth.ensureSpaceExists();

      const encryptionOrigin = encryptionHost === PROXIED ? TEE : encryptionHost;
      expect(calls.filter((call) => call.url.endsWith("/delegate")).map((call) => call.url))
        .toEqual([...new Set([dataHost, encryptionOrigin])].map((host) => `${host}/delegate`));
      const activation = calls.findIndex((call) => call.url === `${encryptionOrigin}/delegate`);
      const before = calls.slice(0, activation).map((call) => call.url);
      expect(before).toContain(`${encryptionOrigin}/info`);
      expect(before).toContain(`${encryptionOrigin}/.well-known/tinycloud/node-keys`);
      expect(calls.every((call) => call.redirect === "error")).toBe(true);
    });
  }
}
