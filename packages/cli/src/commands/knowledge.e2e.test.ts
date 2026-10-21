import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appsAgentScopeNotice, describeAction } from "../lib/apps-agent-preset.js";

// Runs against a real TinyCloud node binary (the variable the node-sdk e2e tests use).
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");

const HEALTH = "xyz.test.health";
const RECIPES = "xyz.test.recipes";
const HEALTH_DB = `${HEALTH}/health_log`;
const BUNDLES: Record<string, string> = {
  [`${HEALTH}/knowledge/index.md`]: '---\nokf_version: "0.2"\n---\n# TinyHealth\n\n- [app](app.md)\n- [meal](tables/meal.md)\n',
  [`${HEALTH}/knowledge/app.md`]: "---\ntype: TinyCloud App\ntitle: TinyHealth\n---\n# TinyHealth\n",
  [`${HEALTH}/knowledge/tables/meal.md`]:
    `---\ntype: SQLite Table\nresource: tinycloud.sql:applications:${HEALTH_DB}\ntable: meal\ncolumns:\n  - name: kcal\n    type: INTEGER\n---\n# meal\n`,
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

  async function cli(profile: string, args: string[]): Promise<Run> {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn([process.execPath, cliEntry, "--host", host, "--profile", profile, ...args], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr.slice(stderr.indexOf("{"))).error };
  }

  /** Request, owner grant, agent import. `edit` may change the request file between the first two steps. */
  async function grantAgent(
    agent: string,
    requestArgs: string[],
    edit?: (request: Record<string, unknown>) => void,
  ): Promise<{ cid: string; requestNotice: string; grantNotice: string }> {
    const requestFile = join(root, `${agent}-request.json`);
    const grantFile = join(root, `${agent}-grant.json`);
    const request = await cli(agent, ["auth", "request", ...requestArgs, "--emit", requestFile]);
    expect(request.exitCode).toBe(0);
    if (edit !== undefined) {
      const artifact = JSON.parse(await readFile(requestFile, "utf8")) as Record<string, unknown>;
      edit(artifact);
      await writeFile(requestFile, JSON.stringify(artifact));
    }
    const granted = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(granted.exitCode).toBe(0);
    await writeFile(grantFile, granted.stdout);
    const imported = await cli(agent, ["auth", "import", grantFile]);
    expect(imported.exitCode).toBe(0);
    return { cid: granted.json().delegationCid, requestNotice: request.stderr, grantNotice: granted.stderr };
  }

  async function newAgent(name: string): Promise<void> {
    await mkdir(home(name), { recursive: true });
    const created = await cli(name, ["profile", "create", name, "--posture", "delegate-session", "--operator", "agent"]);
    // A setup failure names its cause instead of an anonymous "Expected: 0".
    if (created.exitCode !== 0) throw new Error(`profile create ${name} exited ${created.exitCode}: ${created.stderr.slice(0, 500)}`);
  }

  async function ownerRows(): Promise<unknown[][]> {
    const rows = await cli("owner", ["sql", "query", "SELECT name FROM meal ORDER BY id", "--db", HEALTH_DB, "--space", "applications"]);
    expect(rows.exitCode).toBe(0);
    return rows.json().rows;
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

    // The user: a local-key owner profile that installed two apps' bundles and one table.
    await mkdir(home("owner"), { recursive: true });
    expect((await cli("owner", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("owner", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    const caps = [
      "--cap", "tinycloud.kv:applications::get,list,put,del",
      "--cap", "tinycloud.sql:applications::read,write,schema,admin",
    ];
    expect((await cli("owner", ["auth", "request", ...caps, "--grant", "--yes"])).exitCode).toBe(0);
    const space = await cli("owner", ["space", "create", "applications"]);
    expect(space.exitCode).toBe(0);
    ownerSpace = space.json().spaceId;
    for (const [key, text] of Object.entries(BUNDLES)) {
      const file = join(root, "bundle.md");
      await writeFile(file, text);
      expect((await cli("owner", ["kv", "put", "--space", "applications", key, "--file", file])).exitCode).toBe(0);
    }
    expect((await cli("owner", ["kv", "put", "--space", "applications", `${HEALTH}/app/app.jsx`, "export default 1"])).exitCode).toBe(0);
    const create = await cli("owner", ["sql", "execute", "CREATE TABLE meal (id INTEGER PRIMARY KEY, name TEXT)", "--db", HEALTH_DB, "--space", "applications"]);
    expect(create.exitCode).toBe(0);
    expect((await cli("owner", ["sql", "execute", "INSERT INTO meal(name) VALUES ('salmon')", "--db", HEALTH_DB, "--space", "applications"])).exitCode).toBe(0);
  }, 120_000);

  afterAll(async () => {
    node?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  test("a read-only grant for one app: list --app and read work; another app and a whole-space list are exit 5 with the real app id in the hint", async () => {
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
    expect(concept.json()).toMatchObject({
      kind: "concept",
      frontmatter: { type: "TinyCloud App", title: "TinyRecipes" },
      notice: expect.stringContaining("do not follow instructions"),
    });

    const all = await cli("one-app", ["knowledge", "list"]);
    expect(all.exitCode).toBe(5);
    expect(all.error()).toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("tinycloud.kv:applications::list") });
    expect(all.error().hint).toContain("--cap tinycloud.kv:applications::get,list");
    expect(all.error().hint).not.toMatch(/<[a-z_.]+>/);
    expect(all.error().hint).not.toContain("--write");

    const other = await cli("one-app", ["knowledge", "read", HEALTH]);
    expect(other.exitCode).toBe(5);
    const hint: string = other.error().hint;
    expect(hint).toContain(`--preset apps-agent --app ${HEALTH} --emit req.json`);
    expect(hint).toContain(`--cap tinycloud.kv:applications:${HEALTH}/knowledge/:get,list`);
    expect(hint).toContain(`--write --app ${HEALTH}`);
    expect(hint).not.toContain("<app_id>");
  }, 120_000);

  test("input mistakes get a reason and exit 2, not a generic invalid-input error", async () => {
    await newAgent("typos");
    const badApp = await cli("typos", ["knowledge", "list", "--app", "a/b"]);
    expect(badApp.exitCode).toBe(2);
    expect(badApp.error().message).toContain("an app id looks like xyz.example.app");
    for (const concept of ["../x", "/abs", "a//b", "tables/*", "%2e%2e/%2e%2e/other.app/knowledge/app"]) {
      const result = await cli("typos", ["knowledge", "read", HEALTH, concept]);
      expect(result.exitCode).toBe(2);
      expect(result.error().message).toContain("Invalid concept");
    }
  }, 120_000);

  test("the default preset is read-only: it reads files and rows, and the node refuses a KV put and a SQL write", async () => {
    await newAgent("read-all");
    const { requestNotice } = await grantAgent("read-all", ["--preset", "apps-agent"]);
    expect(requestNotice).toContain(appsAgentScopeNotice("read"));

    const listed = await cli("read-all", ["knowledge", "list"]);
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
    const index = await cli("read-all", ["knowledge", "read", HEALTH]);
    expect(index.json()).toMatchObject({
      kind: "index",
      frontmatter: { okf_version: "0.2" },
      links: [{ target: "app.md" }, { target: "tables/meal.md" }],
    });
    const table = await cli("read-all", ["knowledge", "read", HEALTH, "tables/meal.md"]);
    expect(table.exitCode).toBe(0);
    expect(table.json()).toMatchObject({
      kind: "concept",
      frontmatter: {
        type: "SQLite Table",
        resource: `tinycloud.sql:applications:${HEALTH_DB}`,
        table: "meal",
        columns: [{ name: "kcal", type: "INTEGER" }],
      },
    });
    expect((await cli("read-all", ["knowledge", "read", HEALTH, "nope.md"])).exitCode).toBe(4);

    // The resource: in the concept is usable as-is: the agent can query the table it names.
    const select = await cli("read-all", ["sql", "query", "SELECT name FROM meal", "--db", HEALTH_DB, "--space", ownerSpace]);
    expect(select.exitCode).toBe(0);
    expect(select.json().rows).toEqual([["salmon"]]);

    // Read-only means the node refuses writes: the CLI exits 5 and the owner's data is unchanged.
    const key = `${HEALTH}/knowledge/read-only-probe.md`;
    expect((await cli("read-all", ["kv", "put", "--space", ownerSpace, key, "no"])).exitCode).toBe(5);
    expect((await cli("owner", ["kv", "get", "--space", "applications", key])).exitCode).toBe(4);
    expect((await cli("read-all", ["sql", "execute", "INSERT INTO meal(name) VALUES ('injected')", "--db", HEALTH_DB, "--space", ownerSpace])).exitCode).toBe(5);
    expect((await cli("read-all", ["sql", "execute", "DROP TABLE meal", "--db", HEALTH_DB, "--space", ownerSpace])).exitCode).toBe(5);
    expect(await ownerRows()).toEqual([["salmon"]]);
  }, 180_000);

  test("--write needs --app, and a write grant for one app can write its knowledge and data files but not its code, manifest or install record", async () => {
    await newAgent("writer");
    const noApp = await cli("writer", ["auth", "request", "--preset", "apps-agent", "--write", "--emit", join(root, "none.json")]);
    expect(noApp.exitCode).toBe(2);
    expect(noApp.error().message).toContain("--write needs --app");
    const noPreset = await cli("writer", ["auth", "request", "--write", "--emit", join(root, "none.json")]);
    expect(noPreset.exitCode).toBe(2);

    const { requestNotice, grantNotice } = await grantAgent("writer", ["--preset", "apps-agent", "--write", "--app", HEALTH]);
    expect(requestNotice).toContain(appsAgentScopeNotice("write", [HEALTH]));
    expect(requestNotice).toContain("This grant does not include permission to create, change or drop tables (tinycloud.sql/schema).");
    expect(grantNotice).toContain(appsAgentScopeNotice("write", [HEALTH]));

    const note = `${HEALTH}/knowledge/log.md`;
    expect((await cli("writer", ["kv", "put", "--space", ownerSpace, note, "agent note"])).exitCode).toBe(0);
    expect((await cli("owner", ["kv", "get", "--space", "applications", note, "--raw"])).stdout).toContain("agent note");
    expect((await cli("writer", ["sql", "execute", "INSERT INTO meal(name) VALUES ('rice')", "--db", HEALTH_DB, "--space", ownerSpace])).exitCode).toBe(0);
    expect(await ownerRows()).toEqual([["salmon"], ["rice"]]);
    expect((await cli("writer", ["sql", "execute", "CREATE TABLE extra (x TEXT)", "--db", HEALTH_DB, "--space", ownerSpace])).exitCode).toBe(5);
    const prefs = `${HEALTH}/prefs/targets.json`;
    expect((await cli("writer", ["kv", "put", "--space", ownerSpace, prefs, '{"kcal":2000}'])).exitCode).toBe(0);
    expect((await cli("owner", ["kv", "get", "--space", "applications", prefs, "--raw"])).stdout).toContain("2000");

    // The app's code, manifest and install record are readable but the node refuses every write to them.
    const protectedFiles: Record<string, string> = {
      [`${HEALTH}/app/app.jsx`]: "export default () => null;\n",
      [`${HEALTH}/manifest.json`]: '{"app_id":"x"}\n',
      [`${HEALTH}/install.json`]: '{"installed":true}\n',
      // The share runner keeps the stored manifest and install record under app/.
      [`${HEALTH}/app/manifest.json`]: '{"app_id":"x","stored":true}\n',
      [`${HEALTH}/app/install.json`]: '{"installed":true,"stored":true}\n',
    };
    for (const [key, original] of Object.entries(protectedFiles)) {
      await writeFile(join(root, "protected.txt"), original);
      expect((await cli("owner", ["kv", "put", "--space", "applications", key, "--file", join(root, "protected.txt")])).exitCode).toBe(0);
    }
    for (const key of [...Object.keys(protectedFiles), `${HEALTH}/data/x`, `${HEALTH}/knowledgebase/x`]) {
      expect((await cli("writer", ["kv", "put", "--space", ownerSpace, key, "overwritten by the agent"])).exitCode).toBe(5);
    }
    // A key that climbs out of the write folder is refused too (the node's 401 carries no capability to name, so the CLI exits 3).
    expect((await cli("writer", ["kv", "put", "--space", ownerSpace, `${HEALTH}/knowledge/../app/app.jsx`, "overwritten by the agent"])).exitCode).not.toBe(0);
    for (const [key, original] of Object.entries(protectedFiles)) {
      expect((await cli("writer", ["kv", "get", "--space", ownerSpace, key, "--raw"])).stdout).toBe(original);
      expect((await cli("owner", ["kv", "get", "--space", "applications", key, "--raw"])).stdout).toBe(original);
    }
    expect((await cli("writer", ["knowledge", "read", HEALTH])).exitCode).toBe(0);

    // Not delete, and not another app or another space.
    expect((await cli("writer", ["kv", "delete", "--space", ownerSpace, note])).exitCode).toBe(5);
    expect((await cli("writer", ["kv", "put", "--space", ownerSpace, `${RECIPES}/knowledge/log.md`, "x"])).exitCode).toBe(5);
    expect((await cli("writer", ["kv", "put", "--space", ownerSpace, `${HEALTH}x/knowledge/log.md`, "x"])).exitCode).toBe(5);
    expect((await cli("writer", ["kv", "list", "--space", ownerSpace.replace(/:applications$/, ":default")])).exitCode).toBe(5);
  }, 180_000);

  test("a write grant for a catalog app creates and drops tables only in its own database, at the exact path", async () => {
    const CAT = "xyz.tinycloud.sample.healthlog";
    const CAT_DB = `${CAT}/healthlog`;
    await newAgent("catwriter");
    const { requestNotice, grantNotice } = await grantAgent("catwriter", ["--preset", "apps-agent", "--write", "--app", CAT]);
    expect(requestNotice).toContain(appsAgentScopeNotice("write", [CAT]));
    expect(grantNotice).toContain("It can also create, change and drop the tables in");

    expect((await cli("owner", ["sql", "execute", "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY)", "--db", CAT_DB, "--space", "applications"])).exitCode).toBe(0);
    // Positive: the schema grant covers CREATE and DROP on the exact catalog database.
    expect((await cli("catwriter", ["sql", "execute", "CREATE TABLE IF NOT EXISTS extra (x TEXT)", "--db", CAT_DB, "--space", ownerSpace])).exitCode).toBe(0);
    expect((await cli("catwriter", ["sql", "execute", "DROP TABLE extra", "--db", CAT_DB, "--space", ownerSpace])).exitCode).toBe(0);
    // Refused: another database of the same app, and the same database with a trailing slash. Exit code is 3 or 5 depending on how the node's 401/403 maps, so only non-zero is asserted.
    expect((await cli("catwriter", ["sql", "execute", "CREATE TABLE IF NOT EXISTS extra (x TEXT)", "--db", `${CAT}/other`, "--space", ownerSpace])).exitCode).not.toBe(0);
    expect((await cli("catwriter", ["sql", "execute", "CREATE TABLE IF NOT EXISTS extra (x TEXT)", "--db", `${CAT_DB}/`, "--space", ownerSpace])).exitCode).not.toBe(0);
    expect((await cli("owner", ["sql", "query", "SELECT name FROM sqlite_master WHERE name = 'extra'", "--db", CAT_DB, "--space", "applications"])).json().rows).toEqual([]);
  }, 180_000);

  test("the owner-side text follows what will be signed, not the requester's wording", async () => {
    await newAgent("tamper");
    const long = await grantAgent("tamper", ["--preset", "apps-agent"], (request) => {
      request.requestedExpiry = "365d";
    });
    expect(long.grantNotice).toContain("365 days");
    expect(long.grantNotice).not.toContain("7 days");
    expect(long.grantNotice).toContain("not the standard apps-agent grant");

    await newAgent("honest");
    const honest = await grantAgent("honest", ["--preset", "apps-agent", "--app", RECIPES]);
    expect(honest.grantNotice).toContain(appsAgentScopeNotice("read", [RECIPES]));
    expect(honest.grantNotice).toContain("7 days");

    // A hand-made request with delete is described, not passed off as the preset.
    await newAgent("handmade");
    const handmade = await grantAgent("handmade", ["--cap", "tinycloud.kv:applications::get,list,del", "--expiry", "2d"]);
    expect(handmade.grantNotice).toContain("delete files");
    expect(handmade.grantNotice).toContain("2 days");
  }, 180_000);

  /** The entry lines of the owner-side text: `- ` inside the preset's limits, `! ` beyond them. */
  const bulletLines = (stderr: string) => stderr.split("\n").filter((line) => /^[-!] /.test(line));

  /**
   * Every SIGNED resource (decoded from the grant's `delegation.resources`, not the request echo) has exactly
   * one printed line, naming its space, its path and each of its actions.
   */
  function expectPrintedToEqualSigned(stderr: string, grant: { delegation: { resources: { service: string; space: string; path: string; actions: string[] }[] } }): void {
    const resources = grant.delegation.resources;
    const lines = bulletLines(stderr);
    expect(lines).toHaveLength(resources.length);
    for (const resource of resources) {
      const service = resource.service.startsWith("tinycloud.") ? resource.service : `tinycloud.${resource.service}`;
      const inApplications = resource.space.toLowerCase() === ownerSpace.toLowerCase();
      const matching = lines.filter((line) =>
        line.includes(`(${service})`) &&
        line.includes(inApplications ? "your `applications` space" : `space \`${resource.space}\``) &&
        line.includes(resource.path === "" ? "ALL apps in" : `\`${resource.path}\``) &&
        resource.actions.every((action) => line.includes(describeAction(action))));
      expect(matching).toHaveLength(1);
    }
  }

  test("an entry smuggled into the request file is listed once, needs --yes, and the printed set is the signed set", async () => {
    const smuggle = (request: Record<string, unknown>) => {
      (request.requested as unknown[]).push({
        service: "tinycloud.delegation", space: "applications", path: "", actions: ["tinycloud.delegation/create"],
      });
    };

    // Without --yes and without a terminal the owner signs nothing, and the refusal says so without repeating the list.
    await newAgent("smuggler");
    const requestFile = join(root, "smuggler-request.json");
    expect((await cli("smuggler", ["auth", "request", "--preset", "apps-agent", "--app", RECIPES, "--emit", requestFile])).exitCode).toBe(0);
    const artifact = JSON.parse(await readFile(requestFile, "utf8")) as Record<string, unknown>;
    smuggle(artifact);
    await writeFile(requestFile, JSON.stringify(artifact));
    const refused = await cli("owner", ["auth", "grant", requestFile]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("MORE than the apps-agent preset");
    expect(refused.stderr.split("can give other people or agents access on your behalf")).toHaveLength(2);
    expect(refused.stdout).toBe("");
    expect(refused.error().message).toContain("Nothing was signed");

    // With --yes it is signed; the printed lines are the signed resources, the extra one first and in words.
    const signed = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(signed.exitCode).toBe(0);
    expect(signed.stderr).toContain("MORE than the apps-agent preset");
    expect(bulletLines(signed.stderr)[0]).toStartWith("! ");
    expect(bulletLines(signed.stderr)[0]).toContain("can give other people or agents access on your behalf");
    const grant = signed.json();
    expect(grant.delegation.resources.map((resource: { service: string }) => resource.service)).toContain("delegation");
    expectPrintedToEqualSigned(signed.stderr, grant);

    // The exact preset request prints only the preset text and needs no --yes.
    await newAgent("plain");
    const plainFile = join(root, "plain-request.json");
    expect((await cli("plain", ["auth", "request", "--preset", "apps-agent", "--app", RECIPES, "--emit", plainFile])).exitCode).toBe(0);
    const plain = await cli("owner", ["auth", "grant", plainFile]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stderr).toContain(appsAgentScopeNotice("read", [RECIPES]));
    expect(bulletLines(plain.stderr)).toHaveLength(0);
  }, 180_000);

  test("an entry with no space is the owner's applications space: listed as that, gated, signs nothing without --yes", async () => {
    await newAgent("nospace");
    const requestFile = join(root, "nospace-request.json");
    expect((await cli("nospace", ["auth", "request", "--preset", "apps-agent", "--app", RECIPES, "--emit", requestFile])).exitCode).toBe(0);
    const artifact = JSON.parse(await readFile(requestFile, "utf8")) as { requested: Record<string, unknown>[] };
    // the whole space, with delete, and no `space` field at all
    artifact.requested.push({ service: "tinycloud.kv", path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] });
    await writeFile(requestFile, JSON.stringify(artifact));

    const refused = await cli("owner", ["auth", "grant", requestFile]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("MORE than the apps-agent preset");
    expect(refused.stderr).toContain("delete files");
    expect(refused.stderr).toContain("ALL apps in your `applications` space");
    expect(refused.stderr).not.toContain("space ``");

    const signed = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(signed.exitCode).toBe(0);
    expectPrintedToEqualSigned(signed.stderr, signed.json());
    // what was signed is that whole-space entry, in the owner's applications space
    const wholeSpace = signed.json().delegation.resources.find((resource: { service: string; path: string }) => resource.service === "kv" && resource.path === "");
    expect(wholeSpace).toBeDefined();
    expect(wholeSpace.space.toLowerCase()).toBe(ownerSpace.toLowerCase());
    expect(wholeSpace.actions).toEqual(["tinycloud.kv/del", "tinycloud.kv/get", "tinycloud.kv/put"]);

    // An empty space is refused outright.
    artifact.requested[artifact.requested.length - 1]!.space = "";
    await writeFile(requestFile, JSON.stringify(artifact));
    const empty = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stdout).toBe("");
    expect(empty.error().message).toContain("empty space");
  }, 180_000);

  test("a vault entry, an unsignable service, hostile text and a non-JSON file are refused with exit 2 and nothing signed or printed raw", async () => {
    await newAgent("hostile");
    const requestFile = join(root, "hostile-request.json");
    expect((await cli("hostile", ["auth", "request", "--preset", "apps-agent", "--app", RECIPES, "--emit", requestFile])).exitCode).toBe(0);
    const base = JSON.parse(await readFile(requestFile, "utf8")) as { requested: Record<string, unknown>[] };
    // eslint-disable-next-line no-control-regex
    const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
    const attempt = async (extra: Record<string, unknown>, expected: string) => {
      const artifact = { ...base, requested: [...base.requested, extra] };
      await writeFile(requestFile, JSON.stringify(artifact));
      const result = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toMatch(RAW_CONTROL);
      expect(result.error().message).toContain(expected);
    };
    await attempt({ service: "tinycloud.vault", space: "applications", path: "", actions: ["del"] }, "the vault");
    await attempt({ service: "tinycloud.zzz\u001b[2J\u202e", space: "applications", path: "", actions: ["tinycloud.zzz/x"] }, "cannot sign");
    await attempt({ service: "tinycloud.kv", space: "bad\u001b]0;x\u0007\u202e name", path: "", actions: ["get"] }, "Invalid space");

    await writeFile(requestFile, "\u001b[2J\u202e not json");
    const notJson = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    expect(notJson.exitCode).toBe(2);
    expect(notJson.stderr).not.toMatch(RAW_CONTROL);
    expect(notJson.error().message).toBe("The request file is not valid JSON.");
  }, 180_000);

  // On a terminal the CLI prints human errors. `script` gives the child a real pty, so this is the path an owner sees.
  test.skipIf(Bun.which("script") === null)("on a terminal, every hostile class in a request file is escaped in the real error paths of auth grant", async () => {
    await newAgent("pty");
    const requestFile = join(root, "pty-request.json");
    expect((await cli("pty", ["auth", "request", "--preset", "apps-agent", "--app", RECIPES, "--emit", requestFile])).exitCode).toBe(0);
    const base = JSON.parse(await readFile(requestFile, "utf8")) as Record<string, unknown> & { requested: Record<string, unknown>[] };

    // ESC[2J, OSC 0 with BEL, NUL, CR, newline, U+202E, U+2028, U+2066, C1 0x9b, U+200B, U+FEFF
    const HOSTILE = "\u001b[2J\u001b]0;owned\u0007\u0000\r\n\u202e\u2028\u2066\u009b\u200b\ufeff";
    const PAYLOAD = /\u001b\[2J|\u001b\]0;|\u0007|\u0000|\u202e|\u2028|\u2066|\u009b|\u200b|\ufeff/;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

    // `redirect` is the documented `auth grant req.json > grant.json`: stdout goes to a file, stderr is still the terminal.
    const onPty = async (artifact: unknown, redirect = false, yes = true): Promise<{ exitCode: number; output: string }> => {
      await writeFile(requestFile, JSON.stringify(artifact));
      const args = [process.execPath, cliEntry, "--host", host, "--profile", "owner", "auth", "grant", requestFile, ...(yes ? ["--yes"] : [])];
      const command = `${args.map(quote).join(" ")}${redirect ? ` > ${quote(join(root, "pty-stdout.json"))}` : ""}`;
      const env: Record<string, string | undefined> = { ...process.env, HOME: home("owner"), TC_HOME: home("owner") };
      delete env.TC_HOST;
      delete env.TC_PRIVATE_KEY;
      const child = Bun.spawn(["script", "-qec", command, "/dev/null"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.end();
      const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { exitCode, output: out + err };
    };

    const cases: [string, unknown][] = [
      ["a bad sessionDid", { ...base, sessionDid: `did:key:z6Mk${HOSTILE}` }],
      ["a bad requestedExpiry", { ...base, requestedExpiry: `7d${HOSTILE}` }],
      ["a bad encryption action", {
        ...base,
        requested: [...base.requested, {
          service: "tinycloud.encryption", path: "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default", actions: [`decrypt${HOSTILE}`],
        }],
      }],
      ["a bad space name", { ...base, requested: [...base.requested, { service: "tinycloud.kv", space: `bad${HOSTILE}`, path: "", actions: ["get"] }] }],
      ["a service the signer cannot sign", { ...base, requested: [...base.requested, { service: `tinycloud.zzz${HOSTILE}`, space: "applications", path: "", actions: ["tinycloud.zzz/x"] }] }],
    ];
    for (const redirect of [false, true]) {
      for (const [name, artifact] of cases) {
        const label = `${name}${redirect ? " (stdout redirected, stderr a terminal)" : ""}`;
        const { exitCode, output } = await onPty(artifact, redirect);
        expect(exitCode, label).not.toBe(0);
        expect(output, label).not.toMatch(PAYLOAD);
        expect(output, label).toContain(redirect ? '"error"' : "✗");
        // the sessionDid and requestedExpiry are checked before anything is described: no scope text first
        if (name === "a bad sessionDid" || name === "a bad requestedExpiry") expect(output, label).not.toContain("asks for");
      }
    }

    // An encryption-only request without --yes reaches the signer's own message, which quotes the text:
    // a human error escapes it as \u{..}, the redirected JSON form as \uXXXX.
    const encryptionOnly = {
      ...base,
      requested: [{ service: "tinycloud.encryption", path: "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default", actions: [`decrypt${HOSTILE}`] }],
    };
    const human = await onPty(encryptionOnly, false, false);
    expect(human.output).not.toMatch(PAYLOAD);
    expect(human.output).toContain("\\u{202e}");
    const redirected = await onPty(encryptionOnly, true, false);
    expect(redirected.output).not.toMatch(PAYLOAD);
    expect(redirected.output).toContain("\\u202e");
    expect(redirected.output).toContain("\\u009b");
    expect(redirected.output).toContain("\\ufeff");
  }, 300_000);

  test("revocation ends a grant", async () => {
    await newAgent("revoked");
    const { cid } = await grantAgent("revoked", ["--preset", "apps-agent"]);
    expect((await cli("revoked", ["knowledge", "list"])).exitCode).toBe(0);

    expect((await cli("owner", ["delegation", "revoke", cid, "--yes"])).exitCode).toBe(0);
    const after = await cli("revoked", ["knowledge", "list"]);
    expect(after.exitCode).not.toBe(0);
    expect(after.error().code).toMatch(/AUTH_REQUIRED|PERMISSION_DENIED/);
  }, 120_000);
});
