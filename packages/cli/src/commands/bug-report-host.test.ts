import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { appendDiagnosticLog } from "../lib/diagnostic-logs.js";
import { registerBugReportCommand } from "./bug-report.js";

const REPORT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TOKEN = "C".repeat(43);
let root: string;
let oldToken: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tc-bug-report-host-"));
  oldToken = process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  process.env.TINYCLOUD_BUG_ATTACH_TOKEN = TOKEN;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (oldToken === undefined) delete process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  else process.env.TINYCLOUD_BUG_ATTACH_TOKEN = oldToken;
});

test("with no attachmentUrl override, the CLI log is posted to the feedback host", async () => {
  await appendDiagnosticLog({
    root,
    entry: {
      command: "auth login",
      args: ["--profile", "host@example.com"],
      exitCode: 7,
      errorCode: "AUTH_REQUIRED",
      errorMessage: "failed",
      cliVersion: "1.6.3-beta.6",
      nodeVersion: process.version,
      durationMs: 5,
    },
  });
  let requestUrl = "";
  const program = new Command();
  registerBugReportCommand(program, {
    root,
    confirm: async () => true,
    fetchImpl: async (input) => {
      requestUrl = String(input);
      return Response.json({ redactions: {} }, { status: 201 });
    },
    write: () => undefined,
    handleError: async (error: unknown): Promise<never> => { throw error; },
  });
  await program.parseAsync(["node", "tinycloud", "bug-report", "--attach", REPORT_ID], { from: "node" });
  expect(requestUrl).toBe(`https://feedback.tinycloud.xyz/reports/${REPORT_ID}/attachments`);
});
