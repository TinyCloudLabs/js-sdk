import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { profileConfigPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { startAuthFlow } from "../auth/browser-auth.js";
import { acquireOpenKeyApproval, ensureDelegationAuthority } from "./auth.js";
import type { ProfileConfig } from "../config/types.js";

const PROFILE = "owner";
const OWNER_DID = "did:pkh:eip155:1:0xd559CCd9be5C5dbF8068dee29A91DF2c2d4D7B49";
const SPACE = `tinycloud:pkh:eip155:1:0xd559CCd9be5C5dbF8068dee29A91DF2c2d4D7B49:default`;
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function manifestSource(manifest: Record<string, unknown>): string {
  return `base64:${Buffer.from(JSON.stringify(manifest)).toString("base64")}`;
}

const kvEntry = (caveats: unknown) => ({
  service: "tinycloud.kv",
  path: "notes",
  skipPrefix: true,
  actions: ["tinycloud.kv/get"],
  ...(caveats === undefined ? {} : { caveats }),
});

const limitedManifests = {
  "string id": manifestSource({ id: "tc1856-id", app_id: "tc1856-id", name: "Limited", space: "default", permissions: [kvEntry([{ tenant: "alpha" }])] }),
  "app_id only": manifestSource({ app_id: "tc1856-app", space: "default", permissions: [kvEntry([{ tenant: "alpha" }])] }),
};

interface CliResult {
  /** Every request the stand-in node/OpenKey server received. */
  requests: string[];
  output: string;
  exitCode: number;
}

/** A TinyCloud node and OpenKey stand-in that records every request it receives. */
async function runCli(args: string[]): Promise<CliResult> {
  const home = await mkdtemp(join(tmpdir(), "tc1856-"));
  homes.push(home);
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response("unexpected request", { status: 500 });
  } });
  servers.push(server);
  await withTinyCloudStateRoot(home, () => writeJsonAtomic(profileConfigPath(PROFILE), {
    name: PROFILE, host: server.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
    ownerDid: OWNER_DID, posture: "owner-openkey", authMethod: "openkey",
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: server.url.origin, TC_OPENKEY_API_HOST: server.url.origin },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { requests, output: `${stdout}\n${stderr}`, exitCode };
}

function expectRefused(result: CliResult) {
  expect(result.exitCode).toBe(2);
  expect(result.output).toContain("CAVEATS_UNSUPPORTED");
  expect(result.requests).toEqual([]);
  expect(result.output).not.toContain("/delegate");
}

for (const [name, manifest] of Object.entries(limitedManifests)) {
  test(`login refuses a ${name} manifest with a limited permission before any request`, async () => {
    expectRefused(await runCli(["auth", "login", "--method", "openkey", "--manifest", manifest, "--no-popup", "--owner", OWNER_DID]));
  });

  test(`replica login refuses a ${name} manifest with a limited permission before any request`, async () => {
    expectRefused(await runCli(["auth", "login", "--method", "openkey", "--manifest", manifest, "--replication-prefix", "notes/", "--no-popup", "--owner", OWNER_DID]));
  });

  test(`device login refuses a ${name} manifest with a limited permission before any request`, async () => {
    expectRefused(await runCli(["auth", "login", "--method", "openkey", "--device", "--manifest", manifest, "--owner", OWNER_DID]));
  });

  test(`auth request --grant refuses a ${name} manifest with a limited permission before any request`, async () => {
    expectRefused(await runCli(["auth", "request", "--grant", "--manifest", manifest, "--no-popup"]));
  });
}

const limited: PermissionEntry = {
  service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }],
};
const profile = { name: PROFILE, host: "http://127.0.0.1:1", chainId: 1, spaceName: "default", did: "did:key:prior", authMethod: "openkey" } as unknown as ProfileConfig;

test("the secrets escalation and agent approval refuse a limited permission before any approval or fetch", async () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  const acquisitions: unknown[] = [];
  const openKeyAcquisition = async (...args: unknown[]) => { acquisitions.push(args); throw new Error("must not be called"); };
  try {
    const node = { hasRuntimePermissions: () => false } as unknown as Parameters<typeof ensureDelegationAuthority>[0]["node"];
    const shared = {
      ctx: { profile: PROFILE, host: "http://127.0.0.1:1" }, profile, requested: [limited],
      expiryOption: "1h", reason: "test", openKeyAcquisition,
    };
    await expect(ensureDelegationAuthority({ ...shared, node, yes: true })).rejects.toMatchObject({ code: "CAVEATS_UNSUPPORTED", exitCode: 2 });
    await expect(ensureDelegationAuthority({ ...shared, node, yes: true, persist: false })).rejects.toMatchObject({ code: "CAVEATS_UNSUPPORTED" });
    await expect(acquireOpenKeyApproval(shared)).rejects.toMatchObject({ code: "CAVEATS_UNSUPPORTED", exitCode: 2 });
    expect(acquisitions).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("the browser approval flow refuses a limited permission before listening, printing a URL or fetching", async () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  const stderrSpy = spyOn(console, "error");
  try {
    for (const paste of [false, true]) {
      await expect(startAuthFlow("did:key:prior", { permissions: [limited], paste, noPopup: true }))
        .rejects.toMatchObject({ code: "CAVEATS_UNSUPPORTED", exitCode: 2 });
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    stderrSpy.mockRestore();
  }
});
