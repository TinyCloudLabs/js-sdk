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

describe("tinycloud bug-report --attach", () => {
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
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async () => false,
      write: () => undefined,
    });
    try {
      await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });
  test("the owner can view the redacted CLI log before declining", async () => {
    const shown: string[] = [];
    const answers = ["v", "n"];
    let prompts = 0;
    const accepted = await confirmUpload("Report summary", "safe CLI log line", REPORT_ID, {
      write: (text) => shown.push(text),
      question: async () => { prompts += 1; return answers.shift() ?? ""; },
    });
    expect(accepted).toBe(false);
    expect(prompts).toBe(2);
    expect(shown.join("")).toContain("safe CLI log line");
  });
  test("summary includes the correct line and redaction counts", async () => {
    await appendDiagnosticLog({
      root,
      entry: {
        command: "kv list",
        args: ["--profile", "PrivateClient"],
        exitCode: 0,
        cliVersion: "1.6.3",
        nodeVersion: process.version,
        durationMs: 1,
      },
    });
    let summary = "";
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async (nextSummary: string) => { summary = nextSummary; return false; },
      write: () => undefined,
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    const counts = summary.replace(REPORT_ID, "").match(/\d+/g)?.map(Number);
    expect(counts?.slice(-2)).toEqual([1, 1]);
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
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      attachmentUrl: server.url.href + "reports",
      confirm: async () => true,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    try {
      await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
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
    } finally {
      server.stop(true);
    }
  });
  test("the default attachment host is feedback and uploaded log remains valid JSONL", async () => {
    await recordPrivateDiagnostic();
    let uploaded = "";
    let requestUrl = "";
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async (_summary: string, content: string) => { uploaded = content; return true; },
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return Response.json({ redactions: {} }, { status: 201 });
      },
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    expect(requestUrl).toBe(`https://feedback.tinycloud.xyz/reports/${REPORT_ID}/attachments`);
    const records = uploaded.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ command: "auth login", args: ["--profile=[REDACTED]", "--token=[REDACTED]"] });
    expect(records[0]?.localRedactions).toBeGreaterThan(0);
  });
  test("bug-report help exposes the command and option names", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../");
    const entry = resolve(repoRoot, "packages/cli/src/index.ts");
    const options = {
      cwd: repoRoot,
      env: { ...process.env, HOME: root, TC_HOME: root, TINYCLOUD_CLI_LOGS: "0" },
      encoding: "utf8" as const,
      timeout: 30_000,
    };
    const result = spawnSync(process.execPath, ["run", entry, "bug-report", "--help"], options);
    const help = `${result.stdout}${result.stderr}`.replace(/\s+/g, " ");
    expect(result.status).toBe(0);
    expect(help).toContain("bug-report [options]");
    expect(help).toContain("--attach <report-id>");
    expect(help).toContain("--token-stdin");
    expect(help).toContain("--clear-logs");

    const globalHelp = spawnSync(process.execPath, ["run", entry, "--help"], options);
    expect(globalHelp.status).toBe(0);
    expect(`${globalHelp.stdout}${globalHelp.stderr}`).toContain("--no-diagnostic-logs");
  });

  test.each([
    [null, "BUG_REPORT_TOKEN_MISSING"],
    ["bad", "BUG_REPORT_TOKEN_INVALID"],
  ] as const)("reports token input failures with the appropriate code (%s)", async (token, code) => {
    if (token === null) delete process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
    else process.env.TINYCLOUD_BUG_ATTACH_TOKEN = token;
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" }))
      .rejects.toMatchObject({ code });
  });
  test("rejects invalid IDs and missing logs with their error codes", async () => {
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", "not-a-report"], { from: "node" }))
      .rejects.toMatchObject({ code: "BUG_REPORT_ID_INVALID" });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" }))
      .rejects.toMatchObject({ code: "BUG_REPORT_LOGS_MISSING" });
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
      const disabled = spawnSync(process.execPath, ["run", entry, "--no-diagnostic-logs", "completion", "bash"], {
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
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => {
        requests += 1;
        return new Response("not-json", { status: 201 });
      },
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    expect(requests).toBe(1);
  });
  test("a successful upload with no server redactions completes once", async () => {
    await recordPrivateDiagnostic();
    let requests = 0;
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ redactions: {} }, { status: 201 });
      },
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    expect(requests).toBe(1);
  });
  test("reports the server-hidden value count", async () => {
    await recordPrivateDiagnostic();
    const output: string[] = [];
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => Response.json({ redactions: { email: 1 } }, { status: 201 }),
      write: (text: string) => output.push(text),
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
    const reportedCounts = output.join("").replace(REPORT_ID, "").match(/\d+/g)?.map(Number);
    expect(reportedCounts).toEqual([1]);
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
      await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
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
      await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" }))
        .rejects.toMatchObject({ code: "BUG_REPORT_INTAKE_BUSY" });
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
  test("a lost upload response warns that retrying may create a duplicate and is not automatic", async () => {
    await recordPrivateDiagnostic();
    let requests = 0;
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => { requests += 1; throw new Error("connection closed"); },
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" }))
      .rejects.toMatchObject({ code: "BUG_REPORT_UPLOAD_UNKNOWN" });
    expect(requests).toBe(1);
  });

  test.each([
    ["invalid_attach_token", 401, "BUG_REPORT_INVALID_ATTACH_TOKEN"],
    ["attachment_limit", 409, "BUG_REPORT_ATTACHMENT_LIMIT"],
    ["payload_too_large", 413, "BUG_REPORT_PAYLOAD_TOO_LARGE"],
    ["unsupported_media_type", 415, "BUG_REPORT_UNSUPPORTED_MEDIA_TYPE"],
    ["rate_limited", 429, "BUG_REPORT_RATE_LIMITED"],
    ["intake_busy", 503, "BUG_REPORT_INTAKE_BUSY"],
    ["too_deep", 400, "BUG_REPORT_TOO_DEEP"],
  ] as const)("maps API errors to CLI error codes (%s)", async (apiCode, status, code) => {
    await recordPrivateDiagnostic();
    const program = new Command();
    registerBugReportCommand(program, {
      root,
      confirm: async () => true,
      fetchImpl: async () => Response.json({ error: { code: apiCode } }, { status }),
      sleep: async () => undefined,
      write: () => undefined,
      handleError: async (error: unknown): Promise<never> => { throw error; },
    });
    await expect(program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" }))
      .rejects.toMatchObject({ code });
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
      await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
      expect(requestBytes).toBeGreaterThan(0);
      expect(requestBytes).toBeLessThanOrEqual(256 * 1024);
    } finally {
      server.stop(true);
    }
  });
});
