import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliEntry = join(import.meta.dir, "../../bin/tc");
let node: Server<undefined>;

// A node that serves only the real health route, as tinycloud-node does.
beforeAll(() => {
  node = Bun.serve({
    port: 0,
    fetch: (request) => new Response(new URL(request.url).pathname === "/healthz" ? "ok" : "not found", {
      status: new URL(request.url).pathname === "/healthz" ? 200 : 404,
    }),
  });
});
afterAll(() => node.stop(true));

type Check = { name: string; ok: boolean; detail?: string };

async function doctor(home: string, argv: string[] = []): Promise<Check[]> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([process.env.NODE_BINARY ?? "node", cliEntry, "--json", ...argv, "doctor"], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const result: { checks: Check[] } = JSON.parse(stdout);
  return result.checks;
}

describe("tc doctor (TC-1048)", () => {
  test("reports a node that serves /healthz as reachable", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-doctor-node-"));
    try {
      const checks = await doctor(home, ["--host", node.url.origin]);
      expect(checks.find((check) => check.name === "Node")).toMatchObject({ ok: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails the session check for an expired session and names the sign-in command", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-doctor-session-"));
    try {
      const init = Bun.spawn([process.env.NODE_BINARY ?? "node", cliEntry, "init", "--name", "demo", "--key-only", "--host", node.url.origin], {
        env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      expect(await init.exited).toBe(0);
      await writeFile(join(home, ".tinycloud/profiles/demo/session.json"), JSON.stringify({ expiresAt: "2026-01-01T00:00:00.000Z" }));
      const checks = await doctor(home, ["--profile", "demo"]);
      expect(checks.find((check) => check.name === "Session")).toEqual({
        name: "Session",
        ok: false,
        detail: expect.stringMatching(/^expired 2026-01-01T00:00:00\.000Z — Sign in again with: tc --profile demo auth login/),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
