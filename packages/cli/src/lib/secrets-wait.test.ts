import { describe, expect, test } from "bun:test";
import { CLIError } from "../output/errors.js";
import type { ProbeOutcome, StatusEnvelope } from "./probe-child.js";
import {
  EXPLICIT_KEY_HINT,
  MAX_WAIT_TIMEOUT_MS,
  parseWaitTimeout,
  runSecretsWait,
  type WaitResult,
} from "./secrets-wait.js";

const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const SETUP = {
  url: `https://secrets.tinycloud.xyz/request?owner=${encodeURIComponent(OWNER)}&name=A&v=1`,
  names: ["A"],
  owner: OWNER,
  action: "add_secret",
};
const operation = { operationId: "tinycloud.secrets.status" };

function ok(output: Record<string, unknown>): ProbeOutcome {
  return { kind: "ok", envelope: { status: "ok", operation, output } as StatusEnvelope };
}
function failure(code: string, details?: Record<string, unknown>, retryable = false): ProbeOutcome {
  return {
    kind: "ok",
    envelope: { status: "error", operation, error: { code, message: `${code} message`, retryable, ...(details ? { details } : {}) } },
  };
}
const ready = ok({ status: "ready", owner: OWNER, names: ["A"], present: ["A"], pending: [], denied: [] });
const pending = ok({ status: "pending", owner: OWNER, names: ["A"], present: [], pending: ["A"], denied: [], setup: SETUP });
const unreachable = failure("NODE_UNREACHABLE", undefined, true);

/** A fake clock: each probe takes `attemptMs`; sleeps advance the clock. */
function harness(outcomes: readonly ProbeOutcome[] | ((index: number) => ProbeOutcome), options: {
  attemptMs?: number;
  onSleep?: (ms: number, controller: AbortController) => void;
  onProbe?: (index: number, controller: AbortController) => void;
} = {}) {
  let clock = 0;
  const starts: number[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      options.onSleep?.(ms, controller);
      if (!controller.signal.aborted) clock += ms;
    },
    runProbe: async (signal: AbortSignal): Promise<ProbeOutcome> => {
      const index = starts.length;
      starts.push(clock);
      options.onProbe?.(index, controller);
      clock += options.attemptMs ?? 0;
      if (signal.aborted) return { kind: "cancelled" };
      return typeof outcomes === "function" ? outcomes(index) : outcomes[Math.min(index, outcomes.length - 1)]!;
    },
    signal: controller.signal,
  };
  return { deps, starts, sleeps, now: () => clock };
}

const request = (timeoutMs: number) => ({ profile: "agent", timeoutMs, consentHint: "consent hint" });

async function rejection(promise: Promise<WaitResult>): Promise<CLIError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CLIError);
    return error as CLIError;
  }
  throw new Error("expected the wait to fail");
}

describe("schedule", () => {
  test("sleeps 3, 4.5, 6.75, 10.125 then 15 s from each attempt's end; a final attempt at the deadline; nothing after", async () => {
    const run = harness([pending], { attemptMs: 1_000 });
    const result = await runSecretsWait(request(60_000), run.deps);
    expect(run.starts).toEqual([0, 4_000, 9_500, 17_250, 28_375, 44_375, 60_000]);
    expect(run.sleeps).toEqual([3_000, 4_500, 6_750, 10_125, 15_000, 14_625]);
    expect(result).toEqual({ exitCode: 8, stdout: { status: "pending", pending: ["A"], present: [], url: SETUP.url } });
  });

  test("steady 15 s interval after the backoff", async () => {
    const run = harness([pending]);
    await runSecretsWait(request(120_000), run.deps);
    expect(run.sleeps.slice(4, 8)).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(run.starts.at(-1)).toBe(120_000);
    expect(run.starts.filter((start) => start >= 120_000)).toHaveLength(1);
  });

  test("worst case is the timeout plus one attempt budget (≤ timeout + 21 s)", async () => {
    for (const timeoutMs of [0, 2_999, 30_000, 61_000, MAX_WAIT_TIMEOUT_MS]) {
      const run = harness([pending], { attemptMs: 20_500 });
      await runSecretsWait(request(timeoutMs), run.deps);
      expect(run.now()).toBeLessThanOrEqual(timeoutMs + 21_000);
      expect(run.starts.every((start) => start <= timeoutMs)).toBe(true);
    }
  });

  test("--timeout 0 makes exactly one attempt", async () => {
    const run = harness([pending]);
    const result = await runSecretsWait(request(0), run.deps);
    expect(run.starts).toEqual([0]);
    expect(run.sleeps).toEqual([]);
    expect(result.exitCode).toBe(8);
  });

  test("ready → exit 0 with names", async () => {
    const run = harness([pending, pending, ready]);
    const result = await runSecretsWait(request(60_000), run.deps);
    expect(result).toEqual({ exitCode: 0, stdout: { status: "ready", names: ["A"] } });
    expect(run.starts).toHaveLength(3);
  });

  test("pending for a local identity prints the hint, not a url", async () => {
    const run = harness([ok({ status: "pending", owner: OWNER, names: ["A"], present: [], pending: ["A"], denied: [], hint: "put it locally" })]);
    expect((await runSecretsWait(request(0), run.deps)).stdout).toEqual({ status: "pending", pending: ["A"], present: [], hint: "put it locally" });
  });
});

describe("retryable failures", () => {
  test("5 in a row → NETWORK_ERROR (6)", async () => {
    const run = harness([{ kind: "timeout" }], { attemptMs: 20_000 });
    const error = await rejection(runSecretsWait(request(MAX_WAIT_TIMEOUT_MS), run.deps));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.exitCode).toBe(6);
    expect(run.starts).toHaveLength(5);
    expect(error.metadata?.progress).toBeUndefined();
  });

  test("a success resets the count; retryable NODE_UNREACHABLE/NODE_ERROR retry", async () => {
    const sequence = [unreachable, unreachable, failure("NODE_ERROR", undefined, true), unreachable, pending, unreachable, unreachable, ready];
    const run = harness(sequence);
    expect((await runSecretsWait(request(MAX_WAIT_TIMEOUT_MS), run.deps)).exitCode).toBe(0);
    expect(run.starts).toHaveLength(8);
  });

  test("a deadline during a failure → NETWORK_ERROR (6) with progress", async () => {
    const run = harness((index) => index === 0 ? pending : unreachable);
    const error = await rejection(runSecretsWait(request(10_000), run.deps));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.progress).toEqual({ present: [], pending: ["A"] });
  });
});

describe("terminal results map at once", () => {
  test("consent_required → PERMISSION_DENIED (5) with request_access recovery, deniedNames and setup", async () => {
    const run = harness([ok({
      status: "consent_required", owner: OWNER, names: ["A", "B"], scope: "food-drinks",
      present: [], pending: ["A"], denied: ["B"], setup: { ...SETUP, scope: "food-drinks" },
    })]);
    const error = await rejection(runSecretsWait(request(60_000), run.deps));
    expect(run.starts).toEqual([0]);
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.exitCode).toBe(5);
    expect(error.metadata).toEqual({
      hint: "consent hint",
      recovery: { action: "request_access", names: ["B"], owner: OWNER, scope: "food-drinks" },
      deniedNames: ["B"],
      setup: { ...SETUP, scope: "food-drinks" },
    });
  });

  const cases: Array<[string, ProbeOutcome, string, number, Record<string, unknown>?]> = [
    ["explicit key", failure("AUTH_REQUIRED", { reason: "explicit_key" }), "AUTH_REQUIRED", 3, { hint: EXPLICIT_KEY_HINT }],
    ["sign-in recovery", failure("AUTH_REQUIRED", { recovery: { action: "sign_in", command: "tc --profile agent auth login --method local" } }), "AUTH_REQUIRED", 3, {
      hint: "Sign in once with: tc --profile agent auth login --method local, then retry.",
      recovery: { action: "sign_in", command: "tc --profile agent auth login --method local" },
    }],
    ["no session", failure("SESSION_NOT_FOUND", { recovery: { action: "sign_in", command: "tc --profile agent auth login --method openkey" } }), "AUTH_REQUIRED", 3, {
      hint: "Sign in once with: tc --profile agent auth login --method openkey, then retry.",
      recovery: { action: "sign_in", command: "tc --profile agent auth login --method openkey" },
    }],
    ["migration", failure("PROFILE_MIGRATION_REQUIRED", {
      recovery: { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" },
    }), "PROFILE_MIGRATION_REQUIRED", 1, {
      hint: "Run tc --profile agent auth caps once to finish this profile's one-time upgrade, then retry wait.",
      recovery: { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" },
    }],
    ["owner mismatch", failure("INPUT_INVALID", { reason: "OWNER_MISMATCH" }), "OWNER_MISMATCH", 2],
    ["owner unknown", failure("INPUT_INVALID", { reason: "OWNER_DID_UNKNOWN" }), "OWNER_DID_UNKNOWN", 3],
    ["other input", failure("INPUT_INVALID"), "INPUT_INVALID", 2],
    ["probe failed", { kind: "probe_failed", childErrorCode: "PROFILE_NOT_FOUND" }, "PROBE_FAILED", 1],
    ["non-retryable node error", failure("NODE_ERROR", undefined, false), "NODE_ERROR", 1],
  ];
  for (const [name, outcome, code, exitCode, metadata] of cases) {
    test(`${name} → ${code} (${exitCode})`, async () => {
      const run = harness([outcome]);
      const error = await rejection(runSecretsWait(request(60_000), run.deps));
      expect(run.starts).toEqual([0]);
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(exitCode);
      if (metadata) expect(error.metadata).toEqual(metadata);
    });
  }
});

describe("cancellation", () => {
  test("cancel during a sleep: no further probe, CANCELLED (130) with progress", async () => {
    const run = harness([pending], { onSleep: (_, controller) => controller.abort() });
    const error = await rejection(runSecretsWait(request(60_000), run.deps));
    expect(run.starts).toEqual([0]);
    expect(error.code).toBe("CANCELLED");
    expect(error.exitCode).toBe(130);
    expect(error.metadata?.progress).toEqual({ present: [], pending: ["A"] });
  });

  test("cancel during an attempt: the attempt is stopped and nothing further starts", async () => {
    const run = harness([pending], { onProbe: (index, controller) => index === 1 && controller.abort() });
    const error = await rejection(runSecretsWait(request(60_000), run.deps));
    expect(run.starts).toHaveLength(2);
    expect(error.code).toBe("CANCELLED");
    expect(error.exitCode).toBe(130);
  });
});

describe("--timeout", () => {
  test("accepts 0, Ns and Nm up to 9m", () => {
    expect(parseWaitTimeout("0")).toBe(0);
    expect(parseWaitTimeout("90s")).toBe(90_000);
    expect(parseWaitTimeout("5m")).toBe(300_000);
    expect(parseWaitTimeout("9m")).toBe(MAX_WAIT_TIMEOUT_MS);
    expect(parseWaitTimeout("540s")).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  test("more than 9m, or another format → usage error (2)", () => {
    for (const value of ["10m", "541s", "1h", "5", "-1s", "1.5m", ""]) {
      expect(() => parseWaitTimeout(value)).toThrow(CLIError);
      try {
        parseWaitTimeout(value);
      } catch (error) {
        expect((error as CLIError).exitCode).toBe(2);
      }
    }
  });
});
