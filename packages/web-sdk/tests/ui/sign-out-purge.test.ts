import { describe, expect, test } from "bun:test";

import { createSignOutGuard, purgeWatch } from "../../src/ui/sign-out-purge";
import type { PanelClient, PurgeLocalCopyResult } from "../../src/ui/slots";
import type { ToastRequest } from "../../src/ui/toast-store";

interface Rig {
  readonly client: PanelClient;
  readonly guard: (client: PanelClient | undefined) => PanelClient | undefined;
  readonly toasts: ToastRequest[];
  readonly log: string[];
  signedIn: boolean;
}

/** Records call order in `log`. `purges` answers each purge call in turn; the last answer repeats. */
function rig(opts: {
  purges?: Array<PurgeLocalCopyResult | Error>;
  signOut?: () => Promise<void>;
  withPurge?: boolean;
}): Rig {
  const log: string[] = [];
  const toasts: ToastRequest[] = [];
  const answers = opts.purges ?? [{ ok: true }];
  let calls = 0;
  const state = { signedIn: true };
  const client = {
    id: 1,
    signedIn: () => state.signedIn,
    onReset: () => () => undefined,
    storage: {},
    get sync() {
      return undefined;
    },
    signOut: async () => {
      log.push("signOut:start");
      await (opts.signOut ?? (() => Promise.resolve()))();
      state.signedIn = false;
      log.push("signOut:end");
    },
    ...(opts.withPurge === false
      ? {}
      : {
          purgeLocalCopy: async () => {
            const answer = answers[Math.min(calls, answers.length - 1)];
            calls += 1;
            log.push("purge");
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
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.pending" }]);
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
    expect(r.toasts).toEqual([{ kind: "warning", textCode: "local-copy.purge.readable" }]);
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
