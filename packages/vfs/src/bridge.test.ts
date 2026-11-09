import { afterEach, expect, test } from "bun:test";
import type { Worker } from "node:worker_threads";
import { TinyCloudVfsBridge, TinyCloudVfsBridgeTimeoutError, setBridgeTestHooks } from "./bridge";

afterEach(() => setBridgeTestHooks({}));

test("a bridge call whose worker never answers fails with a typed timeout", () => {
  let terminated = false;
  const silentWorker = {
    postMessage: () => {},
    terminate: () => { terminated = true; return Promise.resolve(0); },
  } as unknown as Worker;

  const started = Date.now();
  let caught: unknown;
  try {
    setBridgeTestHooks({ timeoutMs: 150, createWorker: () => silentWorker });
    new TinyCloudVfsBridge({} as never);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TinyCloudVfsBridgeTimeoutError);
  expect((caught as TinyCloudVfsBridgeTimeoutError).code).toBe("ETIMEDOUT");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(terminated).toBe(true);
});
