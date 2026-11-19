import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endToEndNodeHost } from "@tinycloud/sdk-core";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-default-host-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { assertNodeSupportsNamedKeys } = await import("../lib/named-keys.js");

const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// TC-2923: the CLI's default host is node.tinycloud.xyz, but key release
// (encryption-network calls) stays on the TEE-terminated origin.
test("with no --host or TC_HOST the CLI uses node.tinycloud.xyz, and its key-release calls still go only to tee.node.tinycloud.xyz", async () => {
  const previousHost = process.env.TC_HOST;
  delete process.env.TC_HOST;
  try {
    const ctx = await ProfileManager.resolveContext({ profile: "fresh" });
    expect(ctx.host).toBe(PROXIED);
    expect(endToEndNodeHost(ctx.host)).toBe(TEE);

    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      return Response.json({ features: ["encryption-named-keys-v1"] });
    }) as unknown as typeof fetch;
    await assertNodeSupportsNamedKeys(ctx.host, fetchImpl);
    expect(seen).toEqual([{ url: `${TEE}/info`, redirect: "error" }]);
  } finally {
    if (previousHost === undefined) delete process.env.TC_HOST;
    else process.env.TC_HOST = previousHost;
  }
});
