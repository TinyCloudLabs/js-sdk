import "./test-bootstrap.mjs";
import { readFile } from "node:fs/promises";
import { refreshOwnerRegistry } from "@tinycloud/sdk-core";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore } from "../src/state.js";

const [profile, subject, responsePath] = process.argv.slice(2);
if (!profile || !subject || !responsePath) throw new Error("Expected TEST profile, owner and signed response file");
const body = await readFile(responsePath, "utf8");
await refreshOwnerRegistry(subject, {
  cacheStore: createProfileRegistryCacheStore(profile),
  sequenceStore: createProfileRegistrySequenceStore(profile),
  fetch: Object.assign(async () => {
    process.stdout.write("ready\n");
    // The parent commits a newer response before releasing this older one.
    for await (const _chunk of process.stdin) break;
    return new Response(body);
  }, { preconnect: fetch.preconnect }),
});
