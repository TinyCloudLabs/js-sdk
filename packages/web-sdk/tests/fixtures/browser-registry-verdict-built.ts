import "../support/browserGlobalsShim";
import "../../../operations/test-support/test-bootstrap.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const format = process.argv[2];
assert.ok(format === "mjs" || format === "cjs");
let requests = 0;
globalThis.fetch = Object.assign(async () => {
  requests++;
  throw new Error("Browser verdict initialization must not fetch");
}, { preconnect() {} });
const rootUrl = new URL(`../../dist/index.${format}`, import.meta.url);
const siblingUrl = new URL(`../../dist/registry-verdict-cache.${format}`, import.meta.url);
const marker = "A registry URL used with a verdict cache must not contain";
assert.equal((await readFile(rootUrl, "utf8")).includes(marker), false);
assert.equal((await readFile(siblingUrl, "utf8")).includes(marker), true);
const { TinyCloudWeb } = await import(rootUrl.href);
const first = await TinyCloudWeb.create({ ui: false });
const second = await TinyCloudWeb.create({ ui: false });
assert.equal(typeof first._node.config.registryVerdictCache.get, "function");
assert.notEqual(first._node.config.registryVerdictCache, second._node.config.registryVerdictCache);
assert.equal(requests, 0);
console.log(JSON.stringify({ format, lazyFactory: true, separateCaches: true, requests }));
