import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appsAgentScopeNotice } from "../lib/apps-agent-preset.js";

// Runs against a real TinyCloud node binary (the variable the node-sdk e2e tests use).
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");

const HEALTH = "xyz.test.health";
const RECIPES = "xyz.test.recipes";
const BUNDLES: Record<string, string> = {
  [`${HEALTH}/knowledge/index.md`]: '---\nokf_version: "0.2"\n---\n# TinyHealth\n\n- [app](app.md)\n- [meal](tables/meal.md)\n',
  [`${HEALTH}/knowledge/app.md`]: "---\ntype: TinyCloud App\ntitle: TinyHealth\n---\n# TinyHealth\n",
  [`${HEALTH}/knowledge/tables/meal.md`]:
    `---\ntype: SQLite Table\nresource: tinycloud.sql:applications:${HEALTH}/health_log\ntable: meal\ncolumns:\n  - name: kcal\n    type: INTEGER\n---\n# meal\n`,
  [`${RECIPES}/knowledge/index.md`]: "# TinyRecipes\n\n- [app](app.md)\n",
  [`${RECIPES}/knowledge/app.md`]: "---\ntype: TinyCloud App\ntitle: TinyRecipes\n---\n# TinyRecipes\n",
};

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  json(): any;
  /** The `error` object the CLI prints to stderr on failure. */
  error(): any;
}

describe.skipIf(!NODE_BIN)("tinycloud knowledge against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let ownerSpace: string;

  const home = (profile: string) => join(root, `home-${profile}`);

  async function cli(profile: string, args: string[], stdin?: string): Promise<Run> {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn([process.execPath, cliEntry, "--host", host, "--profile", profile, ...args], {
      env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr.slice(stderr.indexOf("{"))).error };
  }

  /** Request → owner grant → agent import. Returns the grant's CID. */
  async function grantAgent(agent: string, requestArgs: string[]): Promise<{ cid: string; notice: string }> {
    const requestFile = join(root, `${agent}-request.json`);
    const grantFile = join(root, `${agent}-grant.json`);
    const request = await cli(agent, ["auth", "request", ...requestArgs, "--emit", requestFile]);
    expect(request.exitCode).toBe(0);
    const granted = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(granted.exitCode).toBe(0);
    await writeFile(grantFile, granted.stdout);
    const imported = await cli(agent, ["auth", "import", grantFile]);
    expect(imported.exitCode).toBe(0);
    return { cid: granted.json().delegationCid, notice: request.stderr };
  }

  async function newAgent(name: string): Promise<void> {
    const created = await cli(name, ["profile", "create", name, "--posture", "delegate-session", "--operator", "agent"]);
    expect(created.exitCode).toBe(0);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-knowledge-e2e-"));
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") return reject(new Error("no port"));
        server.close(() => resolve(address.port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    node = spawn(NODE_BIN!, [], {
      cwd: root,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(root, "data"),
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = Promise.withResolvers<void>();
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    node.stdout!.on("data", onData);
    node.stderr!.on("data", onData);
    node.once("error", (error) => launched.reject(error));
    await launched.promise;

    // The user: a local-key owner profile that installed two apps' bundles.
    await mkdir(home("owner"), { recursive: true });
    expect((await cli("owner", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("owner", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    const caps = ["--cap", "tinycloud.kv:applications::get,list,put,del", "--cap", "tinycloud.sql:applications::read,write,admin"];
    expect((await cli("owner", ["auth", "request", ...caps, "--grant", "--yes"])).exitCode).toBe(0);
    const space = await cli("owner", ["space", "create", "applications"]);
    expect(space.exitCode).toBe(0);
    ownerSpace = space.json().spaceId;
    for (const [key, text] of Object.entries(BUNDLES)) {
      const file = join(root, "bundle.md");
      await writeFile(file, text);
      expect((await cli("owner", ["kv", "put", "--space", "applications", key, "--file", file])).exitCode).toBe(0);
    }
    // Not part of any bundle: must never show up as an app.
    expect((await cli("owner", ["kv", "put", "--space", "applications", `${HEALTH}/app/app.jsx`, "export default 1"])).exitCode).toBe(0);
  }, 120_000);

  afterAll(async () => {
    node?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  test("a grant for one app: list --app and read work; a whole-space list is exit 5 with a --cap hint", async () => {
    await newAgent("one-app");
    await grantAgent("one-app", ["--preset", "apps-agent", "--app", RECIPES]);

    const scoped = await cli("one-app", ["knowledge", "list", "--app", RECIPES]);
    expect(scoped.exitCode).toBe(0);
    expect(scoped.json()).toMatchObject({
      apps: [{ app_id: RECIPES, concepts: ["app.md"], has_index: true }],
      count: 1,
      registry: "skipped",
    });
    const concept = await cli("one-app", ["knowledge", "read", RECIPES, "app"]);
    expect(concept.exitCode).toBe(0);
    expect(concept.json()).toMatchObject({ kind: "concept", frontmatter: { type: "TinyCloud App", title: "TinyRecipes" } });

    const all = await cli("one-app", ["knowledge", "list"]);
    expect(all.exitCode).toBe(5);
    expect(all.error()).toMatchObject({
      code: "PERMISSION_DENIED",
      message: expect.stringContaining("tinycloud.kv:applications::list"),
      hint: expect.stringContaining("--cap tinycloud.kv:applications::list"),
    });
    const other = await cli("one-app", ["knowledge", "read", HEALTH]);
    expect(other.exitCode).toBe(5);
    expect(other.error().hint).toContain(`--cap tinycloud.kv:applications:${HEALTH}/knowledge/index.md:get`);
  }, 120_000);

  test("the whole-space preset: scope notice before approval, list returns both apps, read returns parsed concepts", async () => {
    await newAgent("all-apps");
    const { notice } = await grantAgent("all-apps", ["--preset", "apps-agent"]);
    expect(notice).toContain(appsAgentScopeNotice());

    const listed = await cli("all-apps", ["knowledge", "list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.json()).toMatchObject({
      space: ownerSpace.toLowerCase(),
      count: 2,
      truncated: false,
      registry: "not_granted",
      apps: [
        { app_id: HEALTH, root: `${HEALTH}/knowledge/`, has_index: true, concepts: ["app.md", "tables/meal.md"] },
        { app_id: RECIPES, root: `${RECIPES}/knowledge/`, has_index: true, concepts: ["app.md"] },
      ],
    });

    const index = await cli("all-apps", ["knowledge", "read", HEALTH]);
    expect(index.json()).toMatchObject({
      kind: "index",
      frontmatter: { okf_version: "0.2" },
      links: [{ target: "app.md" }, { target: "tables/meal.md" }],
    });
    const table = await cli("all-apps", ["knowledge", "read", HEALTH, "tables/meal.md"]);
    expect(table.exitCode).toBe(0);
    expect(table.json()).toMatchObject({
      kind: "concept",
      frontmatter: {
        type: "SQLite Table",
        resource: `tinycloud.sql:applications:${HEALTH}/health_log`,
        table: "meal",
        columns: [{ name: "kcal", type: "INTEGER" }],
      },
    });
    expect((await cli("all-apps", ["knowledge", "read", HEALTH, "nope.md"])).exitCode).toBe(4);
  }, 120_000);

  test("the preset can write but not delete or leave the applications space, and revocation ends it", async () => {
    await newAgent("scoped");
    const { cid } = await grantAgent("scoped", ["--preset", "apps-agent"]);

    const key = `${HEALTH}/knowledge/log.md`;
    expect((await cli("scoped", ["kv", "put", "--space", ownerSpace, key, "agent note"])).exitCode).toBe(0);
    expect((await cli("scoped", ["kv", "delete", "--space", ownerSpace, key])).exitCode).toBe(5);
    expect((await cli("scoped", ["kv", "list", "--space", ownerSpace.replace(/:applications$/, ":default")])).exitCode).toBe(5);

    expect((await cli("owner", ["delegation", "revoke", cid, "--yes"])).exitCode).toBe(0);
    const after = await cli("scoped", ["knowledge", "list"]);
    expect(after.exitCode).not.toBe(0);
    expect(after.error().code).toMatch(/AUTH_REQUIRED|PERMISSION_DENIED/);
  }, 120_000);
});
