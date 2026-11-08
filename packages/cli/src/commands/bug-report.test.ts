import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { appendDiagnosticLog, diagnosticLogPath } from "../lib/diagnostic-logs.js";
import { registerBugReportCommand } from "./bug-report.js";

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
      errorMessage: `failed for did:key:z6Mkabc123 and /home/sam/private, Bearer ${TOKEN}`,
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
      expect(summaries[0]).toContain("anonymized CLI diagnostics");
      expect(output.join("")).toContain("No attachment sent.");
    } finally {
      server.stop(true);
    }
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
      expect(payload.content).not.toContain(TOKEN);
      expect(summaries[0]).toContain("local redactions");
      expect(output.join("")).toContain("server redactions: 2");
    } finally {
      server.stop(true);
    }
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
  test("intake_busy stays pending for a later owner retry, without automatic resend", async () => {
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
          code: "BUG_REPORT_intake_busy",
          message: expect.stringContaining("Your local logs remain available"),
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
