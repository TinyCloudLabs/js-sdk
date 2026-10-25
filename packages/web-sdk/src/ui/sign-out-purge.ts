/*
 * Sign-out purge for the panel.
 *
 * No production host supplies `purgeLocalCopy` or `sync` today (tcw.ts builds the panel's ClientSource with only
 * signedIn, storage, storageEpisode and signOut). Until the SDK provides them (TC-1888 / W4), the panel's
 * sign-out purges nothing and the Local copy section is unavailable. This module is the panel's side of that
 * seam: it orders the calls and surfaces a failure. It has no purge logic of its own.
 */
import type { PanelClient, PurgeLocalCopyResult } from "./slots";
import type { ToastRequest } from "./toast-store";

/** Longest a single purge attempt may run before it counts as failed, so a hung host purge cannot hang sign-out. */
export const PURGE_TIMEOUT_MS = 10_000;

/** Why the local copy is still on the device after sign-out. `readable`: its keys may still be in the database. */
export type PurgeFailure = "pending" | "readable";

/** What the Local copy section reads and does about an outstanding purge. */
export interface PurgeWatch {
  /** The outstanding failure, or undefined. Always undefined while a session is signed in. */
  failure(): PurgeFailure | undefined;
  subscribe(cb: () => void): () => void;
  /** One more attempt. Resolves true when the copy is gone. Refuses while signed in. */
  retry(): Promise<boolean>;
}

interface Entry extends PurgeWatch {
  /**
   * Marks the start of a purge (after a sign-out, or a retry). The returned function is true while no newer purge
   * has started since: a result is dropped only when a newer purge owns the state, never because a reset happened.
   */
  begin(): () => boolean;
  /**
   * Applies the outcome of the purge that follows a sign-out. A failure is warned about when nobody is signed in;
   * when someone signed in meanwhile it is only recorded (hidden until they sign out). An ok clears the state, and
   * is dropped when someone signed in meanwhile.
   */
  settle(result: PurgeLocalCopyResult, readable: boolean): void;
  /** Records that the copy was not removed, without a warning: the session is still live, so the purge did not run. */
  markPending(): void;
}

const watches = new WeakMap<PanelClient, Entry>();
const guarded = new WeakMap<PanelClient, PanelClient>();

/** The purge watch for a client (wrapped or not) the sign-out guard has seen. */
export function purgeWatch(client: PanelClient | undefined): PurgeWatch | undefined {
  return client === undefined ? undefined : watches.get(client);
}

/**
 * The answer given for a purge that did not settle within `PURGE_TIMEOUT_MS`. It is compared by identity: a timeout
 * is a failed attempt that says nothing about the keys, unlike a failure the host reported itself.
 */
const TIMED_OUT: PurgeLocalCopyResult = Object.freeze({ ok: false, retryNow: false });

/**
 * Runs the host's purge, raced against `PURGE_TIMEOUT_MS`. A throw, a malformed answer or a timeout is a failed
 * attempt that keeps no claim about the keys. A purge that settles after the timeout is ignored: the attempt has
 * already reported failure, and the warning stays until a retry succeeds. A late rejection is swallowed here.
 */
function attempt(purge: () => Promise<PurgeLocalCopyResult>): Promise<PurgeLocalCopyResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PurgeLocalCopyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(TIMED_OUT), PURGE_TIMEOUT_MS);
    Promise.resolve()
      .then(purge)
      .then(
        // Anything but exactly { ok: true } is a failure, and retryNow counts only when it is exactly true.
        (result) => finish(result?.ok === true ? { ok: true } : { ok: false, retryNow: result?.retryNow === true }),
        () => finish({ ok: false, retryNow: false }),
      );
  });
}

function createEntry(client: PanelClient, purge: () => Promise<PurgeLocalCopyResult>, toast: (request: ToastRequest) => unknown): Entry {
  let failure: PurgeFailure | undefined;
  let newest = 0;
  let retrying: { readonly promise: Promise<boolean>; readonly latest: () => boolean } | undefined;
  const listeners = new Set<() => void>();
  const set = (next: PurgeFailure | undefined): void => {
    if (failure === next) return;
    failure = next;
    for (const cb of [...listeners]) cb();
  };
  const begin = (): (() => boolean) => {
    const mine = ++newest;
    return () => newest === mine;
  };
  return {
    begin,
    failure: () => (client.signedIn() ? undefined : failure),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    settle(result, readable) {
      // The keys may still be readable if the host said so (this answer, or the run's first one). A timeout keeps no
      // claim about the keys, so it leaves an earlier "readable" in place; a failure the host reported replaces it.
      const keepsReadable = failure === "readable" && result === TIMED_OUT;
      const next: PurgeFailure = readable || (result.ok === false && result.retryNow) || keepsReadable ? "readable" : "pending";
      if (client.signedIn()) {
        // Someone signed in while the purge ran: record the failure, say nothing to them, never clear on their watch.
        if (result.ok === false) set(next);
        return;
      }
      if (result.ok === true) {
        set(undefined);
        return;
      }
      set(next);
      toast({ kind: "warning", textCode: next === "readable" ? "local-copy.purge.toast.readable" : "local-copy.purge.toast.pending" });
    },
    markPending() {
      set(failure === "readable" ? "readable" : "pending");
    },
    retry() {
      // A new session may own a live copy by now: never erase on behalf of the previous one, and never say it is gone.
      if (client.signedIn()) return Promise.resolve(false);
      if (failure === undefined) return Promise.resolve(true);
      // Share a retry that is still the newest purge; one a newer purge has overtaken does not own the state.
      if (retrying !== undefined && retrying.latest()) return retrying.promise;
      const latest = begin();
      const promise: Promise<boolean> = attempt(purge)
        .then((result) => {
          // Only a newer purge makes this answer stale; a reset alone does not, or a failure would go unrecorded.
          if (!latest()) return false;
          if (result.ok === true) {
            if (client.signedIn()) return false;
            set(undefined);
            return true;
          }
          if (result.retryNow) set("readable");
          return false;
        })
        .finally(() => {
          if (retrying?.promise === promise) retrying = undefined;
        });
      retrying = { promise, latest };
      return promise;
    },
  };
}

/**
 * Builds the panel's view of a client in which `signOut` removes the local copy after the session ends.
 *
 * Order, which the replica depends on: `signOut()` runs first, so the replica gate is denied and its keys are
 * deleted in the deny transaction; only then does `purgeLocalCopy()` run, whether `signOut` resolved or rejected,
 * and only if the session is actually gone (`!client.signedIn()`). A rejected sign-out that left the session live
 * never purges: a live copy must not be erased. It records the pending state instead, which the section shows
 * once the session is gone. The panel never touches the replica's storage keys and never deletes a database itself.
 * Each purge attempt is raced against `PURGE_TIMEOUT_MS`, so the returned promise always settles and a later
 * sign-out is never blocked behind a hung purge. When the purge fails with `retryNow` (keys may still be in the
 * database) it is retried once at once. A purge that still fails raises a warning toast and leaves a retry in the
 * Local copy section through `purgeWatch`. A `signOut` rejection is rethrown after the purge. The returned promise
 * settles after the purge, so the panel never reports sign-out done while a purge is still running.
 *
 * A purge result is dropped in one case only: a newer purge (a later sign-out or a retry) has started since, and
 * owns the state. A reset never drops a result: app code calling `tc.signOut()` resets the client in its finally,
 * and the copy must still be reported as not removed. The immediate retry runs whenever nobody is signed in. If
 * someone signed in while a purge ran, a failure is only recorded (shown once they sign out) and an ok is dropped.
 *
 * Only calls made through the panel pass through here; `tc.signOut()` called directly does not.
 */
export function createSignOutGuard(toast: (request: ToastRequest) => unknown): (client: PanelClient | undefined) => PanelClient | undefined {
  return (client) => {
    const signOut = client?.signOut;
    if (client === undefined || signOut === undefined) return client;
    const known = guarded.get(client);
    if (known !== undefined) return known;

    const purge = client.purgeLocalCopy;
    const entry = purge === undefined ? undefined : createEntry(client, purge, toast);
    let inFlight: { readonly promise: Promise<void>; purging: boolean } | undefined;
    const run = async (onSettled: () => void): Promise<void> => {
      let failed = false;
      let cause: unknown;
      try {
        await signOut();
      } catch (error) {
        failed = true;
        cause = error;
      }
      onSettled();
      if (purge !== undefined && entry !== undefined) {
        if (client.signedIn()) {
          entry.markPending();
        } else {
          const latest = entry.begin();
          let result = await attempt(purge);
          // Dropped only when a newer purge has started since: that one owns the state. A reset alone changes nothing.
          if (latest()) {
            const readable = result.ok === false && result.retryNow;
            // The keys may still be in the database: try once more at once, whenever nobody is signed in.
            if (readable && !client.signedIn()) result = await attempt(purge);
            if (latest()) entry.settle(result, readable);
          }
        }
      }
      if (failed) throw cause;
    };
    // Getters on the client (sync, storage, data) stay live through the prototype.
    const wrapped: PanelClient = Object.create(client, {
      signOut: {
        value: (): Promise<void> => {
          const current = inFlight;
          // Share a run still signing out, or purging for a session that is still gone. A new session's
          // sign-out starts its own run: it must reach the host and must not wait behind an old purge.
          if (current !== undefined && (!current.purging || !client.signedIn())) return current.promise;
          const mine: { promise: Promise<void>; purging: boolean } = {
            purging: false,
            promise: Promise.resolve(),
          };
          mine.promise = run(() => {
            mine.purging = true;
          }).finally(() => {
            if (inFlight === mine) inFlight = undefined;
          });
          inFlight = mine;
          return mine.promise;
        },
      },
    });
    guarded.set(client, wrapped);
    if (entry !== undefined) {
      watches.set(client, entry);
      watches.set(wrapped, entry);
    }
    return wrapped;
  };
}
