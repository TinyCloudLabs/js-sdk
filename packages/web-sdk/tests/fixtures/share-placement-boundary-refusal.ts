import "../support/browserGlobalsShim";
import "../../../operations/test-support/test-bootstrap.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
const copiedDist = await mkdtemp(join(tmpdir(), "tc2937-missing-sibling-"));
try {
  await cp(new URL("../../dist/", import.meta.url), copiedDist, { recursive: true });
  await rm(join(copiedDist, `share-placement.${format}`));
  const root = await import(pathToFileURL(join(copiedDist, `index.${format}`)).href);
  assert.equal(Object.isFrozen(root.__sharePlacementCore), true);
  const originalResolver = root.__sharePlacementCore.resolveOwnerHosts;
  assert.throws(() => { root.__sharePlacementCore.resolveOwnerHosts = async () => ({ status: "absent" }); }, TypeError);
  assert.equal(root.__sharePlacementCore.resolveOwnerHosts, originalResolver);
  const sender = new TinyCloudNode({ host: fixture.host, tinycloudRegistryUrl: fixture.host,
    privateKey: fixture.ownerPrivateKey, autoBootstrapAccount: false });
  await sender.restoreSession(fixture.ownerRestorableSession);
  const path = "notes/placement-built";
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [path]: { message: "public placement entry" } });
  const made = await sender.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Placement fixture generation failed");
  let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests++; throw new Error("Unexpected request after missing placement sibling"); }, { preconnect() {} });
  const received = await root.TinyCloudWeb.receiveShare(made.data.token, path);
  assert.equal(received.ok, false);
  assert.equal(received.error.code, "DECODE_FAILED");
  assert.equal(requests, 0);
  console.log(JSON.stringify({ format, bridgeFrozen: true, missingSiblingRefused: true, requests }));
} finally {
  fixture.stop();
  await rm(copiedDist, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
}
