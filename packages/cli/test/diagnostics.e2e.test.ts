import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DiagnosticStore, reviewDiagnosticSnapshot } from "@tinycloud/operations/diagnostics";

const pkg = resolve(import.meta.dir, "..");
// Deliberately exclude all ambient profile, credential, test-server and loader settings.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "tc-diagnostic-cli-"));
  const root = join(home, "diagnostics");
  const env = { PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "profiles"), XDG_STATE_HOME: join(home, "state"), TC_DIAGNOSTICS_HOME: root, NO_COLOR: "1" };
  const cli = (args: string[], extra: Record<string, string> = {}, alias = "tc", input?: Buffer) => spawnSync("node", [join(pkg, "bin", alias), ...args], { env: { ...env, ...extra }, input, timeout: 15_000 });
  return { home, root, env, cli, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("built diagnostic CLI", () => {
  test("both aliases inspect disabled policy without creating profile or capture state", () => {
    const fixture = sandbox();
    try {
      for (const alias of ["tc", "tinycloud"]) {
        const result = fixture.cli(["--profile", "must-not-be-read", "diagnostics", "status", "--json"], {}, alias);
        expect(result.status).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(JSON.parse(result.stdout.toString()).enabled).toBe(false);
      }
      expect(existsSync(fixture.root)).toBe(false);
      expect(existsSync(fixture.env.TC_HOME)).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test("global help, version and invalid options never execute a diagnostic control", () => {
    const fixture = sandbox();
    try {
      for (const prefix of [["--help"], ["-h"], ["--version"], ["-V"], ["--invalid-option"], ["-x"]]) {
        const result = fixture.cli([...prefix, "diagnostics", "enable", "--scope", "tc-apps"]);
        expect(result.status).toBe(prefix[0] === "--invalid-option" || prefix[0] === "-x" ? 1 : 0);
        expect(existsSync(fixture.root)).toBe(false);
        expect(existsSync(fixture.env.TC_HOME)).toBe(false);
      }
      const enabled = fixture.cli(["--profile", "must-not-be-read", "--quiet", "diagnostics", "enable", "--scope", "tc-apps"]);
      expect(enabled.status).toBe(0);
      expect(JSON.parse(enabled.stdout.toString()).enabled).toBe(true);
      expect(existsSync(fixture.env.TC_HOME)).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test("direct parser exits preserve bytes and status across disabled, enabled and failed sinks", async () => {
    const fixture = sandbox();
    try {
      const context = JSON.stringify({ version: 1, scope: "tc-apps", run_id: randomUUID() });
      const args = ["kv", "get"];
      const off = fixture.cli(args, { TC_DIAGNOSTICS_CONTEXT: context });
      expect(off.status).not.toBe(0);
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      const on = fixture.cli(args, { TC_DIAGNOSTICS_CONTEXT: context });
      const file = join(fixture.home, "not-a-directory");
      writeFileSync(file, "synthetic");
      const broken = fixture.cli(args, { TC_DIAGNOSTICS_CONTEXT: context, TC_DIAGNOSTICS_HOME: file });
      for (const result of [on, broken]) {
        expect(result.status).toBe(off.status);
        expect(result.stdout).toEqual(off.stdout);
        expect(result.stderr).toEqual(off.stderr);
      }
      const snapshot = await new DiagnosticStore(fixture.root).snapshot({ all: true });
      expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
      expect(snapshot.events.find((event) => event.type === "invocation.finish")?.exit_code).toBe(off.status!);
      expect(snapshot.events.some((event) => event.activity === "parser" && event.outcome === "error")).toBe(true);
    } finally { fixture.cleanup(); }
  }, 30_000);

  for (const flag of ["--help", "--version"]) {
    test(`${flag} preserves business bytes and creates no profile with scoped capture`, async () => {
      const fixture = sandbox();
      try {
        const context = JSON.stringify({ version: 1, scope: "tc-apps", run_id: randomUUID() });
        const off = fixture.cli([flag], { TC_DIAGNOSTICS_CONTEXT: context });
        expect(off.status).toBe(0);
        expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
        const on = fixture.cli([flag], { TC_DIAGNOSTICS_CONTEXT: context });
        const file = join(fixture.home, "failed-history");
        writeFileSync(file, "synthetic");
        const failed = fixture.cli([flag], { TC_DIAGNOSTICS_CONTEXT: context, TC_DIAGNOSTICS_HOME: file });
        for (const result of [on, failed]) {
          expect(result.status).toBe(off.status);
          expect(result.signal).toBe(off.signal);
          expect(result.stdout).toEqual(off.stdout);
          expect(result.stderr).toEqual(off.stderr);
        }
        const snapshot = await new DiagnosticStore(fixture.root).snapshot({ all: true });
        expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
        expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
        expect(existsSync(fixture.env.TC_HOME)).toBe(false);
      } finally { fixture.cleanup(); }
    }, 30_000);
  }

  for (const fault of ["import_error", "signal"] as const) {
    test(`actual startup ${fault} retains native termination across disabled, enabled and failed capture`, async () => {
      const fixture = sandbox();
      try {
        const loader = join(fixture.home, "fault-loader.mjs");
        const register = join(fixture.home, "register-loader.mjs");
        const target = pathToFileURL(join(pkg, "dist", "index.js")).href;
        writeFileSync(loader, `export async function load(url, context, next) {
          if (url === ${JSON.stringify(target)}) {
            ${fault === "signal" ? `return { format: "module", shortCircuit: true, source: "process.kill(process.pid, 'SIGTERM');" };` : `throw new Error("synthetic_private_import_canary");`}
          }
          return next(url, context);
        }`, { mode: 0o600 });
        writeFileSync(register, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(loader).href)});`, { mode: 0o600 });
        const env = {
          NODE_OPTIONS: `--import=${register}`,
          TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps", run_id: randomUUID() }),
        };
        const off = fixture.cli(["kv", "get"], env);
        expect(off.error).toBeUndefined();
        if (fault === "signal") expect(off.signal).toBe("SIGTERM");
        else expect(off.status).toBe(1);
        expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
        const on = fixture.cli(["kv", "get"], env);
        const file = join(fixture.home, "failed-history");
        writeFileSync(file, "synthetic");
        const failed = fixture.cli(["kv", "get"], { ...env, TC_DIAGNOSTICS_HOME: file });
        for (const result of [on, failed]) {
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(off.status);
          expect(result.signal).toBe(off.signal);
          expect(result.stdout).toEqual(off.stdout);
          expect(result.stderr).toEqual(off.stderr);
        }
        const snapshot = await new DiagnosticStore(fixture.root).snapshot({ all: true });
        if (fault === "signal") {
          // Native signal death is not intercepted to fabricate a completed
          // invocation; even the early evidence is best effort.
          expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toEqual([]);
        } else {
          expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
          expect(snapshot.events.some((event) => event.phase === "import" && event.outcome === "error")).toBe(true);
        }
        expect(JSON.stringify(snapshot)).not.toContain("synthetic_private_import_canary");
        expect(existsSync(fixture.env.TC_HOME)).toBe(false);
      } finally { fixture.cleanup(); }
    });
  }

  test("run linkage alone and unrelated KV targets leave no history; validated app targets activate late", async () => {
    const fixture = sandbox();
    try {
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      const linkage = JSON.stringify({ version: 1, run_id: randomUUID() });
      fixture.cli(["--json", "kv", "get", "unrelated/synthetic"], { TC_DIAGNOSTICS_CONTEXT: linkage });
      fixture.cli(["--help"], { TC_DIAGNOSTICS_CONTEXT: linkage });
      fixture.cli(["--json", "kv", "get", "xyz.tinycloud.agent-data/invalid key"], { TC_DIAGNOSTICS_CONTEXT: linkage });
      const store = new DiagnosticStore(fixture.root);
      expect((await store.snapshot({ all: true })).events).toEqual([]);
      const result = fixture.cli(["--json", "kv", "get", "xyz.tinycloud.agent-data/synthetic"], { TC_DIAGNOSTICS_CONTEXT: linkage });
      expect(result.status).not.toBe(0);
      const snapshot = await store.snapshot({ all: true });
      expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
      expect(snapshot.events.every((event) => event.run_id === JSON.parse(linkage).run_id)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("xyz.tinycloud.agent-data");
      expect(JSON.stringify(snapshot)).not.toContain("synthetic");
    } finally { fixture.cleanup(); }
  }, 30_000);

  test("run preserves binary streams, child exit and signal death, and removes inherited scope", () => {
    const fixture = sandbox();
    try {
      const context = JSON.stringify({ version: 1, scope: "tc-apps", role: "copy", task_id: randomUUID() });
      const script = "const c=JSON.parse(process.env.TC_DIAGNOSTICS_CONTEXT);if(c.scope!==undefined||c.role!==undefined||!c.run_id||!c.task_id)process.exit(99);process.stdin.pipe(process.stdout);process.stderr.write(Buffer.from([0,255,10]));process.stdin.on('end',()=>process.exitCode=17)";
      const input = Buffer.from([0, 255, 13, 10, 65]);
      const result = fixture.cli(["diagnostics", "run", "--", "node", "-e", script], { TC_DIAGNOSTICS_CONTEXT: context }, "tc", input);
      expect(result.status).toBe(17);
      expect(result.stdout).toEqual(input);
      expect(result.stderr).toEqual(Buffer.from([0, 255, 10]));
      const scoped = fixture.cli(["diagnostics", "run", "--scope", "tc-apps", "--", "node", "-e", "process.exit(JSON.parse(process.env.TC_DIAGNOSTICS_CONTEXT).scope==='tc-apps'?0:99)"]);
      expect(scoped.status).toBe(0);
      const signalled = fixture.cli(["diagnostics", "run", "--", "node", "-e", "process.kill(process.pid,'SIGTERM')"]);
      expect(signalled.signal).toBe("SIGTERM");
      expect(existsSync(fixture.root)).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test("selected blocks retain client attribution without marking parents, siblings or unrelated failures", async () => {
    const fixture = sandbox();
    try {
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      const inherited = { version: 1, run_id: randomUUID(), task_id: randomUUID(), turn_id: randomUUID(),
        adapter: "opencode_v1", adapter_revision: 1, client_version: "1.18.31" };
      const block = `
        const {spawnSync}=require("node:child_process"),cli=process.argv[1];
        const context=JSON.parse(process.env.TC_DIAGNOSTICS_CONTEXT);
        const failed=spawnSync(process.execPath,[cli,"kv","get"],{encoding:"utf8"});
        const nested=spawnSync(process.execPath,[cli,"diagnostics","run","--scope","tc-apps","--",process.execPath,"-e","process.stdout.write(process.env.TC_DIAGNOSTICS_CONTEXT)"],{encoding:"utf8"});
        if(nested.status!==0)process.exit(98);
        process.stdout.write(JSON.stringify({context,nested:JSON.parse(nested.stdout),failure:failed.status}));
      `;
      const parent = `
        const {spawnSync}=require("node:child_process"),cli=process.argv[1],block=process.argv[2],before=process.env.TC_DIAGNOSTICS_CONTEXT;
        const selected=[];
        for(let i=0;i<2;i++){const child=spawnSync(process.execPath,[cli,"diagnostics","run","--scope","tc-apps","--role","copy","--",process.execPath,"-e",block,cli],{encoding:"utf8"});if(child.status!==0)process.exit(97);selected.push(JSON.parse(child.stdout));}
        for(const args of [["kv","get"],["kv","get","unrelated/synthetic"],["--profile","absent","auth","status"]])spawnSync(process.execPath,[cli,...args],{encoding:"utf8"});
        process.stdout.write(JSON.stringify({selected,unchanged:process.env.TC_DIAGNOSTICS_CONTEXT===before,parent:JSON.parse(before)}));
      `;
      const result = spawnSync("node", ["-e", parent, join(pkg, "bin", "tc"), block], {
        env: { ...fixture.env, TC_DIAGNOSTICS_CONTEXT: JSON.stringify(inherited) }, timeout: 30_000, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.unchanged).toBe(true);
      expect(report.parent.scope).toBeUndefined();
      expect(report.selected[0].context.workflow_id).not.toBe(report.selected[1].context.workflow_id);
      for (const selected of report.selected) {
        expect(selected.failure).not.toBe(0);
        expect(selected.context).toMatchObject({ ...inherited, scope: "tc-apps", role: "copy" });
        expect(selected.nested).toMatchObject({ ...inherited, scope: "tc-apps", workflow_id: selected.context.workflow_id });
      }
      const snapshot = await new DiagnosticStore(fixture.root).snapshot({ all: true });
      expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(2);
      expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(2);
      expect(snapshot.events.every((event) => event.run_id === inherited.run_id && event.task_id === inherited.task_id && event.turn_id === inherited.turn_id)).toBe(true);
      expect(snapshot.descriptors.every((descriptor) => descriptor.adapter === "opencode_v1" && descriptor.client_version === "1.18.31" && descriptor.client_trust === "client_reported")).toBe(true);
    } finally { fixture.cleanup(); }
  }, 40_000);

  test("actual paste EOF remains an owner handoff across disabled, enabled and failed capture", async () => {
    const fixture = sandbox();
    try {
      const profile = "synthetic-handoff-canary";
      expect(fixture.cli(["init", "--name", profile, "--key-only"]).status).toBe(0);
      const guard = join(fixture.home, "deny-network.cjs");
      writeFileSync(guard, `function deny(){throw new Error("network_disabled_in_synthetic_paste_fixture");}globalThis.fetch=deny;for(const name of ["node:http","node:https"]){const module=require(name);module.request=deny;module.get=deny;}`, { mode: 0o600 });
      const context = { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps" }), NODE_OPTIONS: `--require=${guard}` };
      const args = ["--json", "--profile", profile, "auth", "login", "--method", "openkey", "--paste"];
      const off = fixture.cli(args, context);
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      const on = fixture.cli(args, context);
      const failed = join(fixture.home, "failed-sink");
      writeFileSync(failed, "synthetic", { mode: 0o600 });
      const broken = fixture.cli(args, { ...context, TC_DIAGNOSTICS_HOME: failed });
      for (const result of [off, on, broken]) {
        expect(result.status).toBe(3);
        expect(result.stdout).toEqual(off.stdout);
        const stderr = result.stderr.toString();
        expect(JSON.parse(stderr.slice(stderr.indexOf("{"))).error.code).toBe("PASTE_CODE_MISSING");
      }
      const snapshot = await new DiagnosticStore(fixture.root).snapshot({ all: true });
      const review = reviewDiagnosticSnapshot(snapshot);
      expect(review.invocations).toHaveLength(1);
      expect(review.invocations[0]).toMatchObject({ start: "observed", finish: "observed", business: "awaiting_owner", mutation: "unknown" });
      expect(snapshot.events.some((event) => event.phase === "approval_commit" || event.type === "attempt.start")).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain(profile);
      expect(JSON.stringify(snapshot)).not.toContain("PASTE_CODE_MISSING");
      expect(JSON.stringify(snapshot)).not.toMatch(/https?:\/\//);
    } finally { fixture.cleanup(); }
  }, 30_000);

  test("SQL scope uses the exact accepted database, never SQL text or a lookalike name", async () => {
    const fixture = sandbox();
    try {
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      fixture.cli(["--json", "sql", "query", "SELECT 'xyz.tinycloud.agent-data.index'", "--db", "unrelated"]);
      fixture.cli(["--json", "sql", "query", "SELECT 1", "--db", "xyz.tinycloud.agent-data.index-sibling"]);
      const store = new DiagnosticStore(fixture.root);
      expect((await store.snapshot({ all: true })).events).toEqual([]);
      const result = fixture.cli(["--json", "sql", "query", "SELECT 1", "--db", "xyz.tinycloud.agent-data.index"]);
      expect(result.status).not.toBe(0);
      const snapshot = await store.snapshot({ all: true });
      expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toContain("SELECT");
    } finally { fixture.cleanup(); }
  }, 30_000);

  test("export/import and review stay local; delete previews and requires an explicit all-capture decision", async () => {
    const fixture = sandbox();
    const recipient = sandbox();
    try {
      expect(fixture.cli(["diagnostics", "enable", "--scope", "tc-apps"]).status).toBe(0);
      fixture.cli(["--help"], { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps" }) });
      expect(fixture.cli(["diagnostics", "pause"]).status).toBe(0);
      const selection = join(fixture.home, "selection.json");
      writeFileSync(selection, JSON.stringify({ all: true }), { mode: 0o600 });
      const destination = join(fixture.root, "exports", randomUUID());
      const expires = new Date(Date.now() + 60_000).toISOString();
      const exported = fixture.cli(["diagnostics", "export", "--selection", selection, "--out", destination, "--expires-at", expires]);
      expect(exported.status, exported.stderr.toString()).toBe(0);
      const imported = recipient.cli(["diagnostics", "import", JSON.parse(exported.stdout.toString()).path]);
      expect(imported.status, imported.stderr.toString()).toBe(0);
      const reviewed = recipient.cli(["diagnostics", "review", "--selection", selection, "--json"]);
      expect(reviewed.status, reviewed.stderr.toString()).toBe(0);
      expect(existsSync(recipient.env.TC_HOME)).toBe(false);
      const store = new DiagnosticStore(fixture.root);
      const before = await store.snapshot({ all: true });
      expect(before.events.some((event) => event.type === "invocation.finish")).toBe(true);
      const preview = fixture.cli(["diagnostics", "delete", "--selection", selection]);
      expect(JSON.parse(preview.stdout.toString()).preview).toBe(true);
      expect((await store.snapshot({ all: true })).events).toEqual(before.events);
      expect(fixture.cli(["diagnostics", "delete", "--selection", selection, "--confirm"]).status).not.toBe(0);
      expect((await store.snapshot({ all: true })).events).toEqual(before.events);
      const removed = fixture.cli(["diagnostics", "delete", "--selection", selection, "--confirm", "--pause-after"]);
      expect(removed.status, removed.stderr.toString()).toBe(0);
      expect((await store.snapshot({ all: true })).events).toEqual([]);
      expect((await store.status()).paused).toBe(true);
    } finally { fixture.cleanup(); recipient.cleanup(); }
  }, 30_000);

  test("real loopback put and independent raw read-back retain business parity and private review evidence", () => {
    const fixture = sandbox();
    try {
      const result = spawnSync("bun", [join(pkg, "test-support", "diagnostics-kv-smoke.ts")], {
        env: { ...fixture.env, ...(process.env.TC_DIAGNOSTICS_TEST_WRAPPER ? { TC_DIAGNOSTICS_TEST_WRAPPER: process.env.TC_DIAGNOSTICS_TEST_WRAPPER } : {}) },
        timeout: 180_000, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split("\n")[0]).toBe("diagnostic-kv-parity-ok");
    } finally { fixture.cleanup(); }
  }, 190_000);
});
