import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXTRA_VALUE = "profile-show-extra-value-8e946b";
const home = await mkdtemp(join(tmpdir(), "tc-profile-show-output-"));
const tcHome = await mkdtemp(join(tmpdir(), "tc-profile-show-state-"));
const tinycloudDir = join(tcHome, ".tinycloud");
const profileDir = join(tinycloudDir, "profiles", "default");
await mkdir(profileDir, { recursive: true });
await writeFile(join(tinycloudDir, "config.json"), JSON.stringify({ defaultProfile: "default", version: 1 }));
await writeFile(join(profileDir, "profile.json"), JSON.stringify({
  name: "default",
  host: "https://node.invalid",
  chainId: 1,
  spaceName: "default",
  did: "did:key:zabc",
  createdAt: "2026-01-01T00:00:00.000Z",
  posture: "local-owner-key",
  authMethod: "local",
  privateKey: EXTRA_VALUE,
  keyMaterial: "profile-show-other-extra-value",
}));

const repoRoot = resolve(import.meta.dir, "../../../../");
const runProfileShow = (args: string[]) => spawnSync(
  process.execPath,
  ["run", resolve(repoRoot, "packages/cli/src/index.ts"), "profile", "show", ...args],
  {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, TC_HOME: tcHome, TINYCLOUD_CLI_LOGS: "0" },
    encoding: "utf8",
    timeout: 30_000,
  },
);

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(tcHome, { recursive: true, force: true });
});

test.each([
  ["piped JSON output", []],
  ["explicit JSON output", ["--json"]],
] as const)("profile show lists only its documented fields in %s", (_mode, args) => {
  const result = runProfileShow([...args]);
  if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`);
  expect(result.stdout).not.toContain(EXTRA_VALUE);
  expect(result.stdout).not.toContain("profile-show-other-extra-value");
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(output).not.toHaveProperty("privateKey");
  expect(output).not.toHaveProperty("keyMaterial");
  expect(output).toMatchObject({ name: "default", did: "did:key:zabc" });
});
