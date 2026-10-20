import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import {
  awaitSpaceSetup,
  kvSpaceProbe,
  spaceSetupReport,
  type SpaceProbeResult,
  type SpaceSetupReport,
} from "./space-setup.js";

const pending: SpaceSetupReport = { ready: null, pending: true };

/** A fake clock: sleeping advances it, so a 150 s wait costs nothing. */
function clock() {
  const state = { time: 1_000_000, sleeps: [] as number[], lines: [] as string[] };
  return {
    state,
    deps: {
      now: () => state.time,
      sleep: async (ms: number) => { state.sleeps.push(ms); state.time += ms; },
      write: (line: string) => { state.lines.push(line); },
    },
  };
}

function probeReturning(...results: SpaceProbeResult[]) {
  const state = { calls: 0 };
  return { state, probe: async () => results[Math.min(state.calls++, results.length - 1)]! };
}

describe("spaceSetupReport", () => {
  test("nothing to act on when OpenKey says ready or says nothing", () => {
    expect(spaceSetupReport({})).toBeUndefined();
    expect(spaceSetupReport({ hostActivated: true })).toBeUndefined();
    expect(spaceSetupReport({ spaceReady: true })).toBeUndefined();
  });

  test("reads pending, not-ready and error from the relayed delegation", () => {
    expect(spaceSetupReport({ spaceReady: null, spacePending: true })).toEqual({ ready: null, pending: true });
    expect(spaceSetupReport({ spaceReady: false })).toEqual({ ready: false, pending: false });
    expect(spaceSetupReport({ spaceReady: false, spaceError: "setup failed (tinycloud_bootstrap_failed): boom." }))
      .toEqual({ ready: false, pending: false, error: "setup failed (tinycloud_bootstrap_failed): boom." });
  });

  test("OpenKey's text cannot carry terminal control sequences", () => {
    expect(spaceSetupReport({ spaceReady: false, spaceError: "bad\u001b[31m\u0007 text" })?.error).toBe("bad [31m text");
  });
});

describe("awaitSpaceSetup", () => {
  test("polls with backoff until OpenKey has hosted the space", async () => {
    const { state, deps } = clock();
    const { state: probed, probe } = probeReturning("unhosted", "unhosted", "unhosted", "hosted");

    await awaitSpaceSetup(pending, { ...deps, probe });

    expect(probed.calls).toBe(4);
    expect(state.sleeps).toEqual([2_000, 3_000, 5_000]);
    expect(state.lines[0]).toContain("Setting up your space");
    expect(state.lines.at(-1)).toBe("Your space is ready.");
  });

  test("a space that is already hosted ends the wait without any progress line", async () => {
    const { state, deps } = clock();

    await awaitSpaceSetup(pending, { ...deps, probe: probeReturning("hosted").probe });

    expect(state.sleeps).toEqual([]);
    expect(state.lines).toEqual([]);
  });

  test("times out after 150 s with a clear, non-zero error and the retry advice", async () => {
    const { state, deps } = clock();
    const { state: probed, probe } = probeReturning("unhosted");
    const started = state.time;

    const failure = await awaitSpaceSetup(pending, { ...deps, probe }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SPACE_SETUP_PENDING",
      exitCode: ExitCode.ERROR,
      message: expect.stringContaining("150 seconds"),
      metadata: { hint: expect.stringContaining("approving again in OpenKey re-runs the setup") },
    });
    expect(state.time - started).toBe(150_000);
    // Backoff, not a tight loop; the schedule settles at 15 s.
    expect(state.sleeps.slice(0, 6)).toEqual([2_000, 3_000, 5_000, 8_000, 13_000, 15_000]);
    expect(Math.max(...state.sleeps)).toBe(15_000);
    expect(probed.calls).toBeLessThan(20);
    // Progress is rate limited, not one line per probe.
    const progress = state.lines.filter((line) => line.startsWith("Still setting up"));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(probed.calls - 1);
  });

  test("surfaces spaceError verbatim, with its code, and fails without waiting", async () => {
    const { state, deps } = clock();
    const error = "TinyCloud account setup failed (tinycloud_bootstrap_failed): seed failed.";

    const failure = await awaitSpaceSetup({ ready: false, pending: false, error }, { ...deps, probe: probeReturning("unhosted").probe })
      .then(() => undefined, (caught: unknown) => caught);

    expect(failure).toMatchObject({
      code: "SPACE_SETUP_FAILED",
      exitCode: ExitCode.ERROR,
      message: expect.stringContaining(error),
    });
    expect(state.sleeps).toEqual([]);
  });

  test("spaceError while the space is in fact hosted is a warning, not a failure", async () => {
    const { state, deps } = clock();
    const error = "TinyCloud account setup failed (tinycloud_bootstrap_failed): seed failed.";

    await awaitSpaceSetup({ ready: false, pending: false, error }, { ...deps, probe: probeReturning("hosted").probe });

    expect(state.lines).toEqual([expect.stringContaining(error)]);
  });

  test("spaceReady false alone is reported at once: OpenKey is not going to host it", async () => {
    const { state, deps } = clock();

    await awaitSpaceSetup({ ready: false, pending: false }, { ...deps, probe: probeReturning("unhosted").probe });

    expect(state.sleeps).toEqual([]);
    expect(state.lines).toEqual([expect.stringContaining("did not set up your TinyCloud space")]);
  });

  test("a session that cannot read the space is warned about, never waited on", async () => {
    const { state, deps } = clock();

    await awaitSpaceSetup(pending, { ...deps, probe: probeReturning("unknown").probe });

    expect(state.sleeps).toEqual([]);
    expect(state.lines).toEqual([expect.stringContaining("could not check")]);
  });

  test("a probe that throws counts as unknown", async () => {
    const { state, deps } = clock();

    await awaitSpaceSetup(pending, { ...deps, probe: async () => { throw new Error("socket closed"); } });

    expect(state.sleeps).toEqual([]);
    expect(state.lines).toHaveLength(1);
  });
});

describe("kvSpaceProbe", () => {
  const space = "tinycloud:pkh:eip155:1:0xabc:default";
  const kvList: PermissionEntry = { service: "tinycloud.kv", space, path: "xyz.tinycloud.agent-data/", actions: ["tinycloud.kv/list", "tinycloud.kv/get"] };
  const kvGetOnly: PermissionEntry = { service: "tinycloud.kv", space, path: "notes/", actions: ["tinycloud.kv/get"] };
  const capabilities: PermissionEntry = { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] };
  const ctx = { profile: "p", host: "https://node.test" };

  function fakeNode(result: unknown) {
    const calls: Array<[string, unknown]> = [];
    const kv = {
      list: async (options: unknown) => { calls.push(["list", options]); return result; },
      get: async (key: string) => { calls.push(["get", key]); return result; },
    };
    return { calls, restore: async () => ({ node: { kv } }) as never };
  }
  const unhostedError = { ok: false, error: { code: "KV_NOT_FOUND", message: "404 - Space not found", meta: { status: 404 } } };

  test("lists under a granted prefix, and reads the space as unhosted only on the Space not found 404", async () => {
    const node = fakeNode(unhostedError);

    expect(await kvSpaceProbe(ctx, [capabilities, kvList], node.restore)()).toBe("unhosted");
    expect(node.calls).toEqual([["list", { prefix: "xyz.tinycloud.agent-data/", limit: 1 }]]);
  });

  test("without kv/list it gets a key under the granted prefix; a missing key means the space exists", async () => {
    const node = fakeNode({ ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found: notes/.tinycloud-space-probe", meta: { status: 404 } } });

    expect(await kvSpaceProbe(ctx, [kvGetOnly], node.restore)()).toBe("hosted");
    expect(node.calls).toEqual([["get", "notes/.tinycloud-space-probe"]]);
  });

  test("a successful read is hosted", async () => {
    expect(await kvSpaceProbe(ctx, [kvList], fakeNode({ ok: true, data: {} }).restore)()).toBe("hosted");
  });

  test("a refusal or network failure is unknown, not a verdict on the space", async () => {
    const denied = { ok: false, error: { code: "PERMISSION_DENIED", message: "403 - forbidden", meta: { status: 403 } } };
    expect(await kvSpaceProbe(ctx, [kvList], fakeNode(denied).restore)()).toBe("unknown");
  });

  test("no kv grant, or no restorable session, is unknown and reads nothing", async () => {
    const node = fakeNode({ ok: true, data: {} });
    expect(await kvSpaceProbe(ctx, [capabilities], node.restore)()).toBe("unknown");
    expect(node.calls).toEqual([]);
    expect(await kvSpaceProbe(ctx, [kvList], async () => ({ unavailable: "session_missing" }) as never)()).toBe("unknown");
  });
});
