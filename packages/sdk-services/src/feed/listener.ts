import { ErrorCodes } from "../types";
import { initializeFeedHandoff, deliverFeedResponse } from "./handoff";
import { listFeedResponseDeliveries } from "./delivery-policy";
import { isDispatchDeadlineFailure } from "./dispatch";
import type { FeedApi } from "./types";

export const listenFeedResponses: FeedApi["listenFeedResponses"] = async (options) => {
  const { signal } = options;
  const renewalSeconds = options.renewalSeconds ?? 300;
  if (!Number.isInteger(renewalSeconds) || renewalSeconds < 60 || renewalSeconds > 300) {
    throw new Error("Feed renewal must be between 60 and 300 seconds");
  }
  if (options.subscription.service !== "sql" || !options.subscription.pathPrefix) {
    throw new Error("Feed listener requires the exact response SQL resource subscription");
  }
  if (signal.aborted) return;
  const initialized = await initializeFeedHandoff(options.handoff);
  if (!initialized.ok) throw initialized.error;
  let ready = false;
  let dirty = false;
  let draining: Promise<void> | undefined;
  let failed = false;
  let failure: unknown;
  let current: AbortController | undefined;

  const drain = async (): Promise<void> => {
    do {
      dirty = false;
      let afterSequence = 0;
      while (!signal.aborted) {
        const page = await listFeedResponseDeliveries(options.responses, { recipient: options.recipient, afterSequence, limit: 100, signal });
        if (!page.ok) {
          if (signal.aborted && page.error.code === ErrorCodes.ABORTED) return;
          throw page.error;
        }
        for (const response of page.data.responses) {
          if (signal.aborted) return;
          const handoff = await deliverFeedResponse({
            handoff: options.handoff, recipient: options.recipient, response, deliver: options.deliver,
          });
          if (!handoff.ok && !isDispatchDeadlineFailure(handoff.error)) throw handoff.error;
        }
        if (page.data.hasMore && page.data.nextSequence <= afterSequence) throw new Error("Delivery page did not advance a verified cursor");
        afterSequence = page.data.nextSequence;
        if (!page.data.hasMore) break;
      }
    } while (dirty && !signal.aborted);
  };
  const schedule = (): void => {
    if (!ready || signal.aborted || failed) return;
    dirty = true;
    if (draining) return;
    draining = drain().catch((error: unknown) => {
      failed = true;
      failure = error;
      current?.abort();
    }).finally(() => {
      draining = undefined;
      if (dirty && !failed) schedule();
    });
  };

  while (!signal.aborted && !failed) {
    const connection = new AbortController();
    current = connection;
    const stop = () => connection.abort();
    signal.addEventListener("abort", stop, { once: true });
    // Periodic subscription renewal also bounds recovery of a missed wakeup.
    // No response query runs until the new stream's authorized ready callback.
    const renewal = setTimeout(stop, renewalSeconds * 1000);
    renewal.unref?.();
    try {
      for await (const _event of options.hooks.subscribe([options.subscription], {
        signal: connection.signal,
        ttlSeconds: renewalSeconds,
        onReady: () => {
          if (current !== connection || connection.signal.aborted || signal.aborted) return;
          ready = true;
          schedule();
        },
      })) schedule();
    } finally {
      ready = false;
      clearTimeout(renewal);
      signal.removeEventListener("abort", stop);
      await draining;
    }
    if (failed) throw failure;
    // Sign-out/terminal completion belongs to hooks; do not restart it as a retry.
    if (!connection.signal.aborted) return;
  }
  if (failed) throw failure;
};
