import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runShareCaptured as RunShareCaptured } from "./share.integration-harness.js";

// `receiveShare` is the share-sdk function the `receive` action calls; it is the only thing replaced here. The command,
// its option handling, error mapping and output run for real.
type Authorization = { state: "authorization-required"; method: "openkey-device" | "email-claim" };
let nextResult: Authorization = { state: "authorization-required", method: "email-claim" };
let receiveCalls = 0;

let runShareCaptured: typeof RunShareCaptured;

// The imports below are dynamic on purpose: `mock.module` must run before `share.ts` loads, and static imports hoist.

beforeAll(async () => {
  // `real` supplies every other share-sdk export the command uses.
  const real = await import("@tinycloud/share-sdk");
  mock.module("@tinycloud/share-sdk", () => ({ ...real, receiveShare: async () => { receiveCalls++; return nextResult; } }));
  // Load the command graph after the module mock.
  ({ runShareCaptured } = await import("./share.integration-harness.js"));
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const LINK = "https://share.tinycloud.xyz/s/aaaaaaaaaaaaaaaaaaaaaaaaaa#v=4&k=synthetic-key&c=bafkreisynthetic";
const OLD_MESSAGE = "recipient authorization is required; resume through the configured authority adapter";
const EMAIL_MESSAGE = "email-addressed shares cannot be opened with this version of the CLI yet; open the link in a web browser";

async function receive(result: Authorization, extra: readonly string[]) {
  nextResult = result;
  receiveCalls = 0;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => { requests.push(String(input)); throw new Error("network must not be reached"); }) as unknown as typeof fetch;
  const out = await mkdtemp(join(tmpdir(), "tc-share-receive-email-claim-"));
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const captured = await runShareCaptured(["share", "receive", LINK, "--output", out, ...extra]);
    return { ...captured, exitCode: exitCode ?? captured.exitCode, written: await readdir(out), requests, receiveCalls };
  } finally {
    process.exit = originalExit;
    await rm(out, { recursive: true, force: true });
  }
}

describe("share receive of an authorization-required link", () => {
  test("human mode, email-claim: plain CLAIM_REQUIRED message, exit 6, nothing written, no network", async () => {
    const result = await receive({ state: "authorization-required", method: "email-claim" }, []);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("CLAIM_REQUIRED");
    expect(result.stderr).toContain(EMAIL_MESSAGE);
    expect(result.stderr).not.toContain("authority adapter");
    expect(result.written).toEqual([]);
    expect(result.requests).toEqual([]);
    expect(result.receiveCalls).toBe(1);
  });

  test("human mode, openkey-device: keeps its code and its message", async () => {
    const result = await receive({ state: "authorization-required", method: "openkey-device" }, []);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("DEVICE_AUTH_REQUIRED");
    expect(result.stderr).toContain(OLD_MESSAGE);
    expect(result.stderr).not.toContain(EMAIL_MESSAGE);
    expect(result.written).toEqual([]);
  });

  test("--json, email-claim: exit 6 and the unchanged authorization object", async () => {
    const result = await receive({ state: "authorization-required", method: "email-claim" }, ["--json"]);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stdout)).toEqual({
      protocol: "tinycloud-share", version: 1,
      authorization: { state: "authorization-required", method: "email-claim", next: "complete authorization through the configured authority adapter, then retry with the required proof" },
    });
    expect(result.stderr).not.toContain(EMAIL_MESSAGE);
    expect(result.written).toEqual([]);
  });

  test("--json, openkey-device: unchanged authorization object", async () => {
    const result = await receive({ state: "authorization-required", method: "openkey-device" }, ["--json"]);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stdout)).toEqual({
      protocol: "tinycloud-share", version: 1,
      authorization: { state: "authorization-required", method: "openkey-device", next: "complete authorization through the configured authority adapter, then retry with the required proof" },
    });
  });
});
