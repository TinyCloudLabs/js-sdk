import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("a legacy CLI import and operations writer append distinct requests without loss", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-legacy-cli-concurrency-"));
  homes.push(home);
  const profile = "delegate";
  const legacyRequest = request("req-cli");
  const operationsRequest = request("req-operations");
  const legacyArtifactPath = join(home, "legacy-request.json");
  const legacyCliEntry = new URL("../../cli/src/index.ts", import.meta.url).pathname;
  const operationsFixture = new URL("../test-support/append-profile-record.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir() };
  await writeFile(legacyArtifactPath, JSON.stringify(legacyRequest), "utf8");
  const legacy = Bun.spawn([
    process.execPath,
    legacyCliEntry,
    "--profile",
    profile,
    "auth",
    "import",
    legacyArtifactPath,
  ], { env, stdout: "pipe", stderr: "pipe" });
  const operations = Bun.spawn([
    process.execPath,
    operationsFixture,
    profile,
    operationsRequest.requestId,
    JSON.stringify(operationsRequest),
  ], { env, stdout: "pipe", stderr: "pipe" });

  const [legacyExit, operationsExit, legacyError, operationsError] = await Promise.all([
    legacy.exited,
    operations.exited,
    new Response(legacy.stderr).text(),
    new Response(operations.stderr).text(),
  ]);

  expect(legacyExit, legacyError).toBe(0);
  expect(operationsExit, operationsError).toBe(0);
  const records = (JSON.parse(await readFile(
    join(home, ".tinycloud", "profiles", profile, "auth-requests.json"),
    "utf8",
  )) as Array<{ requestId: string }>)
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
  expect(records).toEqual([legacyRequest, operationsRequest]);
});

function request(requestId: string): {
  kind: "tinycloud.auth.request";
  version: 1;
  requestId: string;
  createdAt: string;
  profile: string;
  posture: "delegate-session";
  operatorType: "agent";
  host: string;
  sessionDid: string;
  requested: [];
} {
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId,
    createdAt: "2026-07-14T12:00:00.000Z",
    profile: "delegate",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    requested: [],
  };
}
