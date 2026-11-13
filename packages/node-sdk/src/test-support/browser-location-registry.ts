import { bootstrapSteps } from "@tinycloud/bootstrap";
import { REGISTRY_NOT_FOUND_BODY, registryOwnerKeyV2, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";

export function startBrowserLocationRegistry() {
  const records = new Map<string, Awaited<ReturnType<typeof signLocationRecordV2>>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
      if (request.method === "GET" && /^\/v[12]\/locations\/[^/]+$/.test(url.pathname)) {
        const key = decodeURIComponent(url.pathname.split("/").at(-1)!).toLowerCase();
        const record = url.pathname.startsWith("/v2/") ? records.get(key) : undefined;
        return record ? Response.json({ record }, { headers })
          : new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers });
      }
      return new Response("unexpected registry request", { status: 400 });
    },
  });
  return {
    url: server.url,
    stop: (force?: boolean) => server.stop(force),
    async register(privateKey: string, host: string, nodeDid: string) {
      const wallet = privateKeyToAccount(privateKey as `0x${string}`);
      const subject = `did:pkh:eip155:1:${wallet.address}`;
      const spaces = [...new Set([
        ...bootstrapSteps(wallet.address, 1).filter((step) => step.kind === "host").map((step) => step.spaceId.toLowerCase()),
        ...["default", "account", "public"].map((name) => `tinycloud:pkh:eip155:1:${wallet.address}:${name}`.toLowerCase()),
      ])];
      const record = await signLocationRecordV2({
        version: 2, subject, sequence: 0, updated_at: new Date().toISOString(),
        nodes: [{ did: nodeDid, url: host }],
        spaces: spaces.map((space) => ({ space, nodes: [{ did: nodeDid, mode: "read-write" }] })),
        encryptionNode: nodeDid,
      }, { type: "did:pkh", signMessage: (message) => wallet.signMessage({ message }) });
      records.set(registryOwnerKeyV2(subject).toLowerCase(), record);
    },
  };
}

export type BrowserLocationRegistry = ReturnType<typeof startBrowserLocationRegistry>;
