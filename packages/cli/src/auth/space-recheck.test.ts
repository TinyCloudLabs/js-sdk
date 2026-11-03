import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import { recheckSpaceHosting } from "./space-setup.js";

const space = "tinycloud:pkh:eip155:1:0xabc:applications";
const kvList: PermissionEntry = { service: "tinycloud.kv", space, path: "", actions: ["tinycloud.kv/list", "tinycloud.kv/get"] };
const capabilities: PermissionEntry = { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] };
const ctx = { profile: "p", host: "https://node.test" };

const hosted = { ok: true, data: {} };
const unhosted = { ok: false, error: { code: "KV_NOT_FOUND", message: "404 - Space not found", meta: { status: 404 } } };
const denied = { ok: false, error: { code: "PERMISSION_DENIED", message: "403 - forbidden", meta: { status: 403 } } };
const down = { ok: false, error: { code: "NETWORK_ERROR", message: "503 - unavailable", meta: { status: 503 } } };

/** A fake clock (sleeping advances it) and a node whose kv read answers from a script, the last answer repeating. */
function harness(...answers: unknown[]) {
  const state = { time: 1_000_000, sleeps: [] as number[], lines: [] as string[], reads: 0, restores: 0 };
  const kv = {
    list: async () => answers[Math.min(state.reads++, answers.length - 1)],
    get: async () => answers[Math.min(state.reads++, answers.length - 1)],
  };
  const deps = {
    restore: async () => { state.restores++; return { node: { kv } } as never; },
    now: () => state.time,
    sleep: async (ms: number) => { state.sleeps.push(ms); state.time += ms; },
    write: (line: string) => { state.lines.push(line); },
  };
  return { state, deps };
}

describe("recheckSpaceHosting (onboard re-run with a usable session)", () => {
  test("a hosted space costs one read and no wait; a confirmed space is not asked again", async () => {
    const { state, deps } = harness(hosted);
    const confirmed = new Set<string>();

    await recheckSpaceHosting(ctx, "applications", [kvList], { ...deps, confirmed });
    await recheckSpaceHosting(ctx, "applications", [kvList], { ...deps, confirmed });

    expect(state.reads).toBe(1);
    expect(state.sleeps).toEqual([]);
    expect(state.lines).toEqual([]);
  });

  test("an unhosted space is waited for with the setup backoff, then the run continues", async () => {
    const { state, deps } = harness(unhosted, unhosted, unhosted, hosted);
    const confirmed = new Set<string>();

    await recheckSpaceHosting(ctx, "applications", [kvList], { ...deps, confirmed });

    expect(state.sleeps).toEqual([2_000, 3_000]);
    expect(state.lines[0]).toContain("Setting up your space");
    expect(state.lines.at(-1)).toBe("Your space is ready.");
    expect(confirmed.has("applications")).toBe(true);
  });

  test("a space that never gets hosted ends as SPACE_SETUP_PENDING inside the given bound", async () => {
    const { state, deps } = harness(unhosted);

    const failure = await recheckSpaceHosting(ctx, "applications", [kvList], { ...deps, confirmed: new Set(), timeoutMs: 20_000 })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: "SPACE_SETUP_PENDING", exitCode: ExitCode.ERROR });
    expect(state.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
  });

  test("without --timeout the wait is bounded at 150 s", async () => {
    const { state, deps } = harness(unhosted);

    const failure = await recheckSpaceHosting(ctx, "applications", [kvList], { ...deps, confirmed: new Set() })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: "SPACE_SETUP_PENDING" });
    expect(state.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(150_000);
  });

  test("a session that cannot read the space, a failing node or no kv grant never waits, warns or blocks", async () => {
    for (const [answer, permissions] of [[denied, [kvList]], [down, [kvList]], [hosted, [capabilities]]] as const) {
      const { state, deps } = harness(answer);
      const confirmed = new Set<string>();

      await recheckSpaceHosting(ctx, "account", permissions, { ...deps, confirmed });

      expect(state.sleeps).toEqual([]);
      expect(state.lines).toEqual([]);
      expect(confirmed.has("account")).toBe(false);
    }
  });

  test("a session that cannot be restored is not blocked", async () => {
    const { state, deps } = harness(unhosted);

    await recheckSpaceHosting(ctx, "applications", [kvList], {
      ...deps, confirmed: new Set(), restore: async () => ({ unavailable: "session_expired" }) as never,
    });

    expect(state.reads).toBe(0);
    expect(state.sleeps).toEqual([]);
  });
});
