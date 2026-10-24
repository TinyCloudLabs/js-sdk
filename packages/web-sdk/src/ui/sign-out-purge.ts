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
  /** Records the outcome of the purge that follows a sign-out and raises the warning for a failure. */
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
    const timer = setTimeout(() => finish({ ok: false, retryNow: false }), PURGE_TIMEOUT_MS);
    Promise.resolve()
      .then(purge)
      .then(
        // Anything but exactly { ok: true } is a failure, and retryNow counts only when it is exactly true.
        (result) => finish(result?.ok === true ? { ok: true } : { ok: false, retryNow: result?.retryNow === true }),
        () => finish({ ok: false, retryNow: false }),
      );
  });
}

/** True while the session a purge was started for is still the current one: no reset since, and nobody signed in. */
type SessionStamp = () => boolean;

function createEntry(
  client: PanelClient,
  purge: () => Promise<PurgeLocalCopyResult>,
  toast: (request: ToastRequest) => unknown,
  stamp: () => SessionStamp,
): Entry {
  let failure: PurgeFailure | undefined;
  let retrying: { readonly promise: Promise<boolean>; readonly same: SessionStamp } | undefined;
  const listeners = new Set<() => void>();
  const set = (next: PurgeFailure | undefined): void => {
    if (failure === next) return;
    failure = next;
    for (const cb of [...listeners]) cb();
  };
  return {
    failure: () => (client.signedIn() ? undefined : failure),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    settle(result, readable) {
      if (result.ok === true) {
        set(undefined);
        return;
      }
      set(readable ? "readable" : "pending");
      toast({ kind: "warning", textCode: readable ? "local-copy.purge.toast.readable" : "local-copy.purge.toast.pending" });
    },
    markPending() {
      set("pending");
    },
    retry() {
      // A new session may own a live copy by now: never erase on behalf of the previous one, and never say it is gone.
      if (client.signedIn()) return Promise.resolve(false);
      if (failure === undefined) return Promise.resolve(true);
      // Share a retry already running for this same session; one left over from an earlier session is not this one.
      if (retrying !== undefined && retrying.same()) return retrying.promise;
      const same = stamp();
      const promise: Promise<boolean> = attempt(purge)
        .then((result) => {
          // The answer belongs to the session it was started for: after a change it is dropped, not applied.
          if (!same()) return false;
          if (result.ok === true) set(undefined);
          else if (result.retryNow) set("readable");
          return result.ok;
        })
        .finally(() => {
          if (retrying?.promise === promise) retrying = undefined;
        });
      retrying = { promise, same };
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
 * Only calls made through the panel pass through here; `tc.signOut()` called directly does not.
 */
export function createSignOutGuard(toast: (request: ToastRequest) => unknown): (client: PanelClient | undefined) => PanelClient | undefined {
  return (client) => {
    const signOut = client?.signOut;
    if (client === undefined || signOut === undefined) return client;
    const known = guarded.get(client);
    if (known !== undefined) return known;

    // Each purge is stamped with the session it belongs to. tcw.signOut calls reset() before it settles, so a
    // reset after sign-out settled is a later change of account or session.
    let epoch = 0;
    client.onReset(() => {
      epoch += 1;
    });
    const stamp = (): SessionStamp => {
      const mine = epoch;
      return () => epoch === mine && !client.signedIn();
    };
    const purge = client.purgeLocalCopy;
    const entry = purge === undefined ? undefined : createEntry(client, purge, toast, stamp);
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
      const same = stamp();
      if (purge !== undefined && entry !== undefined) {
        if (client.signedIn()) {
          entry.markPending();
        } else {
          let result = await attempt(purge);
          // A result for a session that has since changed is dropped: no warning, no clearing, no second purge.
          if (same()) {
            const readable = result.ok === false && result.retryNow;
            if (readable) result = await attempt(purge);
            if (same()) entry.settle(result, readable);
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
