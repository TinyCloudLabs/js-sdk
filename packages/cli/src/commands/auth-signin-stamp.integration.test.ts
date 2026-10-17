import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { restoreSessionStamp } from "@tinycloud/replica/profile-gate";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("fresh local sign-in persists a genuine stamp for a new process without making report live", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-local-stamp-"));
  homes.push(home);
  const node = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
      if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
      return new Response(`Unsupported fake node request: ${request.method} ${path}`, { status: 404 });
    },
  });
  servers.push(node);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const directory = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });

  const login = await run(home, ["auth", "login", "--method", "local", "--replication-prefix", "notes/"]);
  expect(login.exitCode, login.stderr).toBe(0);
  const session = JSON.parse(await readFile(await withTinyCloudStateRoot(home, () => Promise.resolve(sessionPath(PROFILE))), "utf8"));
  expect(session.replicaStamp).toBeDefined();
  expect(session.ownerDid).toBe(ownerDid);
  expect(await restoreSessionStamp(directory, ownerDid, session.replicaStamp)).toEqual(session.replicaStamp);

  const report = await run(home, ["--replication", "replica", "report", "--json"]);
  expect(report.exitCode, report.stderr).toBe(0);
  expect(JSON.parse(report.stdout).replicas).toEqual([]);

  const rootLogin = await run(home, [
    "auth", "login", "--method", "local", "--replication-prefix", "/", "--replication-allow-secrets",
  ]);
  expect(rootLogin.exitCode, rootLogin.stderr).toBe(0);
  const rootReport = await run(home, ["--replication", "replica", "report", "--json"]);
  expect(rootReport.exitCode, rootReport.stderr).toBe(0);
  expect(JSON.parse(rootReport.stdout)).toMatchObject({ replicas: [], replicasUnavailable: true });
  const rootRead = await run(home, ["--replication", "kv", "get", "notes/a", "--raw"]);
  expect(rootRead.exitCode).not.toBe(0); // The fake node has no KV endpoint.
  const eventsPath = join(directory, "replication", "events.jsonl");
  const rootEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(rootEvents).toContainEqual(expect.objectContaining({
    type: "replication.state", state: "unavailable", code: "REPLICATION_ROOT_UNSUPPORTED",
  }));

  const sessionFile = await withTinyCloudStateRoot(home, () => Promise.resolve(sessionPath(PROFILE)));
  const unstamped = JSON.parse(await readFile(sessionFile, "utf8"));
  delete unstamped.replicaStamp;
  await writeFile(sessionFile, JSON.stringify(unstamped));
  const gatedReport = await run(home, ["--replication", "replica", "report", "--json"]);
  expect(gatedReport.exitCode, gatedReport.stderr).toBe(0);
  expect(JSON.parse(gatedReport.stdout)).toMatchObject({ replicas: [], replicasUnavailable: true });
  const gatedRead = await run(home, ["--replication", "kv", "get", "notes/a", "--raw"]);
  expect(gatedRead.exitCode).not.toBe(0);
  const gatedEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(gatedEvents.slice(rootEvents.length)).toContainEqual(expect.objectContaining({
    type: "replication.read", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error",
  }));
}, 30_000);
