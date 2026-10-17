/**
 * #548 correctness review P2: one failed startup recovery must not gate the replica for the life of
 * the page. Stamp admission re-runs a bounded recovery; it still fails closed while recovery fails.
 */
import { expect, test } from "bun:test";
import { browserReplicaPlugin } from "../src/replica";

const ADDRESS = "0x00000000000000000000000000000000000000aa";
const PRINCIPAL = `did:pkh:eip155:1:${ADDRESS}`;
const STAMP = { incarnation: "startup-recovery", lifecycleEpoch: 1 };
const failedReport = { erased: [], failed: [{ id: "intent", code: "STORAGE_ERROR" }], remaining: 1 };
const cleanReport = { erased: [], failed: [], remaining: 0 };

function replicationWith(reports: unknown[]) {
  let recoveries = 0;
  let restores = 0;
  const lifecycle = {
    kind: "indexeddb" as const,
    recover: async () => reports[Math.min(recoveries++, reports.length - 1)],
    restoreSessionStamp: async () => { restores++; return STAMP; },
  };
  const replication = { enabled: true, prefixes: ["notes/"], storage: { kind: "indexeddb", lifecycle } };
  const signer = { getConnectedAddress: async () => ADDRESS };
  return { replication, signer, counts: () => ({ recoveries, restores }) };
}

async function guardedLifecycle(reports: unknown[]) {
  const fixture = replicationWith(reports);
  const recovered = await browserReplicaPlugin.recover(fixture.replication as never, fixture.signer as never);
  const lifecycle = (recovered.storage as unknown as { lifecycle: typeof fixture.replication.storage.lifecycle }).lifecycle;
  return { lifecycle, counts: fixture.counts };
}

test("a failed startup recovery is retried at stamp admission and admits once it succeeds", async () => {
  const { lifecycle, counts } = await guardedLifecycle([failedReport, cleanReport]);
  await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP)).resolves.toEqual(STAMP);
  expect(counts()).toEqual({ recoveries: 2, restores: 1 });
});

test("admission still fails closed while recovery keeps failing, and retries are bounded", async () => {
  const { lifecycle, counts } = await guardedLifecycle([failedReport]);
  for (let attempt = 0; attempt < 5; attempt++) {
    await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
  }
  expect(counts().restores).toBe(0);
  expect(counts().recoveries).toBeLessThanOrEqual(4);
});
