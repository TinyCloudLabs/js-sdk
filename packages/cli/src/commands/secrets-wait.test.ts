import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childPids,
  makeHome,
  processAlive,
  removeHome,
  runTc,
  secretsSpaceId,
  snapshotHome,
  startWaitHermetic,
  writeDelegateProfile,
  writeLocalOwnerProfile,
  writeOwnerOpenKeyProfile,
  writeStoredGrants,
  type TcRun,
  type WaitHermetic,
} from "../test-support/secrets-wait-harness.js";

// S3-T7 / S3-T3b: end to end through bin/tc. The parent really spawns
// `secrets probe` children against the loopback node. Needs a fresh
// `bun run --cwd packages/cli build`.

const CANARY = "HERMETIC_DELEGATION_CANARY";
const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const OTHER_OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OTHER_KEY = "3".padStart(64, "0");
const ERROR_KEYS = ["code", "message", "hint", "recovery", "setup", "meta", "warnings"];
const DELEGATE_LOGIN = "tc --profile agent auth login --method openkey --paste --manifest <manifest.json>";

let hermetic: WaitHermetic | undefined;
let home: string | undefined;

afterEach(async () => {
  hermetic?.stop();
  hermetic = undefined;
  if (home !== undefined) await removeHome(home);
  home = undefined;
});

async function setup(options: { secretPresent?: boolean } = {}): Promise<{ hermetic: WaitHermetic; home: string }> {
  hermetic = await startWaitHermetic(options);
  home = await makeHome();
  return { hermetic, home };
}

/** A did:key delegate-session profile `agent` holding the fixture's bound grant. */
async function delegateHome(options: { secretPresent?: boolean } = {}): Promise<{ hermetic: WaitHermetic; home: string }> {
  const current = await setup(options);
  await writeDelegateProfile(current.home, current.hermetic, "agent", { grant: await current.hermetic.mintDelegation() });
  return current;
}

/**
 * `tc --profile P secrets wait ARGS --json`; every `wait` run must leave
 * TC_HOME byte-for-byte unchanged (no consent saved, no profile state).
 */
async function wait(
  current: { home: string },
  profile: string,
  args: readonly string[],
  options: Parameters<typeof runTc>[2] = {},
): Promise<TcRun> {
  const before = await snapshotHome(current.home);
  const run = await runTc(current.home, ["--profile", profile, "--json", "secrets", "wait", ...args], options);
  expect(await snapshotHome(current.home)).toEqual(before);
  return run;
}

function expectErrorKeys(run: TcRun): Record<string, unknown> {
  const error = run.error;
  expect(error).toBeDefined();
  for (const key of Object.keys(error!)) expect([...ERROR_KEYS, "progress"]).toContain(key);
  return error!;
}

/** Polls `/proc` for the parent's probe child while the parent runs (Linux). */
function watchChildren(seen: Set<number>, cmdlines: string[]): (pid: number) => Promise<void> {
  return async (parent) => {
    // Real-time polling: the child exists only while the real parent runs it.
    while (processAlive(parent)) {
      for (const pid of await childPids(parent)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        if (cmdline !== "") cmdlines.push(cmdline.replaceAll("\0", " "));
      }
      await Bun.sleep(5);
    }
  };
}

describe("S3-T3b consent denial: the final CLI envelope", () => {
  for (const scope of [undefined, "food-drinks"] as const) {
    test(scope === undefined ? "unscoped" : `--scope ${scope}`, async () => {
      const current = await delegateHome();
      expect(current.hermetic.ownerDid).toBe(OWNER);
      // A is granted and absent (pending); the node refuses B.
      current.hermetic.provisionKvSpace(secretsSpaceId(current.hermetic));
      const prefix = scope === undefined ? "vault/secrets" : `vault/secrets/scoped/${scope}`;
      current.hermetic.denyKvReads([`${prefix}/B`]);

      const run = await wait(current, "agent", ["A", "B", "--timeout", "0", ...(scope === undefined ? [] : ["--scope", scope])]);

      expect(run.exitCode).toBe(5);
      expect(run.stdout).toBe("");
      const error = expectErrorKeys(run);
      expect(error.code).toBe("PERMISSION_DENIED");
      expect(error.recovery).toEqual({
        action: "request_access",
        names: ["B"],
        owner: OWNER,
        ...(scope === undefined ? {} : { scope }),
      });
      expect(Object.keys(error)).not.toContain("deniedNames");
      expect(Object.keys(error)).not.toContain("progress");
      expect(error.setup).toEqual({
        url: expect.stringMatching(/^https:\/\/secrets\.tinycloud\.xyz\/request\?owner=/),
        names: ["A"],
        ...(scope === undefined ? {} : { scope }),
        owner: OWNER,
        action: "add_secret",
      });
      expect(current.hermetic.decryptRequests()).toBe(0);
    }, 30_000);
  }
});

describe("S3-T7 basic results", () => {
  test("pending → 8, then the secret appears → 0, an ungranted name → 5; never a decrypt", async () => {
    const current = await delegateHome({ secretPresent: false });

    const pending = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect(pending.exitCode).toBe(8);
    expect(pending.json).toEqual({
      status: "pending",
      pending: [CANARY],
      present: [],
      url: expect.stringMatching(/^https:\/\/secrets\.tinycloud\.xyz\/request\?owner=.*&name=HERMETIC_DELEGATION_CANARY/),
    });

    current.hermetic.setSecretPresent(true);
    const ready = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect(ready.exitCode).toBe(0);
    expect(ready.json).toEqual({ status: "ready", names: [CANARY] });

    const denied = await wait(current, "agent", [CANARY, "UNGRANTED", "--timeout", "0"]);
    expect(denied.exitCode).toBe(5);
    expect(expectErrorKeys(denied)).toMatchObject({
      code: "PERMISSION_DENIED",
      recovery: { action: "request_access", names: ["UNGRANTED"], owner: OWNER },
    });

    expect(current.hermetic.decryptRequests()).toBe(0);
    // Only kv/get invocations on the secrets space.
    for (const invocation of current.hermetic.invocations()) {
      expect(invocation.action).toBe("tinycloud.kv/get");
      expect(invocation.space.endsWith(":secrets")).toBe(true);
    }
  }, 60_000);
});

describe("S3-T7 stored-grant activation (owner-openkey profile + stored grant)", () => {
  const cases: Array<[number | null, number]> = [[503, 6], [401, 3], [403, 5], [null, 0]];
  for (const [status, exitCode] of cases) {
    test(`failDelegate(${status}) → ${exitCode}`, async () => {
      const current = await setup();
      const audience = current.hermetic.ownerRestorableSession.verificationMethod.split("#", 1)[0]!;
      await writeOwnerOpenKeyProfile(current.home, current.hermetic, "owner", {
        grant: await current.hermetic.mintDelegationForAudience(audience),
      });
      current.hermetic.failDelegate(status);
      const run = await wait(current, "owner", [CANARY, "--timeout", "0"]);
      expect(run.exitCode).toBe(exitCode);
      if (exitCode === 0) expect(run.json).toEqual({ status: "ready", names: [CANARY] });
      if (exitCode === 3) expect(expectErrorKeys(run)).toMatchObject({
        code: "AUTH_REQUIRED",
        recovery: { action: "sign_in", command: "tc --profile owner auth login --method openkey" },
      });
      if (exitCode === 5) expect(expectErrorKeys(run)).toMatchObject({
        code: "PERMISSION_DENIED",
        recovery: { action: "request_access", names: [CANARY], owner: OWNER },
      });
      if (exitCode === 6) {
        expect(expectErrorKeys(run).code).toBe("NETWORK_ERROR");
        expect(run.error!.progress).toBeUndefined();
      }
      if (status !== null) {
        expect(current.hermetic.requests().some((request) => request.path === "/delegate")).toBe(true);
      }
    }, 30_000);
  }
});

describe("S3-T7 bounded and interruptible", () => {
  test("a stalled 404 body → 6 within 21 s + 5 s", async () => {
    const current = await delegateHome();
    current.hermetic.stallInvocations((invocation) => invocation.action === "tinycloud.kv/get");
    const run = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect(run.exitCode).toBe(6);
    expect(expectErrorKeys(run).code).toBe("NETWORK_ERROR");
    expect(run.durationMs).toBeLessThan(26_000);
  }, 40_000);

  test("SIGINT during an attempt → 130 CANCELLED; the child is gone; no further invocations", async () => {
    const current = await delegateHome();
    current.hermetic.stallInvocations((invocation) => invocation.action === "tinycloud.kv/get");
    const children: number[] = [];
    let invocationsAtExit = -1;
    const run = await wait(current, "agent", [CANARY, "--timeout", "60s"], {
      onSpawn: async (parent) => {
        // Real-time polling: wait until the real child's probe reaches the node.
        while (current.hermetic.invocations().length === 0) await Bun.sleep(10);
        children.push(...await childPids(parent));
        process.kill(parent, "SIGINT");
      },
    });
    invocationsAtExit = current.hermetic.invocations().length;
    expect(run.exitCode).toBe(130);
    expect(expectErrorKeys(run).code).toBe("CANCELLED");
    expect(children.length).toBeGreaterThan(0);
    for (const pid of children) expect(processAlive(pid)).toBe(false);
    // Real time on purpose: nothing may reach the node after the parent exited.
    await Bun.sleep(3_500);
    expect(current.hermetic.invocations().length).toBe(invocationsAtExit);
  }, 40_000);
});

describe("S3-T7 R4-2 identity: the child resolves the owner from its live identity", () => {
  test("delegate profile + TC_PRIVATE_KEY → 3 explicit_key (with or without --owner), zero requests, key never in argv", async () => {
    const current = await delegateHome();
    for (const owner of [[], ["--owner", OTHER_OWNER], ["--owner", OWNER]]) {
      const requestsBefore = current.hermetic.requests().length;
      const seen = new Set<number>();
      const cmdlines: string[] = [];
      const run = await wait(current, "agent", [CANARY, "--timeout", "0", ...owner], {
        env: { TC_PRIVATE_KEY: OTHER_KEY },
        ...(process.platform === "linux" ? { onSpawn: watchChildren(seen, cmdlines) } : {}),
      });
      expect(run.exitCode).toBe(3);
      expect(expectErrorKeys(run)).toMatchObject({
        code: "AUTH_REQUIRED",
        hint: expect.stringContaining("never signs in"),
      });
      expect(current.hermetic.requests().length).toBe(requestsBefore);
      if (process.platform === "linux") {
        expect(cmdlines.some((cmdline) => cmdline.includes("secrets probe"))).toBe(true);
        for (const cmdline of cmdlines) expect(cmdline).not.toContain(OTHER_KEY);
      }
    }
  }, 60_000);

  test("did:key delegate-session profile: owner from its space; --owner equal works; a different --owner → 2 OWNER_MISMATCH", async () => {
    const current = await delegateHome();
    expect([0, 8]).toContain((await wait(current, "agent", [CANARY, "--timeout", "0"])).exitCode);
    expect([0, 8]).toContain((await wait(current, "agent", [CANARY, "--timeout", "0", "--owner", OWNER])).exitCode);
    const mismatch = await wait(current, "agent", [CANARY, "--timeout", "0", "--owner", OTHER_OWNER]);
    expect(mismatch.exitCode).toBe(2);
    expect(expectErrorKeys(mismatch).code).toBe("OWNER_MISMATCH");
  }, 60_000);

  test("did:key key-only profile without a session or recorded owner → 3 with the sign-in recovery, zero requests", async () => {
    const current = await setup();
    await writeDelegateProfile(current.home, current.hermetic, "agent", { session: false, space: false });
    const requestsBefore = current.hermetic.requests().length;
    const run = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect(run.exitCode).toBe(3);
    expect(expectErrorKeys(run)).toMatchObject({ code: "AUTH_REQUIRED", recovery: { action: "sign_in", command: DELEGATE_LOGIN } });
    expect(current.hermetic.requests().length).toBe(requestsBefore);
  }, 30_000);
});

describe("S3-T7 R5-2 sign-in recovery names the persistent login per posture", () => {
  test("local, owner-openkey and delegate profiles without a session; zero requests", async () => {
    const current = await setup();
    await writeLocalOwnerProfile(current.home, current.hermetic, "local");
    await writeOwnerOpenKeyProfile(current.home, current.hermetic, "openkey", { session: false });
    await writeDelegateProfile(current.home, current.hermetic, "agent", { session: false });
    const cases = [
      ["local", "tc --profile local auth login --method local"],
      ["openkey", "tc --profile openkey auth login --method openkey"],
      ["agent", DELEGATE_LOGIN],
    ] as const;
    const requestsBefore = current.hermetic.requests().length;
    for (const [profile, command] of cases) {
      const run = await wait(current, profile, [CANARY, "--timeout", "0"]);
      expect(run.exitCode).toBe(3);
      expect(expectErrorKeys(run)).toMatchObject({
        code: "AUTH_REQUIRED",
        hint: `Sign in once with: ${command}, then retry.`,
        recovery: { action: "sign_in", command },
      });
    }
    expect(current.hermetic.requests().length).toBe(requestsBefore);
  }, 60_000);

  test("running the printed local login once makes wait proceed (the login is persistent)", async () => {
    const current = await setup();
    await current.hermetic.mintDelegation(); // configures the canary secret on the loopback node
    await writeLocalOwnerProfile(current.home, current.hermetic, "local");
    const first = await wait(current, "local", [CANARY, "--timeout", "0"]);
    expect(first.exitCode).toBe(3);
    const command = (first.error!.recovery as { command: string }).command;
    expect(command).toBe("tc --profile local auth login --method local");

    // The hint step itself writes the session (excluded from the snapshot rule).
    const login = await runTc(current.home, [...command.split(" ").slice(1), "--json"]);
    expect(login.exitCode).toBe(0);

    const after = await wait(current, "local", [CANARY, "--timeout", "0"]);
    expect([0, 8]).toContain(after.exitCode);
  }, 60_000);
});

describe("S3-T7 R4-3 migration", () => {
  test("unbound compact record → 1 PROFILE_MIGRATION_REQUIRED, TC_HOME unchanged; the printed command migrates; then wait proceeds", async () => {
    const current = await setup();
    await writeDelegateProfile(current.home, current.hermetic, "agent");
    await writeStoredGrants(current.home, "agent", [{ delegation: await current.hermetic.mintDelegation(), permissions: [] }]);
    const marker = join(current.home, ".tinycloud", "profiles", "agent", "delegation-binding-migration.json");

    const requestsBefore = current.hermetic.requests().length;
    const blocked = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect(blocked.exitCode).toBe(1);
    expect(expectErrorKeys(blocked)).toMatchObject({
      code: "PROFILE_MIGRATION_REQUIRED",
      recovery: { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" },
    });
    expect(current.hermetic.requests().length).toBe(requestsBefore);
    expect(existsSync(marker)).toBe(false);

    // Run exactly the command wait printed.
    const command = (blocked.error!.recovery as { command: string }).command;
    const caps = await runTc(current.home, [...command.split(" ").slice(1), "--json"]);
    expect(caps.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);

    const after = await wait(current, "agent", [CANARY, "--timeout", "0"]);
    expect([0, 8]).toContain(after.exitCode);
  }, 60_000);
});
