import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detachedChildArgv,
  detachedLoginPath,
  parseWaitSeconds,
  sessionFingerprint,
  waitForLogin,
  type DetachedLoginRecord,
} from "./detached-login.js";

const originalHome = process.env.TC_HOME;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "tc-detached-unit-"));
  process.env.TC_HOME = home;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const now = Date.now();
function record(overrides: Partial<DetachedLoginRecord> = {}): DetachedLoginRecord {
  return {
    v: 1, profile: "p", pid: process.pid, state: "waiting", fingerprint: "f",
    startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    sessionBefore: null, approvalUrl: "https://openkey.test/delegate?x", ...overrides,
  };
}

async function save(value: DetachedLoginRecord | null): Promise<void> {
  const path = detachedLoginPath("p");
  await mkdir(join(home, ".tinycloud", "logins"), { recursive: true });
  if (value === null) await rm(path, { force: true });
  else await writeFile(path, JSON.stringify(value));
}

const wait = (session: Record<string, unknown> | null, usable: boolean, waitMs = 0) =>
  waitForLogin({ profile: "p", waitMs, readSession: async () => ({ session, usable }), sleep: async () => {} });

describe("waitForLogin", () => {
  test("no login pending: a usable session is signed in, none is `none`", async () => {
    await save(null);
    expect((await wait({ delegationCid: "a" }, true)).outcome).toBe("authenticated");
    expect((await wait(null, false)).outcome).toBe("none");
  });

  test("a re-login keeps waiting while the session is still the one it started with", async () => {
    await save(record({ sessionBefore: "old" }));
    expect((await wait({ delegationCid: "old" }, true)).outcome).toBe("waiting");
    expect((await wait({ delegationCid: "new" }, true)).outcome).toBe("authenticated");
  });

  test("a session that arrived another way (the paste fallback) wins over the listener's failure", async () => {
    await save(record({ state: "failed", error: { code: "AUTH_TIMEOUT", message: "late", exitCode: 3 } }));
    expect((await wait({ delegationCid: "pasted" }, true)).outcome).toBe("authenticated");
    const failed = await wait(null, false);
    expect(failed).toMatchObject({ outcome: "failed", error: { code: "AUTH_TIMEOUT" } });
  });

  test("a listener past its deadline, or gone, is a failure", async () => {
    await save(record({ expiresAt: new Date(now - 60_000).toISOString() }));
    expect(await wait(null, false)).toMatchObject({ outcome: "failed", error: { code: "AUTH_TIMEOUT" } });
    await save(record({ pid: 2 ** 30 }));
    expect(await wait(null, false)).toMatchObject({ outcome: "failed", error: { code: "LOGIN_LISTENER_EXITED" } });
  });

  test("an earlier login that finished, with its session gone since, is `none`", async () => {
    await save(record({ state: "authenticated" }));
    expect((await wait(null, false)).outcome).toBe("none");
  });
});

describe("helpers", () => {
  test("the child repeats the command without --detach, quietly", () => {
    expect(detachedChildArgv(["--profile", "x", "auth", "login", "--detach", "--manifest", "m.json"]))
      .toEqual(["--quiet", "--profile", "x", "auth", "login", "--manifest", "m.json", "--detached-child"]);
  });

  test("--wait takes whole seconds up to 600", () => {
    expect(parseWaitSeconds("0")).toBe(0);
    expect(parseWaitSeconds("600")).toBe(600);
    for (const bad of ["601", "-1", "1.5", "soon", ""]) expect(() => parseWaitSeconds(bad)).toThrow("--wait");
  });

  test("a session is identified by its delegation CID, never printed", () => {
    expect(sessionFingerprint({ delegationCid: "bafy", jwk: { d: "secret" } })).toBe("bafy");
    expect(sessionFingerprint({ jwk: { d: "secret" } })).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionFingerprint(null)).toBeNull();
  });
});
