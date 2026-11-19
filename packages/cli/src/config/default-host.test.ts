import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endToEndNodeHost } from "@tinycloud/sdk-core";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-default-host-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { DEFAULT_HOST } = await import("./constants.js");

const TEE = "https://tee.node.tinycloud.xyz";

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test("with no --host or TC_HOST the CLI uses tee.node.tinycloud.xyz, and end-to-end calls stay on it", async () => {
  const previousHost = process.env.TC_HOST;
  delete process.env.TC_HOST;
  try {
    const ctx = await ProfileManager.resolveContext({ profile: "fresh" });
    expect(DEFAULT_HOST).toBe(TEE);
    expect(ctx.host).toBe(TEE);
    expect(endToEndNodeHost(ctx.host)).toBe(TEE);
  } finally {
    if (previousHost === undefined) delete process.env.TC_HOST;
    else process.env.TC_HOST = previousHost;
  }
});
