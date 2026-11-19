// Test preload (`bun --preload`): the prepared OpenKey handoff's 5-minute expiry fires after
// 200 ms, so an expiry test exercises the real CLI path without waiting. Other timers are untouched.
const HANDOFF_EXPIRY_MS = 300_000;
const realSetTimeout = globalThis.setTimeout;
Object.assign(globalThis, {
  setTimeout: (handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(handler, ms === HANDOFF_EXPIRY_MS ? 200 : ms, ...args),
});
