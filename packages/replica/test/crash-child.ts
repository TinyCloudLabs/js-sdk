/**
 * Child process for crash.test.ts: syncs a replica from a deterministic fake
 * node and SIGKILLs itself at one durability boundary of the second page, or
 * (afterPurgeMark) after a full sync, once a revocation purge is committed.
 * Usage: bun crash-child.ts <dir> <afterBlobs|beforeCommit|afterCommit|afterPurgeMark>
 */
import { Replica } from "../src/engine.js";
import { FAULTS, SqliteReplicaStore, type SqliteReplicaStoreOptions, type StoreFaults } from "../src/sqlite/store.js";
import { CRASH_DATASET, CRASH_PAGE_LIMIT, FakeNode, newStore } from "./fixtures.js";

const [dir, point] = process.argv.slice(2) as [string, keyof StoreFaults];
let calls = 0;
const faults: StoreFaults = {
  [point]: () => {
    calls += 1;
    if (calls === (point === "afterPurgeMark" ? 1 : 2)) process.kill(process.pid, "SIGKILL");
  },
};

await (await newStore(dir)).close();
const store = await SqliteReplicaStore.open(dir, { create: false, [FAULTS]: faults } as SqliteReplicaStoreOptions);
const node = new FakeNode();
for (const [key, value] of CRASH_DATASET) node.put(key, value);
await new Replica({ store, transport: node }).sync({ limit: CRASH_PAGE_LIMIT });
if (point === "afterPurgeMark") await store.markRevoked("delegation-revoked: crash test");
process.exit(3); // not reached: the fault kills the process during page 2
