import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

// A profile with replication prefixes signs in through a prepared hand-off that cannot carry a renewal lease, so onboarding
// must ask it for none: a lease ask there is a usage error (`--renew needs OpenKey sign-in through an approval link`).
const original = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME };
const home = mkdtempSync("/var/tmp/onboard-replica-profile-test-");
chmodSync(home, 0o700);
Object.assign(process.env, { HOME: home, TC_HOME: join(home, "tc") });
// Imported after the fixture HOME is set, so no module resolves a real profile directory.
const { ProfileManager } = await import("../config/profiles.js");
const { createKeyOnlyProfile } = await import("./init.js");
const { registerOnboardCommand } = await import("./onboard.js");

afterAll(async () => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

test("onboard on a replica profile asks for no renewal and reaches the replica sign-in", async () => {
  await createKeyOnlyProfile("replica", "http://127.0.0.1:9");
  // Onboarding's first kv space is `account`, whose `spaces/` get covers this prefix.
  await ProfileManager.setProfile("replica", { ...await ProfileManager.getProfile("replica"), replication: { prefixes: ["spaces/"] } });
  const written: string[] = [];
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("exit"), { exitCode: code }); }) as never);
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => { written.push(String(chunk)); return true; }) as never);
  const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => { written.push(String(chunk)); return true; }) as never);
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--host <url>");
    registerOnboardCommand(program);
    await program.parseAsync(["node", "tc", "--profile", "replica", "onboard"], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") exitCode = error.exitCode;
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
  }
  const text = written.join("");
  expect(text).not.toContain("--renew");
  // The replica sign-in's own refusal for a profile with no verified owner session: no approval was started.
  expect(text).toContain("Replica-enabled OpenKey login needs");
  expect(exitCode).toBe(3);
});
