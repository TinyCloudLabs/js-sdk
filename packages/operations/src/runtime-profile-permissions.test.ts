import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInvocationRuntime } from "./runtime.js";
import { profilePath } from "./state.js";

const NAME = "loose";
const FILES = ["profile.json", "key.json", "session.json"];

let home: string;
let outsideFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tinycloud-runtime-permissions-"));
  process.env.TC_HOME = home;
  const dir = profilePath(NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), JSON.stringify({
    name: NAME,
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:loose",
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  await writeFile(join(dir, "key.json"), JSON.stringify({ kty: "OKP", crv: "Ed25519" }));
  await writeFile(join(dir, "session.json"), JSON.stringify({}));
  outsideFile = join(home, "outside.json");
  await writeFile(outsideFile, "{}");
  await symlink(outsideFile, join(dir, "external.json"));
  // Fixture state is set explicitly so the process umask cannot change it.
  await chmod(dir, 0o755);
  for (const file of FILES) await chmod(join(dir, file), 0o644);
  await chmod(outsideFile, 0o644);
});

afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

// The runtime reads key.json and session.json itself after resolving the profile; the profile must be
// tightened before any of those reads, whichever runtime requirement is asked for.
describe("createInvocationRuntime tightens a loose profile directory and its files", () => {
  for (const requirement of ["authenticated", "restored", "inspection"] as const) {
    test(`${requirement}: directory 0700, files 0600, a planted link's target untouched`, async () => {
      await createInvocationRuntime({ profile: NAME }, requirement);

      const dir = profilePath(NAME);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const file of FILES) expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
      expect((await stat(outsideFile)).mode & 0o777).toBe(0o644);
    });
  }
});
