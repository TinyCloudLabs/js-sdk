import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSecretManagerUrl, buildSecretRequestUrl } from "@tinycloud/operations/secret-request";

// S3-T4: `tc secrets request` / `manage` through the built CLI. Offline: a
// recording server is every profile's host and must see zero requests.

const cliEntry = join(import.meta.dir, "../../bin/tc");
// Absolute, so the failing-browser case can empty PATH.
const nodeBinary = process.env.NODE_BINARY ?? Bun.which("node") ?? "node";
const OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OTHER_OWNER = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const OWNER_SPACE = "tinycloud:pkh:eip155:1:0xd559ccd9eb87c530a9a349262669386de93cf412:secrets";
const SESSION_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

const requests: string[] = [];
let node: Server<undefined>;
let home: string;

beforeAll(async () => {
  node = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("{}", { status: 500 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "tc-secrets-request-"));
  const profiles: Record<string, Record<string, unknown>> = {
    owner: { posture: "owner-openkey", authMethod: "openkey", did: OWNER, ownerDid: OWNER },
    delegate: { posture: "delegate-session", authMethod: "openkey", did: SESSION_DID, spaceId: OWNER_SPACE },
    keyonly: { posture: "delegate-session", authMethod: "openkey", did: SESSION_DID },
    local: { posture: "local-owner-key", authMethod: "local", did: OWNER, ownerDid: OWNER, privateKey: KEY },
    hybrid: { posture: "owner-openkey", authMethod: "openkey", did: OWNER, ownerDid: OWNER, privateKey: KEY },
  };
  for (const [name, fields] of Object.entries(profiles)) {
    const dir = join(home, ".tinycloud", "profiles", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "profile.json"), JSON.stringify({
      name,
      host: node.url.origin,
      chainId: 1,
      spaceName: "secrets",
      operatorType: "agent",
      createdAt: "2026-10-01T00:00:00.000Z",
      ...fields,
    }));
  }
});

afterAll(async () => {
  node.stop(true);
  await rm(home, { recursive: true, force: true });
});

async function tc(argv: readonly string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home, ...extraEnv };
  delete env.TC_HOST;
  if (extraEnv.TC_PRIVATE_KEY === undefined) delete env.TC_PRIVATE_KEY;
  const started = performance.now();
  const child = Bun.spawn([nodeBinary, cliEntry, "--json", ...argv], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, elapsed: performance.now() - started };
}

function errorOf(stderr: string): Record<string, unknown> {
  return (JSON.parse(stderr) as { error: Record<string, unknown> }).error;
}

function expectedLink(names: string[], scope?: string, requester = "agent@ci") {
  const link = buildSecretRequestUrl({ owner: OWNER, names, requester, ...(scope === undefined ? {} : { scope }) });
  return { url: link.url, names: link.names, ...(scope === undefined ? {} : { scope }), owner: OWNER };
}

describe("tc secrets request (offline, one case per posture row)", () => {
  test("owner-openkey: the recorded owner", async () => {
    const run = await tc(["--profile", "owner", "secrets", "request", "OPENAI_API_KEY", "--requester", "agent@ci"]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(expectedLink(["OPENAI_API_KEY"]));
    expect(run.elapsed).toBeLessThan(2_000);
  });

  test("delegate-session: the owner of its space; --owner equal to it is accepted", async () => {
    const run = await tc(["--profile", "delegate", "secrets", "request", "A", "B", "A", "--requester", "agent@ci"]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(expectedLink(["A", "B"]));
    const lower = await tc(["--profile", "delegate", "secrets", "request", "A", "--requester", "agent@ci", "--owner", OWNER.toLowerCase()]);
    expect(JSON.parse(lower.stdout)).toEqual(expectedLink(["A"]));
  });

  test("the default requester is user@host", async () => {
    const run = await tc(["--profile", "owner", "secrets", "request", "A"]);
    expect(run.exitCode).toBe(0);
    expect(new URL(JSON.parse(run.stdout).url).searchParams.get("requester")).toMatch(/^[^@]+@[^.]+$/);
  });

  test("key-only did:key with no owner: OWNER_DID_UNKNOWN (3), or the --owner given", async () => {
    const unknown = await tc(["--profile", "keyonly", "secrets", "request", "A"]);
    expect(unknown.exitCode).toBe(3);
    expect(errorOf(unknown.stderr).code).toBe("OWNER_DID_UNKNOWN");
    const given = await tc(["--profile", "keyonly", "secrets", "request", "A", "--requester", "agent@ci", "--owner", OWNER]);
    expect(given.exitCode).toBe(0);
    expect(JSON.parse(given.stdout)).toEqual(expectedLink(["A"]));
  });

  test("a disagreeing --owner is OWNER_MISMATCH (2); a malformed one INVALID_OWNER (2)", async () => {
    const mismatch = await tc(["--profile", "owner", "secrets", "request", "A", "--owner", OTHER_OWNER]);
    expect(mismatch.exitCode).toBe(2);
    expect(errorOf(mismatch.stderr).code).toBe("OWNER_MISMATCH");
    const malformed = await tc(["--profile", "keyonly", "secrets", "request", "A", "--owner", "did:key:z6Mk"]);
    expect(malformed.exitCode).toBe(2);
    expect(errorOf(malformed.stderr).code).toBe("INVALID_OWNER");
  });

  test("local identities get LOCAL_OWNER_PROFILE (2): local profile, hybrid privateKey, TC_PRIVATE_KEY, --private-key", async () => {
    for (const [argv, env] of [
      [["--profile", "local", "secrets", "request", "A"], {}],
      [["--profile", "hybrid", "secrets", "request", "A"], {}],
      [["--profile", "delegate", "secrets", "request", "A"], { TC_PRIVATE_KEY: `0x${KEY}` }],
      [["--profile", "delegate", "secrets", "request", "A", "--private-key", `0x${KEY}`], {}],
    ] as const) {
      const run = await tc(argv, env);
      expect({ argv, exitCode: run.exitCode, code: errorOf(run.stderr).code }).toEqual({ argv, exitCode: 2, code: "LOCAL_OWNER_PROFILE" });
      expect(run.stdout).toBe("");
    }
  });

  test("--app maps through appSecretScope; --scope is canonicalized; both together is 2", async () => {
    const app = await tc(["--profile", "owner", "secrets", "request", "A", "--requester", "agent@ci", "--app", "xyz.tinycloud.Feed-Workflows"]);
    expect(app.exitCode).toBe(0);
    expect(JSON.parse(app.stdout)).toEqual(expectedLink(["A"], "xyz-tinycloud-feed-workflows"));
    const scope = await tc(["--profile", "owner", "secrets", "request", "A", "--requester", "agent@ci", "--scope", "Food Drinks"]);
    expect(JSON.parse(scope.stdout)).toEqual(expectedLink(["A"], "food-drinks"));
    const both = await tc(["--profile", "owner", "secrets", "request", "A", "--app", "x.y", "--scope", "z"]);
    expect(both.exitCode).toBe(2);
    const reserved = await tc(["--profile", "owner", "secrets", "request", "A", "--scope", "scoped"]);
    expect(reserved.exitCode).toBe(2);
    expect(errorOf(reserved.stderr).code).toBe("INVALID_SECRET_SCOPE");
  });

  test("11 names, a bad name and a bad requester are usage errors (2)", async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `NAME_${index}`);
    for (const [argv, code] of [
      [["secrets", "request", ...eleven], "TOO_MANY_SECRET_NAMES"],
      [["secrets", "request", "lower_case"], "INVALID_SECRET_NAME"],
      [["secrets", "request", "A", "--requester", "bad\u0007bell"], "INVALID_REQUESTER"],
      [["secrets", "request", "A", "--requester", "x".repeat(65)], "INVALID_REQUESTER"],
    ] as const) {
      const run = await tc(["--profile", "owner", ...argv]);
      expect({ code: errorOf(run.stderr).code, exitCode: run.exitCode }).toEqual({ code, exitCode: 2 });
    }
  });

  test("a failing --open still exits 0 with the link, plus a warning", async () => {
    // An empty PATH and no display: the browser launcher cannot run.
    const emptyPath = join(home, "empty-path");
    await mkdir(emptyPath, { recursive: true });
    const run = await tc(
      ["--profile", "owner", "secrets", "request", "A", "--requester", "agent@ci", "--open"],
      { PATH: emptyPath, DISPLAY: "", WAYLAND_DISPLAY: "", BROWSER: "" },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(expectedLink(["A"]));
    expect(JSON.parse(run.stderr.trim())).toEqual({ warnings: [{ code: "BROWSER_OPEN_FAILED", reason: "open_failed" }] });
  });
});

describe("tc secrets manage", () => {
  test("--no-open prints {url, opened:false} for the named secrets and scope", async () => {
    const run = await tc(["secrets", "manage", "A", "B", "--app", "xyz.tinycloud.feed", "--no-open"]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      url: buildSecretManagerUrl({ names: ["A", "B"], scope: "xyz-tinycloud-feed" }),
      opened: false,
    });
    expect(run.stderr).toBe("");
    const bad = await tc(["secrets", "manage", "lower", "--no-open"]);
    expect(bad.exitCode).toBe(2);
  });
});

test("no command above made a network request", () => {
  expect(requests).toEqual([]);
});
