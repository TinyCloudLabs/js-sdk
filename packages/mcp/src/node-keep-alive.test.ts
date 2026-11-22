import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packageDirectory = new URL("..", import.meta.url).pathname;
const nodeBinary = process.env.NODE_BINARY ?? "node";

interface Counted {
  connections: number;
  requests: number;
  answers: boolean[];
}

// The scenarios wait in real time on purpose: the pool's idle timer and the server's
// idle close are socket timers on the platform clock, which fake timers cannot
// advance. They total about 14 s; each wait is at most 4.6 s and the margins are at
// least 0.4 s.
const run = spawnSync(nodeBinary, [join(packageDirectory, "src/test-support/node-keep-alive-scenarios.mjs")], {
  encoding: "utf8",
  timeout: 90_000,
});
if (run.status !== 0) throw new Error(`keep-alive scenarios failed: ${run.stderr}`);
const results = JSON.parse(run.stdout) as {
  limit: number;
  reuse: Counted;
  expired: Counted;
  installed: Counted;
  resetOnce: { ok: boolean; requests: number };
  resetTwice: { ok: boolean; requests: number };
  errorStatus: { result: { ok: boolean; error: { code: string; status: number } }; requests: number };
  thrown: { resetAttempts: number; resetPropagated: boolean; otherAttempts: number; otherPropagated: boolean };
};

test("the node keep-alive limit lies above a 60 s poll and below the 65 s ingress idle limit", () => {
  expect(results.limit).toBeGreaterThan(60_000);
  expect(results.limit).toBeLessThan(65_000);
});

test("five reads spaced inside the keep-alive limit share one connection that the server never closes first", () => {
  expect(results.reuse).toEqual({ connections: 1, requests: 5, answers: [true, true, true, true, true] });
});

test("a read after the connection idled past the keep-alive limit opens a new connection and succeeds", () => {
  expect(results.expired).toEqual({ connections: 2, requests: 2, answers: [true, true] });
});

test("Node's own fetch keeps a connection across 4.6 s of idle time once the keep-alive pool is installed", () => {
  expect(results.installed).toEqual({ connections: 1, requests: 2, answers: [true, true] });
});

test("a read on a connection that the peer resets before any response is repeated once and succeeds", () => {
  expect(results.resetOnce.ok).toBe(true);
  expect(results.resetOnce.requests).toBe(2);
});

test("a second reset is returned to the caller after one repeat", () => {
  expect(results.resetTwice.ok).toBe(false);
  expect(results.resetTwice.requests).toBe(2);
});

test("a read that the node answers with an error status is not repeated", () => {
  expect(results.errorStatus.result).toEqual({ ok: false, error: { code: "NETWORK_ERROR", status: 500 } });
  expect(results.errorStatus.requests).toBe(1);
});

test("a thrown reset is repeated once, and any other thrown error propagates at the first attempt", () => {
  expect(results.thrown).toEqual({ resetAttempts: 2, resetPropagated: true, otherAttempts: 1, otherPropagated: true });
});
