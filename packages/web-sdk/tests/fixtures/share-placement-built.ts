import "../support/browserGlobalsShim";
import "../../../operations/test-support/test-bootstrap.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { createHermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";

const format = process.argv[2];
assert.ok(format === "mjs" || format === "cjs");
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "registry.tinycloud.xyz") return Promise.resolve(new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Placement fixture blocked non-loopback fetch");
  return originalFetch(input, init);
}, { preconnect: originalFetch.preconnect });

const fixture = await createHermeticEncryptedNode();
try {
  const rootUrl = new URL(`../../dist/index.${format}`, import.meta.url);
  const placementUrl = new URL(`../../dist/share-placement.${format}`, import.meta.url);
  const domain = "tinycloud/share-placement/v1";
  assert.ok(!(await readFile(rootUrl, "utf8")).includes(domain));
  assert.ok((await readFile(placementUrl, "utf8")).includes(domain));
  const root = await import(rootUrl.href);
  const placement = await import(placementUrl.href);
  const sender = new TinyCloudNode({ host: fixture.host, tinycloudRegistryUrl: fixture.host,
    privateKey: fixture.ownerPrivateKey, autoBootstrapAccount: false });
  await sender.restoreSession(fixture.ownerRestorableSession);
  const path = "notes/placement-built";
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [path]: { message: "public placement entry" } });
  const made = await sender.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Placement fixture generation failed");
  const received = await root.TinyCloudWeb.receiveShare(made.data.token, path);
  assert.equal(received.ok, true);
  assert.deepEqual(received.data.data, { message: "public placement entry" });
  const decoded = sender.sharing.decodeLink(made.data.token);
  const malformedRegistry = Object.assign(async () => Response.json({ record: {} }), { preconnect() {} });
  await assert.rejects(() => placement.sharePlacementDestinations(decoded.placement, { ...decoded.delegation, spaceId: decoded.spaceId }, {
    registryUrl: "https://registry.example", fetch: malformedRegistry,
  }), (error: unknown) => error instanceof root.__sharePlacementCore.RegistryUnavailableError);
  console.log(JSON.stringify({ format, rootDomainAbsent: true, received: true, sharedErrorIdentity: true }));
} finally {
  fixture.stop();
  globalThis.fetch = originalFetch;
}
