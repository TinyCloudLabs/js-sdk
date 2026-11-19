import { afterEach, describe, expect, jest, test } from "bun:test";

import { createSignOutGuard, PURGE_TIMEOUT_MS, purgeWatch } from "../../src/ui/sign-out-purge";
import type { PanelClient, PurgeLocalCopyResult } from "../../src/ui/slots";
import type { ToastRequest } from "../../src/ui/toast-store";

interface Rig {
  readonly client: PanelClient;
  readonly guard: (client: PanelClient | undefined) => PanelClient | undefined;
  readonly toasts: ToastRequest[];
  readonly log: string[];
  /** Fires the client's onReset listeners, as sign-out and an account switch do. */
  reset(): void;
  signedIn: boolean;
}

/** Records call order in `log`. `purges` answers each purge call in turn; the last answer repeats. */
function rig(opts: {
  purges?: Array<PurgeLocalCopyResult | Error>;
  /** Replaces `purges`: called with the zero-based call number. */
  purgeImpl?: (call: number) => Promise<PurgeLocalCopyResult>;
  signOut?: () => Promise<void>;
  /** A rejected signOut leaves the session live, as when the host fails before ending it. */
  sessionStaysOnReject?: boolean;
  withPurge?: boolean;
}): Rig {
  const log: string[] = [];
  const toasts: ToastRequest[] = [];
  const answers = opts.purges ?? [{ ok: true }];
  let calls = 0;
  const state = { signedIn: true };
  const resetListeners = new Set<() => void>();
  const reset = (): void => {
    for (const cb of [...resetListeners]) cb();
  };
  const client = {
    id: 1,
    signedIn: () => state.signedIn,
    onReset: (cb: () => void) => {
      resetListeners.add(cb);
      return () => resetListeners.delete(cb);
    },
    storage: {},
    get sync() {
      return undefined;
    },
    // Like tcw.signOut, the reset fires inside sign-out, before it settles.
    signOut: async () => {
      log.push("signOut:start");
      try {
        await (opts.signOut ?? (() => Promise.resolve()))();
      } catch (error) {
        if (opts.sessionStaysOnReject !== true) state.signedIn = false;
        reset();
        throw error;
      }
      state.signedIn = false;
      reset();
      log.push("signOut:end");
    },
    ...(opts.withPurge === false
      ? {}
      : {
          purgeLocalCopy: async () => {
            const call = calls;
            calls += 1;
            log.push("purge");
            if (opts.purgeImpl !== undefined) return opts.purgeImpl(call);
            const answer = answers[Math.min(call, answers.length - 1)];
            if (answer instanceof Error) throw answer;
            return answer as PurgeLocalCopyResult;
          },
        }),
  } as PanelClient;
  return {
    client,
    guard: createSignOutGuard((request) => toasts.push(request)),
    toasts,
    log,
    reset,
    get signedIn() {
      return state.signedIn;
    },
    set signedIn(value: boolean) {
      state.signedIn = value;
    },
  };
}

const wrapped = (r: Rig): PanelClient => r.guard(r.client) as PanelClient;

describe("order", () => {
  test("the purge runs only after signOut has resolved", async () => {
    let release: () => void = () => undefined;
    const r = rig({ signOut: () => new Promise<void>((resolve) => (release = resolve)) });
    const done = wrapped(r).signOut?.();
    await Promise.resolve();
    expect(r.log).toEqual(["signOut:start"]);
    release();
    await done;
    expect(r.log).toEqual(["signOut:start", "signOut:end", "purge"]);
  });

  test("the returned promise settles after the purge", async () => {
    let finish: (value: PurgeLocalCopyResult) => void = () => undefined;
    const r = rig({});
    const slow = { ...r.client, purgeLocalCopy: () => new Promise<PurgeLocalCopyResult>((resolve) => (finish = resolve)) } as PanelClient;
    let settled = false;
    const done = (r.guard(slow) as PanelClient).signOut?.().then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    finish({ ok: true });
    await done;
    expect(settled).toBe(true);
  });

  test("a signOut rejection still purges, then rethrows the same error", async () => {
    const failure = new Error("gate not denied");
    const r = rig({
      signOut: () => Promise.reject(failure),
    });
    await expect(wrapped(r).signOut?.()).rejects.toBe(failure);
    expect(r.log).toEqual(["signOut:start", "purge"]);
  });

  test("overlapping calls share one sign-out and one purge", async () => {
    const r = rig({});
    const w = wrapped(r);
    await Promise.all([w.signOut?.(), w.signOut?.()]);
    expect(r.log).toEqual(["signOut:start", "signOut:end", "purge"]);
  });
});

describe("failure handling", () => {
  test("success: no toast, no outstanding failure", async () => {
    const r = rig({});
    await wrapped(r).signOut?.();
    expect(r.toasts).toEqual([]);
    expect(purgeWatch(wrapped(r))?.failure()).toBeUndefined();
  });

  test("a failure without retryNow tries once, warns neutrally, and keeps a retry", async () => {
    const r = rig({ purges: [{ ok: false, retryNow: false }] });
    await wrapped(r).signOut?.();
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(1);
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.pending" }]);
    expect(purgeWatch(wrapped(r))?.failure()).toBe("pending");
  });

  test("retryNow retries once at once; a second failure warns that the copy may be readable", async () => {
    const r = rig({
      purges: [
        { ok: false, retryNow: true },
        { ok: false, retryNow: true },
      ],
    });
    await wrapped(r).signOut?.();
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(2);
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.readable" }]);
    expect(purgeWatch(wrapped(r))?.failure()).toBe("readable");
  });

  test("retryNow then success: no warning", async () => {
    const r = rig({ purges: [{ ok: false, retryNow: true }, { ok: true }] });
    await wrapped(r).signOut?.();
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(2);
    expect(r.toasts).toEqual([]);
    expect(purgeWatch(wrapped(r))?.failure()).toBeUndefined();
  });

  test("a purge that throws is a failed attempt, not a crash", async () => {
    const r = rig({ purges: [new Error("boom")] });
    await wrapped(r).signOut?.();
    expect(r.toasts).toHaveLength(1);
    expect(purgeWatch(wrapped(r))?.failure()).toBe("pending");
  });

  test("a malformed answer is a failure", async () => {
    const r = rig({ purges: [{} as PurgeLocalCopyResult] });
    await wrapped(r).signOut?.();
    expect(purgeWatch(wrapped(r))?.failure()).toBe("pending");
  });
});

describe("retry from the Local copy section", () => {
  test("one attempt; success clears the failure and notifies", async () => {
    const r = rig({ purges: [{ ok: false, retryNow: false }, { ok: true }] });
    const w = wrapped(r);
    await w.signOut?.();
    const watch = purgeWatch(w);
    let notified = 0;
    watch?.subscribe(() => {
      notified += 1;
    });
    expect(await watch?.retry()).toBe(true);
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(2);
    expect(watch?.failure()).toBeUndefined();
    expect(notified).toBe(1);
  });

  test("a failed retry keeps the failure; retryNow upgrades it to readable", async () => {
    const r = rig({
      purges: [
        { ok: false, retryNow: false },
        { ok: false, retryNow: true },
      ],
    });
    const w = wrapped(r);
    await w.signOut?.();
    const watch = purgeWatch(w);
    expect(await watch?.retry()).toBe(false);
    expect(watch?.failure()).toBe("readable");
  });

  test("overlapping retries share one attempt", async () => {
    const r = rig({ purges: [{ ok: false, retryNow: false }, { ok: true }] });
    const w = wrapped(r);
    await w.signOut?.();
    const watch = purgeWatch(w);
    await Promise.all([watch?.retry(), watch?.retry()]);
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(2);
  });

  test("a new session hides the failure and refuses to erase on behalf of the previous one", async () => {
    const r = rig({ purges: [{ ok: false, retryNow: false }, { ok: true }] });
    const w = wrapped(r);
    await w.signOut?.();
    const watch = purgeWatch(w);
    r.signedIn = true;
    expect(watch?.failure()).toBeUndefined();
    expect(await watch?.retry()).toBe(false);
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(1);
  });
});

describe("pass-through", () => {
  test("without purgeLocalCopy, sign-out is the host's own and there is no watch", async () => {
    const r = rig({ withPurge: false });
    const w = wrapped(r);
    await w.signOut?.();
    expect(r.log).toEqual(["signOut:start", "signOut:end"]);
    expect(purgeWatch(w)).toBeUndefined();
  });

  test("a client without signOut, or no client, is returned as it is", () => {
    const noSignOut = { id: 2, signedIn: () => true, onReset: () => () => undefined, storage: {} } as PanelClient;
    const guard = createSignOutGuard(() => undefined);
    expect(guard(noSignOut)).toBe(noSignOut);
    expect(guard(undefined)).toBeUndefined();
  });

  test("the wrapped client is stable and keeps reading live fields", () => {
    const r = rig({});
    expect(r.guard(r.client)).toBe(r.guard(r.client));
    expect(wrapped(r).id).toBe(1);
    r.signedIn = false;
    expect(wrapped(r).signedIn()).toBe(false);
  });
});

describe("a session that is still live", () => {
  test("a rejected sign-out that left the session live never purges, and the pending state shows once the session is gone", async () => {
    const failure = new Error("network");
    const r = rig({ signOut: () => Promise.reject(failure), sessionStaysOnReject: true });
    const w = wrapped(r);
    await expect(w.signOut?.()).rejects.toBe(failure);
    expect(r.signedIn).toBe(true);
    expect(r.log).toEqual(["signOut:start"]);
    expect(r.toasts).toEqual([]);
    const watch = purgeWatch(w);
    expect(watch?.failure()).toBeUndefined();
    expect(await watch?.retry()).toBe(false);
    expect(r.log).toEqual(["signOut:start"]);
    // The session ends some other way: the recorded pending state is now visible and its retry may run.
    r.signedIn = false;
    expect(watch?.failure()).toBe("pending");
    expect(await watch?.retry()).toBe(true);
    expect(r.log).toEqual(["signOut:start", "purge"]);
    expect(watch?.failure()).toBeUndefined();
  });
});

describe("a purge that resolves to nothing", () => {
  afterEach(() => jest.useRealTimers());

  for (const [name, answer] of [["null", null], ["undefined", undefined]] as const) {
    test(`resolving ${name} is a failed attempt: sign-out settles at once, with the pending warning and no unhandled rejection`, async () => {
      jest.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const r = rig({ purgeImpl: () => Promise.resolve(answer as unknown as PurgeLocalCopyResult) });
        const w = wrapped(r);
        // No timer is advanced: the attempt must settle on its own, not by waiting out the timeout.
        await w.signOut?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(r.log).toEqual(["signOut:start", "signOut:end", "purge"]);
        expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.pending" }]);
        expect(purgeWatch(w)?.failure()).toBe("pending");
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }

  test("a non-object answer is a failed attempt, and retryNow only counts when it is exactly true", async () => {
    jest.useFakeTimers();
    const r = rig({
      purgeImpl: (call) => Promise.resolve((call === 0 ? "ok" : { ok: false, retryNow: "yes" }) as unknown as PurgeLocalCopyResult),
    });
    const w = wrapped(r);
    await w.signOut?.();
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(1);
    expect(purgeWatch(w)?.failure()).toBe("pending");
    expect(await purgeWatch(w)?.retry()).toBe(false);
    expect(purgeWatch(w)?.failure()).toBe("pending");
  });
});

describe("a hung purge", () => {
  afterEach(() => jest.useRealTimers());

  async function settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }

  test("sign-out settles at the timeout with the pending warning, and the next sign-out reaches the host again", async () => {
    jest.useFakeTimers();
    const r = rig({ purgeImpl: (call) => (call === 0 ? new Promise<PurgeLocalCopyResult>(() => undefined) : Promise.resolve({ ok: true })) });
    const w = wrapped(r);
    let settled = false;
    const first = w.signOut?.().then(() => {
      settled = true;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS - 1);
    await settleMicrotasks();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await first;
    expect(settled).toBe(true);
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.pending" }]);
    expect(purgeWatch(w)?.failure()).toBe("pending");

    // The timed-out run must not hold later sign-outs: the host's signOut is called again.
    r.signedIn = true;
    await w.signOut?.();
    expect(r.log.filter((entry) => entry === "signOut:start")).toHaveLength(2);
    expect(purgeWatch(w)?.failure()).toBeUndefined();
  });

  test("a timed-out purge is not retried at once, even when it never said retryNow", async () => {
    jest.useFakeTimers();
    const r = rig({ purgeImpl: () => new Promise<PurgeLocalCopyResult>(() => undefined) });
    const done = wrapped(r).signOut?.();
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    await done;
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(1);
  });

  test("a purge that settles late is ignored: an ok keeps the warning, a rejection is swallowed", async () => {
    jest.useFakeTimers();
    let finishOk: (result: PurgeLocalCopyResult) => void = () => undefined;
    const r = rig({ purgeImpl: () => new Promise<PurgeLocalCopyResult>((resolve) => (finishOk = resolve)) });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    await done;
    finishOk({ ok: true });
    await settleMicrotasks();
    expect(purgeWatch(w)?.failure()).toBe("pending");
    expect(r.toasts).toHaveLength(1);

    let rejectLate: (reason: Error) => void = () => undefined;
    const r2 = rig({ purgeImpl: () => new Promise<PurgeLocalCopyResult>((_, reject) => (rejectLate = reject)) });
    const w2 = wrapped(r2);
    const done2 = w2.signOut?.();
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    await done2;
    rejectLate(new Error("late"));
    await settleMicrotasks();
    expect(purgeWatch(w2)?.failure()).toBe("pending");
  });

  test("a hung retry settles at the timeout, reports failure, and can be tried again", async () => {
    jest.useFakeTimers();
    const r = rig({
      purgeImpl: (call) => (call === 0 ? Promise.resolve({ ok: false, retryNow: false }) : call === 1 ? new Promise<PurgeLocalCopyResult>(() => undefined) : Promise.resolve({ ok: true })),
    });
    const w = wrapped(r);
    await w.signOut?.();
    const watch = purgeWatch(w);
    expect(watch?.failure()).toBe("pending");
    const first = watch?.retry();
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    expect(await first).toBe(false);
    expect(watch?.failure()).toBe("pending");
    expect(await watch?.retry()).toBe(true);
    expect(watch?.failure()).toBeUndefined();
  });

  test("R1: a timed-out newer run keeps an earlier 'readable' state and still says the copy may be readable", async () => {
    jest.useFakeTimers();
    const r = rig({
      purgeImpl: (call) => (call < 2 ? Promise.resolve({ ok: false, retryNow: true }) : new Promise<PurgeLocalCopyResult>(() => undefined)),
    });
    const w = wrapped(r);
    await w.signOut?.(); // calls 0 and 1: the keys may still be in the database
    expect(purgeWatch(w)?.failure()).toBe("readable");
    r.signedIn = true;
    const second = w.signOut?.(); // the newer run hangs
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    await second;
    expect(purgeWatch(w)?.failure()).toBe("readable");
    expect(r.toasts.at(-1)).toEqual({ kind: "warning", textCode: "local-copy.purge.toast.readable" });
  });

  test("a real plain failure from the host still replaces 'readable': the host is the authority", async () => {
    jest.useFakeTimers();
    const r = rig({
      purgeImpl: (call) => Promise.resolve(call < 2 ? { ok: false, retryNow: true } : { ok: false, retryNow: false }),
    });
    const w = wrapped(r);
    await w.signOut?.();
    expect(purgeWatch(w)?.failure()).toBe("readable");
    r.signedIn = true;
    await w.signOut?.();
    expect(purgeWatch(w)?.failure()).toBe("pending");
    expect(r.toasts.at(-1)).toEqual({ kind: "warning", textCode: "local-copy.purge.toast.pending" });
  });

  test("a timed-out run with nothing recorded before is pending, not readable", async () => {
    jest.useFakeTimers();
    const r = rig({ purgeImpl: () => new Promise<PurgeLocalCopyResult>(() => undefined) });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleMicrotasks();
    jest.advanceTimersByTime(PURGE_TIMEOUT_MS);
    await done;
    expect(purgeWatch(w)?.failure()).toBe("pending");
  });
});

/** A purge the test settles by hand, so a result can arrive after the session has changed. */
function deferredPurge() {
  const calls: Array<(result: PurgeLocalCopyResult) => void> = [];
  return {
    impl: (): Promise<PurgeLocalCopyResult> => new Promise((resolve) => calls.push(resolve)),
    settle: (call: number, result: PurgeLocalCopyResult) => calls[call]?.(result),
    count: () => calls.length,
  };
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("a session change while a purge is running", () => {
  test("G3/R2: a failure that arrives after a new session signed in is recorded with the host's own verdict, with no warning and no purge for that session", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    expect(purge.count()).toBe(1);
    r.signedIn = true; // a new session signs in while the old purge is still running
    purge.settle(0, { ok: false, retryNow: true }); // the keys may still be in the database
    await done;
    expect(r.toasts).toEqual([]);
    expect(purge.count()).toBe(1); // the old run never purges again while someone is signed in
    expect(purgeWatch(w)?.failure()).toBeUndefined(); // hidden while signed in
    r.signedIn = false;
    expect(purgeWatch(w)?.failure()).toBe("readable");
  });

  test("G3: a plain failure that arrives after a new session signed in is recorded as pending", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    r.signedIn = true;
    purge.settle(0, { ok: false, retryNow: false });
    await done;
    r.signedIn = false;
    expect(purgeWatch(w)?.failure()).toBe("pending");
  });

  test("G2: a reset during the purge with nobody signed in still records a plain failure and raises the warning", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    r.reset(); // app code called tc.signOut(): its finally resets the panel's client
    purge.settle(0, { ok: false, retryNow: false });
    await done;
    expect(r.signedIn).toBe(false);
    expect(purgeWatch(w)?.failure()).toBe("pending");
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.pending" }]);
  });

  test("G1: a reset during a retryNow failure while signed out still retries at once, then records the readable failure", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    r.reset();
    purge.settle(0, { ok: false, retryNow: true });
    await settleAll();
    expect(purge.count()).toBe(2);
    purge.settle(1, { ok: false, retryNow: true });
    await done;
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(2);
    expect(purgeWatch(w)?.failure()).toBe("readable");
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.readable" }]);
  });

  test("a reset during the purge does not stop a successful purge from clearing an earlier warning", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    purge.settle(0, { ok: false, retryNow: false });
    await first;
    expect(purgeWatch(w)?.failure()).toBe("pending");
    r.signedIn = true;
    const second = w.signOut?.();
    await settleAll();
    r.reset();
    purge.settle(1, { ok: true });
    await second;
    expect(purgeWatch(w)?.failure()).toBeUndefined();
  });

  test("a retryNow answer after a new session signed in does not purge a second time for it", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    r.signedIn = true;
    purge.settle(0, { ok: false, retryNow: true });
    await done;
    expect(purge.count()).toBe(1);
    expect(r.log.filter((entry) => entry === "purge")).toHaveLength(1);
  });

  test("an old purge that fails after a newer run succeeded raises no false alarm and records nothing", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    r.signedIn = true;
    const second = w.signOut?.(); // the newer run starts its own purge
    await settleAll();
    expect(purge.count()).toBe(2);
    purge.settle(1, { ok: true });
    await second;
    purge.settle(0, { ok: false, retryNow: true }); // the old one fails late
    await first;
    expect(r.toasts).toEqual([]);
    expect(purge.count()).toBe(2);
    expect(purgeWatch(w)?.failure()).toBeUndefined();
  });

  test("a stale ok does not clear a warning that belongs to a newer sign-out", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    r.signedIn = true; // new session; its sign-out starts a second run while the first purge is still running
    const second = w.signOut?.();
    await settleAll();
    expect(purge.count()).toBe(2);
    purge.settle(1, { ok: false, retryNow: false });
    await second;
    expect(purgeWatch(w)?.failure()).toBe("pending");
    purge.settle(0, { ok: true });
    await first;
    expect(purgeWatch(w)?.failure()).toBe("pending");
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.toast.pending" }]);
  });

  test("a new session's sign-out reaches the host while the previous purge is still running", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    r.signedIn = true;
    const second = w.signOut?.();
    await settleAll();
    expect(r.log.filter((entry) => entry === "signOut:start")).toHaveLength(2);
    expect(r.signedIn).toBe(false);
    purge.settle(0, { ok: true });
    purge.settle(1, { ok: true });
    await Promise.all([first, second]);
    // The first run finishing late must not leave the next sign-out blocked behind it.
    r.signedIn = true;
    const third = w.signOut?.();
    await settleAll();
    purge.settle(2, { ok: true });
    await third;
    expect(r.log.filter((entry) => entry === "signOut:start")).toHaveLength(3);
  });

  test("a second sign-out of the same session while its purge runs shares that run", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    const second = w.signOut?.();
    await settleAll();
    expect(r.log.filter((entry) => entry === "signOut:start")).toHaveLength(1);
    purge.settle(0, { ok: true });
    await Promise.all([first, second]);
    expect(purge.count()).toBe(1);
  });

  test("a retry that finishes after a new session signed in changes nothing and reports not removed", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    purge.settle(0, { ok: false, retryNow: false });
    await done;
    const watch = purgeWatch(w);
    expect(watch?.failure()).toBe("pending");
    const retry = watch?.retry();
    await settleAll();
    r.signedIn = true; // a new session signs in while the retry runs
    purge.settle(1, { ok: true });
    expect(await retry).toBe(false);
    r.signedIn = false;
    expect(watch?.failure()).toBe("pending");
  });

  test("a retry that finishes after a reset with nobody signed in is applied: an ok clears the warning and reports removed", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    purge.settle(0, { ok: false, retryNow: false });
    await done;
    const watch = purgeWatch(w);
    const retry = watch?.retry();
    await settleAll();
    r.reset(); // app code called tc.signOut() while the retry ran
    purge.settle(1, { ok: true });
    expect(await retry).toBe(true);
    expect(watch?.failure()).toBeUndefined();
  });

  test("a retry that finishes after a reset with a failure upgrades the warning when the keys may be readable", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const done = w.signOut?.();
    await settleAll();
    purge.settle(0, { ok: false, retryNow: false });
    await done;
    const watch = purgeWatch(w);
    const retry = watch?.retry();
    await settleAll();
    r.reset();
    purge.settle(1, { ok: false, retryNow: true });
    expect(await retry).toBe(false);
    expect(watch?.failure()).toBe("readable");
  });

  test("a retry that a newer run overtook changes nothing and reports not removed", async () => {
    const purge = deferredPurge();
    const r = rig({ purgeImpl: purge.impl });
    const w = wrapped(r);
    const first = w.signOut?.();
    await settleAll();
    purge.settle(0, { ok: false, retryNow: false });
    await first;
    const watch = purgeWatch(w);
    const retry = watch?.retry(); // call 1, still running
    await settleAll();
    r.signedIn = true;
    const second = w.signOut?.(); // a newer run: call 2
    await settleAll();
    expect(purge.count()).toBe(3);
    purge.settle(2, { ok: false, retryNow: true });
    await settleAll();
    purge.settle(3, { ok: false, retryNow: true });
    await second;
    expect(watch?.failure()).toBe("readable");
    purge.settle(1, { ok: true }); // the overtaken retry finishes last and must not clear the newer warning
    expect(await retry).toBe(false);
    expect(watch?.failure()).toBe("readable");
  });

  test("while a session is signed in a retry never runs, and never claims the copy is gone", async () => {
    const r = rig({ purges: [{ ok: true }] });
    const w = wrapped(r);
    const watch = purgeWatch(w);
    expect(r.signedIn).toBe(true);
    expect(await watch?.retry()).toBe(false);
    expect(r.log).toEqual([]);
  });
});
