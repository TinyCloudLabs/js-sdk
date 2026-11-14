import "../support/browserGlobalsShim";
import "../../../operations/test-support/test-bootstrap.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { createHermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";

const format = process.argv[2];
assert.ok(format === "mjs" || format === "cjs");
const fixture = await createHermeticEncryptedNode();
fixture.allowInvocationProof(fixture.ownerRestorableSession.delegationCid);
const copiedDist = await mkdtemp(join(tmpdir(), "tc2987-missing-cache-"));
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const warnings: unknown[][] = [];
let registryRequests = 0;
console.warn = (...args) => { warnings.push(args); };
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "registry.test") {
    registryRequests++;
    return Promise.resolve(new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }));
  }
  if (url.hostname !== "127.0.0.1") throw new Error("Cache fixture refused non-loopback fetch");
  return realFetch(input, init);
}, { preconnect: realFetch.preconnect });
try {
  const sibling = await readFile(new URL(`../../dist/registry-verdict-cache.${format}`, import.meta.url), "utf8");
  assert.equal(sibling.includes("RegistryUnavailableError"), false);
  assert.equal(sibling.includes("REGISTRY_UNAVAILABLE"), false);
  await cp(new URL("../../dist/", import.meta.url), copiedDist, { recursive: true });
  await rm(join(copiedDist, `registry-verdict-cache.${format}`));
  const { TinyCloudWeb } = await import(pathToFileURL(join(copiedDist, `index.${format}`)).href);
  const web = await TinyCloudWeb.create({ ui: false, autoBootstrapAccount: false,
    tinycloudHosts: [fixture.host], tinycloudRegistryUrl: "https://registry.test", autoDiscoverLocalNode: false });
  assert.equal(web._node.config.registryVerdictCache, undefined);
  assert.deepEqual(warnings, [["Registry cache unavailable; using uncached routing."]]);
  await web._node.restoreSession(fixture.ownerRestorableSession);
  const key = "vault/secrets/HERMETIC_DELEGATION_CANARY";
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [key]: { value: "uncached" } });
  for (let call = 0; call < 2; call++) {
    const before = registryRequests;
    const result = await web.kv.get(key);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.data, { value: "uncached" });
    assert.ok(registryRequests >= before + 2);
  }
  assert.equal(warnings.length, 1);
  console.log(JSON.stringify({ format, initialized: true, uncachedReads: true, noCopiedError: true }));
} finally {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
  fixture.stop();
  await rm(copiedDist, { recursive: true, force: true });
}
