import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstallLock, HOLDER_MARGIN_MS, LOCK_MAX_AGE_MS } from "./install-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-lock-"));
  dirs.push(dir);
  return dir;
}

/** A generation left behind by some other process. */
function leftover(rootDir: string, generation: number, owner: { pid: number; startedAt?: number; host?: string; token?: string }) {
  mkdirSync(join(rootDir, ".install-lock"), { recursive: true });
  writeFileSync(join(rootDir, ".install-lock", `${generation}.json`), JSON.stringify({
    host: hostname(), startedAt: Date.now(), token: "someone-else", ...owner,
  }));
}

describe("install lock", () => {
  test("one holder at a time, in this process too; released, it can be taken again", () => {
    const dir = root();
    const first = acquireInstallLock(dir);
    expect(first?.valid()).toBe(true);
    expect(acquireInstallLock(dir)).toBeNull();
    first!.release();
    expect(first!.valid()).toBe(false);
    const second = acquireInstallLock(dir);
    expect(second?.generation).toBe(first!.generation + 1);
  });

  test("a live owner holds it; a dead owner's lock is free", () => {
    const dir = root();
    leftover(dir, 3, { pid: 4242 });
    expect(acquireInstallLock(dir, { alive: (pid) => pid === 4242 })).toBeNull();
    expect(acquireInstallLock(dir, { alive: () => false })?.generation).toBe(4);
  });

  test("a lock recorded under this process's pid that this process doesn't hold is stale (a reused pid)", () => {
    const dir = root();
    leftover(dir, 1, { pid: process.pid });
    expect(acquireInstallLock(dir, { alive: () => true })?.generation).toBe(2);
  });

  test("past the age cap a live owner loses the lock, and stops counting as holder before anyone can take it", () => {
    const dir = root();
    let now = Date.now();
    const holder = acquireInstallLock(dir, { now: () => now })!;
    now += LOCK_MAX_AGE_MS - HOLDER_MARGIN_MS;
    expect(holder.valid()).toBe(false);
    expect(acquireInstallLock(dir, { now: () => now })).toBeNull();
    now += HOLDER_MARGIN_MS;
    const next = acquireInstallLock(dir, { now: () => now });
    expect(next?.generation).toBe(holder.generation + 1);
    expect(holder.valid()).toBe(false);
  });

  test("a lock from another machine sharing this home is held until the age cap", () => {
    const dir = root();
    leftover(dir, 1, { pid: 1, host: "another-host" });
    expect(acquireInstallLock(dir, { alive: () => false })).toBeNull();
    leftover(dir, 2, { pid: 1, host: "another-host", startedAt: Date.now() - LOCK_MAX_AGE_MS });
    expect(acquireInstallLock(dir)?.generation).toBe(3);
  });

  test("of many processes racing for a stale lock, exactly one wins", async () => {
    const dir = root();
    leftover(dir, 7, { pid: 2 ** 22 + 7, startedAt: Date.now() - 1000 });
    const startAt = Date.now() + 500;
    const script = `
      import { acquireInstallLock } from ${JSON.stringify(join(import.meta.dir, "install-lock.ts"))};
      while (Date.now() < ${startAt}) {}
      const lock = acquireInstallLock(${JSON.stringify(dir)}, { alive: (pid) => pid !== ${2 ** 22 + 7} });
      process.stdout.write(lock ? "won\\n" : "lost\\n");
      // The winner holds the lock until the test has every answer.
      if (lock) for await (const _ of process.stdin) {}
    `;
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] }));
    const answers = await Promise.all(children.map((child) => new Promise<string>((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.trim());
      });
    })));
    for (const child of children) child.stdin.end();
    await Promise.all(children.map((child) => new Promise((resolve) => child.on("close", resolve))));
    expect(answers.filter((answer) => answer === "won")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "lost")).toHaveLength(7);
  }, 30_000);
});
