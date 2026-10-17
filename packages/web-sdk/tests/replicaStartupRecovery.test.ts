/**
 * #548 correctness review P2: one failed startup recovery must not gate the replica for the life of
 * the page. Stamp admission re-runs a bounded recovery; it still fails closed while recovery fails.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
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

// #565 correctness review: a startup recovery that outlives its 3 s bound holds the origin gate lock.
// Admission must not burn its retries against that lock, and a late clean finish must re-admit
// only through one fresh gated recovery, never from the late report itself.
describe("startup recovery that finishes after its bound", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // The bound uses AbortSignal.timeout or setTimeout; drive both from the fake clock.
    spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    mock.restore();
  });

  const flush = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve(); };
  const advance = async (ms: number) => { await flush(); jest.advanceTimersByTime(ms); await flush(); };

  /** Like the IndexedDB lifecycle: recover holds the gate lock; a waiter aborted by its signal reports failure. */
  function lockedLifecycle(lateRecovery: () => unknown) {
    let releaseStartup!: (report: unknown) => void;
    const startup = new Promise((resolve) => { releaseStartup = resolve; });
    let lockFree = false;
    let recoveries = 0;
    let restores = 0;
    let denied = false;
    const gatedRefusal = (gate: string) => Object.assign(new Error(gate), { code: "REPLICA_GATED", gate });
    const lifecycle = {
      kind: "indexeddb" as const,
      recover: async ({ signal }: { signal: AbortSignal }) => {
        if (++recoveries === 1) return startup;
        if (!lockFree) {
          const acquired = await Promise.race([
            startup.then(() => true),
            new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })),
          ]);
          if (!acquired) return { erased: [], failed: [{ id: "recover", code: "ABORT_ERR" }], remaining: 1 };
        }
        return lateRecovery();
      },
      restoreSessionStamp: async () => {
        if (denied) throw gatedRefusal("stamp_stale");
        restores++;
        return STAMP;
      },
      deny: async () => { denied = true; return { status: "denied", lifecycleEpoch: 2, intents: 0 }; },
    };
    const replication = { enabled: true, prefixes: ["notes/"], storage: { kind: "indexeddb", lifecycle } };
    const signer = { getConnectedAddress: async () => ADDRESS };
    return {
      replication, signer,
      finishStartup: async (report: unknown) => { lockFree = true; releaseStartup(report); await flush(); },
      counts: () => ({ recoveries, restores }),
    };
  }

  async function startedLate(lateRecovery: () => unknown = () => cleanReport) {
    const fixture = lockedLifecycle(lateRecovery);
    const pending = browserReplicaPlugin.recover(fixture.replication as never, fixture.signer as never);
    await advance(3_000);
    const recovered = await pending;
    const lifecycle = (recovered.storage as unknown as {
      lifecycle: { restoreSessionStamp(principal: string, stamp: unknown): Promise<unknown>; deny(input: unknown): Promise<unknown> };
    }).lifecycle;
    const admit = async () => {
      const attempt = lifecycle.restoreSessionStamp(PRINCIPAL, STAMP);
      attempt.catch(() => undefined);
      await advance(3_000);
      return attempt;
    };
    return { ...fixture, lifecycle, admit };
  }

  test("admissions while it runs spend no retries, and its late clean finish admits without a reload", async () => {
    const { admit, finishStartup, counts } = await startedLate();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(admit()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    }
    await finishStartup(cleanReport);
    await expect(admit()).resolves.toEqual(STAMP);
    expect(counts().restores).toBe(1);
  });

  test("a late clean startup report alone does not admit; the fresh gated recovery decides", async () => {
    const { admit, finishStartup, counts } = await startedLate(() => failedReport);
    await finishStartup(cleanReport);
    await expect(admit()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(counts().restores).toBe(0);
  });

  test("a deny before the late clean finish keeps the replica refused", async () => {
    const { admit, lifecycle, finishStartup, counts } = await startedLate();
    await expect(admit()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await lifecycle.deny({ reason: "sign_out", principal: PRINCIPAL });
    await finishStartup(cleanReport);
    await expect(admit()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(counts().restores).toBe(0);
  });
});
