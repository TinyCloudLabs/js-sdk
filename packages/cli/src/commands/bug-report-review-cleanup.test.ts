import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { appendDiagnosticLog, diagnosticLogPath } from "../lib/diagnostic-logs.js";
import { registerBugReportCommand } from "./bug-report.js";

const REPORT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TOKEN = "B".repeat(43);
let root: string;
let oldToken: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tc-bug-report-cleanup-"));
  oldToken = process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  process.env.TINYCLOUD_BUG_ATTACH_TOKEN = TOKEN;
  await appendDiagnosticLog({
    root,
    entry: {
      command: "auth login",
      args: ["--profile", "cleanup@example.com"],
      exitCode: 7,
      errorCode: "AUTH_REQUIRED",
      errorMessage: "failed",
      cliVersion: "1.6.3-beta.6",
      nodeVersion: process.version,
      durationMs: 5,
    },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (oldToken === undefined) delete process.env.TINYCLOUD_BUG_ATTACH_TOKEN;
  else process.env.TINYCLOUD_BUG_ATTACH_TOKEN = oldToken;
});

async function run(args: string[], fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): Promise<string> {
  const output: string[] = [];
  const program = new Command();
  registerBugReportCommand(program, {
    root,
    interactive: false,
    fetchImpl,
    write: (text: string) => output.push(text),
    handleError: async (error: unknown): Promise<never> => { throw error; },
  });
  await program.parseAsync(["node", "tinycloud", "bug-report", ...args], { from: "node" });
  return output.join("");
}

async function stage(): Promise<{ path: string; hash: string }> {
  const receipt = await run(["--attach", REPORT_ID]);
  const path = / to (\S+) \(\d+ bytes/.exec(receipt)![1]!;
  const hash = /-([0-9a-f]{32})\.json$/.exec(path)![1]!;
  return { path, hash };
}

const created = async () => Response.json({ redactions: {} }, { status: 201 });

test("the saved review copy is deleted after a successful upload, so --confirm can't send twice", async () => {
  const { path, hash } = await stage();
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return created(); };
  await run(["--attach", REPORT_ID, "--confirm", hash], fetchImpl);
  expect(requests).toBe(1);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(run(["--attach", REPORT_ID, "--confirm", hash], fetchImpl)).rejects.toMatchObject({ code: "BUG_REPORT_REVIEW_MISSING" });
  expect(requests).toBe(1);
});

test("the saved review copy is kept when the server rejects the upload, so it can be retried", async () => {
  const { path, hash } = await stage();
  await expect(run(["--attach", REPORT_ID, "--confirm", hash], async () => Response.json({ error: { code: "server_error" } }, { status: 500 })))
    .rejects.toBeDefined();
  expect((await stat(path)).isFile()).toBe(true);
});

test("--clear-logs deletes the saved review copies along with the CLI log", async () => {
  await stage();
  expect(await readdir(join(root, "bug-report-reviews"))).toHaveLength(1);
  await run(["--clear-logs"]);
  await expect(stat(diagnosticLogPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(root, "bug-report-reviews"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("the owner-only mode check is skipped on Windows, where Node reports other modes, but still applies on POSIX", async () => {
  if (process.platform === "win32") return;
  const { hash, path } = await stage();
  await chmod(path, 0o644);
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return created(); };
  await expect(run(["--attach", REPORT_ID, "--confirm", hash], fetchImpl)).rejects.toMatchObject({ code: "BUG_REPORT_REVIEW_READ_FAILED" });
  expect(requests).toBe(0);

  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    await run(["--attach", REPORT_ID, "--confirm", hash], fetchImpl);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(requests).toBe(1);
});
