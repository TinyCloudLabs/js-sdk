import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stderr, stdin } from "node:process";
import { Command } from "commander";
import { CONFIG_DIR } from "../config/constants.js";
import { CLIError, handleError } from "../output/errors.js";
import { clearDiagnosticLogs, readDiagnosticLogs, redactDiagnosticText } from "../lib/diagnostic-logs.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 128 * 1024;
const ATTACHMENT_URL = "https://bugs.tinycloud.xyz/reports";

type BugReportDependencies = {
  root?: string;
  attachmentUrl?: string;
  fetchImpl?: typeof fetch;
  confirm?: (summary: string, content: string) => Promise<boolean>;
  write?: (text: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  handleError?: (error: unknown) => Promise<never>;
};

async function readToken(useStdin: boolean): Promise<string> {
  if (useStdin && stdin.isTTY) throw new CLIError("BUG_REPORT_TOKEN_INPUT", "Pipe the attachment token to --token-stdin, or set TINYCLOUD_BUG_ATTACH_TOKEN.");
  const token = useStdin
    ? await (() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      const prompt = createInterface({ input: stdin });
      prompt.once("line", (line) => { prompt.close(); resolve(line.trim()); });
      prompt.once("close", () => resolve(""));
      return promise;
    })()
    : process.env.TINYCLOUD_BUG_ATTACH_TOKEN?.trim() ?? "";
  if (!token) throw new CLIError("BUG_REPORT_TOKEN_MISSING", useStdin
    ? "No attachment token was provided on stdin."
    : "Set TINYCLOUD_BUG_ATTACH_TOKEN or pass --token-stdin to provide the attachment token.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CLIError("BUG_REPORT_TOKEN_INVALID", "The attachment token has an invalid format.");
  return token;
}

type ConfirmationIO = {
  write: (text: string) => void;
  question: () => Promise<string>;
};

export async function confirmUpload(summary: string, content: string, io?: ConfirmationIO): Promise<boolean> {
  if (!io && !stderr.isTTY) throw new CLIError("BUG_REPORT_CONFIRMATION_REQUIRED", "Run this command in a terminal to review and confirm the CLI log.");
  const input = io ? undefined : stdin.isTTY ? stdin : createReadStream(process.platform === "win32" ? "CONIN$" : "/dev/tty");
  const prompt = input ? createInterface({ input, output: stderr }) : undefined;
  const write = io?.write ?? ((text: string) => { stderr.write(text); });
  const question = io?.question ?? (() => prompt!.question(""));
  try {
    while (true) {
      write(`${summary}\nSend this CLI log with sensitive values removed where found? [y/N/v to view] `);
      const answer = (await question()).trim().toLowerCase();
      if (answer === "v") {
        write(`\n--- CLI log ---\n${content}\n--- end CLI log ---\n`);
        continue;
      }
      return /^y(?:es)?$/i.test(answer);
    }
  } finally {
    prompt?.close();
    if (input && input !== stdin) input.destroy();
  }
}

function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const tail = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  const firstLine = tail.indexOf("\n");
  return firstLine < 0 ? "" : tail.slice(firstLine + 1);
}

function attachmentError(status: number, code: string): CLIError {
  const messages: Record<string, string> = {
    invalid_attach_token: "The attachment token is invalid or expired; do not retry with this token.",
    attachment_limit: "This report already has the maximum of five attachments.",
    payload_too_large: "The CLI log exceeded the service upload limit.",
    unsupported_media_type: "The attachment service rejected the request format.",
    rate_limited: "The attachment service is rate-limited; retry once after 60 seconds.",
    intake_busy: "The bug-report service is full; try again later, perhaps in a day or more. Your CLI log remains available locally.",
    too_deep: "The attachment request was rejected as invalid.",
  };
  return new CLIError(`BUG_REPORT_${code}`, messages[code] ?? `The CLI log upload was rejected (${code}).`, undefined, { status });
}

async function attachLogs(reportId: string, tokenStdin: boolean, dependencies: BugReportDependencies): Promise<void> {
  const output = dependencies.write ?? ((text: string) => { stderr.write(text); });
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(reportId)) throw new CLIError("BUG_REPORT_ID_INVALID", "Report ID must be 26 characters.");
  const token = await readToken(tokenStdin);
  const raw = await readDiagnosticLogs(dependencies.root ?? CONFIG_DIR);
  if (!raw.trim()) throw new CLIError("BUG_REPORT_LOGS_MISSING", "No recent CLI log was found.");
  let source = tailBytes(raw, MAX_CONTENT_BYTES);
  let redacted = redactDiagnosticText(source);
  const payload = { type: "cli-log", content: redacted.text, name: "tc-debug.log" };
  if (!payload.content.trim()) throw new CLIError("BUG_REPORT_LOGS_EMPTY", "The CLI log is empty after sensitive values were removed.");
  let body = JSON.stringify(payload);
  while (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    const smaller = tailBytes(source, Math.floor(Buffer.byteLength(source) * 0.8));
    if (!smaller || smaller === source) throw new CLIError("BUG_REPORT_LOGS_TOO_LARGE", "The CLI log could not be reduced to the upload limit.");
    source = smaller;
    redacted = redactDiagnosticText(source);
    payload.content = redacted.text;
    body = JSON.stringify(payload);
  }
  const bytes = Buffer.byteLength(body);
  const lines = payload.content.split(/\r?\n/).filter(Boolean).length;
  const summary = `Report ${reportId}: CLI log with sensitive values removed where found, ${bytes} bytes, ${lines} lines, ${redacted.count} local removals.`;
  const confirmed = await (dependencies.confirm ?? confirmUpload)(summary, payload.content);
  if (!confirmed) { output("No attachment sent.\n"); return; }


  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const endpoint = dependencies.attachmentUrl ?? ATTACHMENT_URL;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
  });
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchImpl(`${endpoint}/${reportId}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
    } catch {
      throw new CLIError("BUG_REPORT_UPLOAD_UNKNOWN", "Upload result is unknown; the attachment may have been saved, so do not retry automatically.");
    }
    if (response.status !== 429 || attempt > 0) break;
    await response.arrayBuffer();
    await sleep(60_000);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
    const code = typeof payload?.error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/i.test(payload.error.code)
      ? payload.error.code
      : `HTTP_${response.status}`;
    throw attachmentError(response.status, code);
  }
  const receipt = await response.json() as { redactions?: Record<string, number> };
  const serverCount = Object.values(receipt.redactions ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  output(`Attached CLI log to report ${reportId}. Sensitive values removed locally: ${redacted.count}; removed by server: ${serverCount}.\n`);
}

export function registerBugReportCommand(program: Command, dependencies: BugReportDependencies = {}): void {
  const output = dependencies.write ?? ((text: string) => { stderr.write(text); });
  const root = dependencies.root ?? CONFIG_DIR;
  const command = program.command("bug-report")
    .description("Attach a recent CLI log to a bug report")
    .option("--attach <report-id>", "Attach the recent CLI log to this report")
    .option("--token-stdin", "Read a piped attachment token from stdin")
    .option("--clear-logs", "Clear the local CLI log");
  command.addHelpText("after", "\nThe CLI log is kept locally (up to 1 MiB, owner-only); sensitive values are removed where found. Set TINYCLOUD_CLI_LOGS=0 or pass --no-cli-logs to disable collection; use --clear-logs to remove the log.\n");
  command.action(async (options) => {
    try {
      if (options.clearLogs) {
        await clearDiagnosticLogs(root);
        output("Local CLI log cleared.\n");
        return;
      }
      if (!options.attach) throw new CLIError("BUG_REPORT_USAGE", "Use `tinycloud bug-report --attach <report-id>` or `tinycloud bug-report --clear-logs`.");
      await attachLogs(options.attach, options.tokenStdin === true, dependencies);
    } catch (error) { return (dependencies.handleError ?? handleError)(error); }
  });
}
