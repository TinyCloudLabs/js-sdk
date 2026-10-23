import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { profileConfigPath, profilePath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import type { ProfileConfig } from "../config/types.js";

// The profile store reads TC_HOME when it loads, so the command modules are imported after it is set
// (a static import would bind the real profile directory).
const originalTcHome = process.env.TC_HOME;
const stateHome = await mkdtemp(join(tmpdir(), "tc1856-state-"));
process.env.TC_HOME = stateHome;
const { startAuthFlow } = await import("../auth/browser-auth.js");
const { acquireOpenKeyApproval, ensureDelegationAuthority, refreshOpenKeySession } = await import("./auth.js");

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
afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(stateHome, { recursive: true, force: true });
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

/** What the CLI prints once an approval flow has started. */
const APPROVAL_STARTED = /\/delegate|Open this URL|Opening browser/;

/**
 * Runs the CLI against a stand-in node/OpenKey server that records every
 * request. A request or a printed approval URL kills the CLI and fails the
 * test immediately, so a missing refusal never waits on an approval.
 */
async function runCli(args: string[], files: Record<string, string> = {}): Promise<CliResult> {
  const home = await mkdtemp(join(tmpdir(), "tc1856-"));
  homes.push(home);
  for (const [name, content] of Object.entries(files)) await writeFile(join(home, name), content);
  const requests: string[] = [];
  const violation = Promise.withResolvers<never>();
  let kill = () => {};
  const abort = (reason: string) => {
    kill();
    violation.reject(new Error(`Refusal missing: ${reason}`));
  };
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = `${request.method} ${new URL(request.url).pathname}`;
    requests.push(path);
    abort(`the CLI contacted ${path}`);
    return new Response("unexpected request", { status: 500 });
  } });
  servers.push(server);
  await withTinyCloudStateRoot(home, () => writeJsonAtomic(profileConfigPath(PROFILE), {
    name: PROFILE, host: server.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
    ownerDid: OWNER_DID, posture: "owner-openkey", authMethod: "openkey",
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args.map((arg) => arg.replace("$HOME", home))], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: server.url.origin, TC_OPENKEY_API_HOST: server.url.origin },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  kill = () => child.kill("SIGKILL");
  const collect = async (stream: ReadableStream<Uint8Array>, watch: boolean): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (watch && APPROVAL_STARTED.test(text)) abort("an approval URL was printed");
    }
    return text;
  };
  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([collect(child.stdout, true), collect(child.stderr, true), child.exited]),
    violation.promise,
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

test("login refuses a manifest whose caveats are several empty objects", async () => {
  const manifest = manifestSource({ app_id: "tc1856-app", space: "default", permissions: [kvEntry([{}, {}])] });
  expectRefused(await runCli(["auth", "login", "--method", "openkey", "--manifest", manifest, "--no-popup", "--owner", OWNER_DID]));
});

test("auth grant on an OpenKey owner profile refuses a limited request before printing a scope, prompting or any request", async () => {
  const artifact = JSON.stringify({
    kind: "tinycloud.auth.request", version: 1, requestId: "tc1856-request",
    sessionDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
    requested: [{ service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }] }],
  });
  const result = await runCli(["auth", "grant", "$HOME/request.json"], { "request.json": artifact });
  expectRefused(result);
  expect(result.output).not.toContain("notes");
});

test("a session refresh rebuilt from stored caveated authority is refused before any request", async () => {
  // With replication prefixes saved and no explicit permissions, the refresh request is rebuilt from
  // the stored session's permissions; caveated get authority on the prefix is refused.
  await withTinyCloudStateRoot(stateHome, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "http://127.0.0.1:1", chainId: 1, spaceName: "default", did: "did:key:prior",
      ownerDid: OWNER_DID, posture: "owner-openkey", authMethod: "openkey",
      createdAt: "2026-10-01T00:00:00.000Z", replication: { prefixes: ["notes/"] },
    });
    await writeJsonAtomic(join(profilePath(PROFILE), "session.json"), {
      permissions: [{ service: "tinycloud.kv", space: SPACE, path: "notes/", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }] }],
    });
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Refusal missing: fetch was called");
  });
  try {
    await expect(refreshOpenKeySession(PROFILE, "http://127.0.0.1:1", { noPopup: true }))
      .rejects.toMatchObject({ code: "REPLICATION_PREFIX_CAVEATED", exitCode: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

const limited: PermissionEntry = {
  service: "tinycloud.kv", space: SPACE, path: "notes", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }],
};
const profile = { name: PROFILE, host: "http://127.0.0.1:1", chainId: 1, spaceName: "default", did: "did:key:prior", authMethod: "openkey" } as unknown as ProfileConfig;

test("the secrets escalation and agent approval refuse a limited permission before any approval or fetch", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Refusal missing: fetch was called");
  });
  const acquisitions: unknown[] = [];
  const openKeyAcquisition = async (...args: unknown[]): Promise<never> => {
    acquisitions.push(args);
    throw new Error("Refusal missing: the approval was requested");
  };
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
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Refusal missing: fetch was called");
  });
  // Printing the approval URL is the first output of either flow. The callback flow prints from
  // inside a server callback, so a missing refusal is surfaced through a rejected promise.
  const violation = Promise.withResolvers<never>();
  const stderrSpy = spyOn(console, "error").mockImplementation(() => {
    violation.reject(new Error("Refusal missing: the approval flow printed output"));
  });
  try {
    for (const paste of [false, true]) {
      await expect(Promise.race([startAuthFlow("did:key:prior", { permissions: [limited], paste, noPopup: true }), violation.promise]))
        .rejects.toMatchObject({ code: "CAVEATS_UNSUPPORTED", exitCode: 2 });
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    stderrSpy.mockRestore();
  }
});
