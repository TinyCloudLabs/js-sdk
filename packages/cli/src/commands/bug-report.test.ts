import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { appendDiagnosticLog, diagnosticLogPath, readDiagnosticLogs } from "../lib/diagnostic-logs.js";
import { confirmUpload, registerBugReportCommand } from "./bug-report.js";

const REPORT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TOKEN = "A".repeat(43);
let root: string;
let oldToken: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tc-bug-report-"));
  oldToken = process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  process.env.TINYCLOUD_BUG_ATTACH_TOKEN = TOKEN;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (oldToken === undefined) delete process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  else process.env.TINYCLOUD_BUG_ATTACH_TOKEN = oldToken;
});

async function recordPrivateDiagnostic(): Promise<void> {
  await appendDiagnosticLog({
    root,
    entry: {
      command: "auth login",
      args: ["--profile", "sam@example.com", "--token", TOKEN],
      exitCode: 7,
      errorCode: "AUTH_REQUIRED",
      errorMessage: `failed for did:key:z6Mkabc123 and /home/sam/private, Bearer ${TOKEN}; create with tc init --key-only --name PrivateClient`,
      cliVersion: "1.6.3-beta.6",
      nodeVersion: process.version,
      durationMs: 123,
    },
  });
}

describe("tc bug-report --attach", () => {
  test("a declined confirmation sends no request and does not expose local secrets", async () => {
    await recordPrivateDiagnostic();
    const stored = await readFile(diagnosticLogPath(root), "utf8");
    expect(stored).not.toContain("sam@example.com");
    expect(stored).not.toContain("did:key:z6Mkabc123");
    expect(stored).not.toContain("/home/sam");
    expect(stored).not.toContain("PrivateClient");
    expect(stored).not.toContain(TOKEN);

    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => { requests += 1; return Response.json({}); },
    });
    const summaries: string[] = [];
    const output: string[] = [];
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async (summary: string) => { summaries.push(summary); return false; },
      write: (text: string) => output.push(text),
    });
    try {
      await program.parseAsync(["node", "tc", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requests).toBe(0);
      expect(summaries[0]).toContain("sensitive values removed where found");
      expect(output.join("")).toContain("No attachment sent.");
    } finally {
      server.stop(true);
    }
  });
  test("the owner can view the redacted CLI log before declining", async () => {
    const shown: string[] = [];
    const answers = ["v", "n"];
    const accepted = await confirmUpload("Report summary", "safe CLI log line", {
      write: (text) => shown.push(text),
      question: async () => answers.shift() ?? "",
    });
    expect(accepted).toBe(false);
    expect(shown.join("")).toContain("--- CLI log ---\nsafe CLI log line\n--- end CLI log ---");
    expect(shown.join("")).toContain("sensitive values removed where found");
  });


  test("an approved attachment posts only redacted log text with the bearer token", async () => {
    await recordPrivateDiagnostic();
    let requestBody = "";
    let requestPath = "";
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestPath = new URL(request.url).pathname;
        authorization = request.headers.get("authorization");
        requestBody = await request.text();
        return Response.json({ report_id: REPORT_ID, attachment_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", redactions: { emails: 1, paths: 1 } }, { status: 201 });
      },
    });
    const summaries: string[] = [];
    const output: string[] = [];
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async (summary: string) => { summaries.push(summary); return true; },
      write: (text: string) => output.push(text),
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    try {
      await program.parseAsync(["node", "tc", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requestPath).toBe(`/reports/${REPORT_ID}/attachments`);
      expect(authorization).toBe(`Bearer ${TOKEN}`);
      expect(Buffer.byteLength(requestBody)).toBeLessThanOrEqual(256 * 1024);
      const payload = JSON.parse(requestBody) as { type: string; content: string; name: string };
      expect(payload).toMatchObject({ type: "cli-log", name: "tc-debug.log" });
      expect(payload.content).toContain("AUTH_REQUIRED");
      expect(payload.content).not.toContain("sam@example.com");
      expect(payload.content).not.toContain("did:key:z6Mkabc123");
      expect(payload.content).not.toContain("/home/sam");
      expect(payload.content).not.toContain("PrivateClient");
      expect(payload.content).not.toContain(TOKEN);
      expect(output.join("")).toContain("removed by server: 2");
    } finally {
      server.stop(true);
    }
  });
  test("the uploaded CLI log remains valid JSONL after the attachment redaction pass", async () => {
    await recordPrivateDiagnostic();
    let uploaded = "";
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: "https://bugs.tinycloud.xyz/reports",
      confirm: async (_summary: string, content: string) => { uploaded = content; return true; },
      fetchImpl: async () => Response.json({ redactions: {} }, { status: 201 }),
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    const records = uploaded.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ command: "auth login", args: ["--profile=[REDACTED]", "--token=[REDACTED]"] });
    expect(records[0]?.localRedactions).toBeGreaterThan(0);
  });

  test("bug-report clear does not recreate logs or require a profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-bug-report-home-"));
    const tcHome = await mkdtemp(join(tmpdir(), "tc-bug-report-state-"));
    const logRoot = join(tcHome, ".tinycloud");
    try {
      await appendDiagnosticLog({ root: logRoot, entry: {
        command: "kv get", args: [], exitCode: 0, cliVersion: "1.2.3", nodeVersion: process.version, durationMs: 1,
      } });
      const repoRoot = resolve(import.meta.dir, "../../../../");
      const result = spawnSync(process.execPath, ["run", resolve(repoRoot, "packages/cli/src/index.ts"), "bug-report", "--clear-logs"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, TC_HOME: tcHome, TINYCLOUD_CLI_LOGS: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("No profile configured.");
      expect(await readDiagnosticLogs(logRoot)).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(tcHome, { recursive: true, force: true });
    }
  });
  test("the CLI records the actual successful command name", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-cli-log-home-"));
    const tcHome = await mkdtemp(join(tmpdir(), "tc-cli-log-state-"));
    const logRoot = join(tcHome, ".tinycloud");
    try {
      const repoRoot = resolve(import.meta.dir, "../../../../");
      const entry = resolve(repoRoot, "packages/cli/src/index.ts");
      const result = spawnSync(process.execPath, ["run", entry, "completion", "bash"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, TC_HOME: tcHome, TINYCLOUD_CLI_LOGS: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      const beforeOptOut = await readDiagnosticLogs(logRoot);
      const records = beforeOptOut.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { command: string });
      expect(records).toHaveLength(1);
      expect(records[0]?.command).toBe("completion bash");
      const disabled = spawnSync(process.execPath, ["run", entry, "--no-cli-logs", "completion", "bash"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, TC_HOME: tcHome, TINYCLOUD_CLI_LOGS: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(disabled.status).toBe(0);
      expect(await readDiagnosticLogs(logRoot)).toBe(beforeOptOut);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(tcHome, { recursive: true, force: true });
    }
  });
  test("ordinary CLI commands do not revive the dormant first-run warning", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-cli-warning-home-"));
    const tcHome = await mkdtemp(join(tmpdir(), "tc-cli-warning-state-"));
    try {
      if (process.platform === "win32") return;
      const repoRoot = resolve(import.meta.dir, "../../../../");
      const entry = resolve(repoRoot, "packages/cli/src/index.ts");
      const result = spawnSync("script", ["-qec", `${process.execPath} run ${entry} context`, "/dev/null"], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, TC_HOME: tcHome },
        encoding: "utf8",
        timeout: 30_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("PROFILE_NOT_FOUND");
      expect(output).not.toContain("No profile configured.");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(tcHome, { recursive: true, force: true });
    }
  });


  test("a malformed 201 receipt is still reported as a completed upload", async () => {
    await recordPrivateDiagnostic();
    let requests = 0;
    const output: string[] = [];
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => {
        requests += 1;
        return new Response("not-json", { status: 201 });
      },
      write: (text: string) => output.push(text),
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    expect(requests).toBe(1);
    expect(output.join("")).toContain("Attached CLI log");
    expect(output.join("")).toContain("Server removal count unavailable");
  });

  test("attach and clear options refuse without deleting the local log", async () => {
    await recordPrivateDiagnostic();
    const original = await readDiagnosticLogs(root);
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      write: () => undefined,
      fetchImpl: async () => { throw new Error("must not upload"); },
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID, "--clear-logs"], { from: "node" }))
      .rejects.toMatchObject({ code: "BUG_REPORT_OPTIONS_CONFLICT" });
    expect(await readDiagnosticLogs(root)).toBe(original);
  });


  test("a 429 response retries once after sixty seconds", async () => {
    await recordPrivateDiagnostic();
    let requests = 0;
    const delays: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return requests === 1
          ? Response.json({ error: { code: "rate_limited" } }, { status: 429 })
          : Response.json({ redactions: {} }, { status: 201 });
      },
    });
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async () => true,
      write: () => undefined,
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    try {
      await program.parseAsync(["node", "tc", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requests).toBe(2);
      expect(delays).toEqual([60_000]);
    } finally {
      server.stop(true);
    }
  });
  test("intake_busy stays available locally for a later owner retry, without automatic resend", async () => {
    await recordPrivateDiagnostic();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({ error: { code: "intake_busy" } }, { status: 503 });
      },
    });
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async () => true,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    try {
      await expect(program.parseAsync(["node", "tc", "bug-report", "--attach", REPORT_ID], { from: "node" }))
        .rejects.toMatchObject({
          code: "BUG_REPORT_INTAKE_BUSY",
          message: expect.stringContaining("CLI log remains available locally"),
        });
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
  test("the serialized attachment body stays within the API byte limit", async () => {
    for (let index = 0; index < 24; index += 1) {
      await appendDiagnosticLog({
        root,
        entry: {
          command: "auth login",
          args: [],
          exitCode: 1,
          errorCode: "AUTH_REQUIRED",
          errorMessage: "\n".repeat(10_000),
          cliVersion: "1.6.3-beta.6",
          nodeVersion: process.version,
          durationMs: index,
        },
      });
    }
    let requestBytes = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestBytes = Buffer.byteLength(await request.text());
        return Response.json({ redactions: {} }, { status: 201 });
      },
    });
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async () => true,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    try {
      await program.parseAsync(["node", "tc", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requestBytes).toBeGreaterThan(0);
      expect(requestBytes).toBeLessThanOrEqual(256 * 1024);
    } finally {
      server.stop(true);
    }
  });
});
