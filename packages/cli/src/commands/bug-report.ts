import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stderr, stdin } from "node:process";
import { Command } from "commander";
import { CONFIG_DIR } from "../config/constants.js";
import { CLIError, handleError } from "../output/errors.js";
import { clearDiagnosticLogs, readDiagnosticLogs, redactDiagnosticLog } from "../lib/diagnostic-logs.js";

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
  if (useStdin && stdin.isTTY) throw new CLIError("BUG_REPORT_TOKEN_INPUT", "Give the attachment token by piping it to --token-stdin or setting TINYCLOUD_BUG_ATTACH_TOKEN.");
  const token = useStdin
    ? await new Promise<string>((resolve) => {
      const prompt = createInterface({ input: stdin });
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        prompt.close();
        resolve(value);
      };
      prompt.once("line", (line) => finish(line.trim()));
      prompt.once("close", () => finish(""));
    })
    : process.env.TINYCLOUD_BUG_ATTACH_TOKEN?.trim() ?? "";
  if (!token) throw new CLIError("BUG_REPORT_TOKEN_MISSING", useStdin
    ? "No attachment token came in on standard input."
    : "Give the attachment token by piping it to --token-stdin or setting TINYCLOUD_BUG_ATTACH_TOKEN.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CLIError("BUG_REPORT_TOKEN_INVALID", "That attachment token isn't valid. Use the one the bug report returned.");
  return token;
}

type ConfirmationIO = {
  write: (text: string) => void;
  question: () => Promise<string>;
};

export async function confirmUpload(summary: string, content: string, reportId: string, io?: ConfirmationIO): Promise<boolean> {
  if (!io && !stderr.isTTY) throw new CLIError("BUG_REPORT_CONFIRMATION_REQUIRED", "This needs your yes, so run it in a terminal where you can answer.");
  const input = io ? undefined : stdin.isTTY ? stdin : createReadStream(process.platform === "win32" ? "CONIN$" : "/dev/tty");
  const prompt = input ? createInterface({ input, output: stderr }) : undefined;
  const write = io?.write ?? ((text: string) => { stderr.write(text); });
  const question = io?.question ?? (() => prompt!.question(""));
  try {
    while (true) {
      write(`${summary}\nSend this CLI log to report ${reportId}? Type v to view it first. [y/N/v] `);
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
    invalid_attach_token: "That attachment token isn't valid or has expired. Trying again with it won't work.",
    attachment_limit: "This report already has five attachments, the most it can take.",
    payload_too_large: "The CLI log is larger than the bug service accepts.",
    unsupported_media_type: "The bug service didn't accept this upload's format. Updating the CLI may fix it.",
    rate_limited: "The bug service is still busy after one automatic retry. Try again in a few minutes.",
    intake_busy: "The bug service is full for now. Try again later, not right away; your CLI log stays on this computer.",
    too_deep: "The bug service didn't accept this upload. Updating the CLI may fix it.",
  };
  return new CLIError(`BUG_REPORT_${code.toUpperCase()}`, messages[code] ?? `The CLI log upload was rejected (${code}).`, undefined, { status });
}

async function attachLogs(reportId: string, tokenStdin: boolean, dependencies: BugReportDependencies): Promise<void> {
  const output = dependencies.write ?? ((text: string) => { stderr.write(text); });
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(reportId)) throw new CLIError("BUG_REPORT_ID_INVALID", "That isn't a report ID. Use the 26-character ID the bug report returned.");
  const token = await readToken(tokenStdin);
  const raw = await readDiagnosticLogs(dependencies.root ?? CONFIG_DIR);
  if (!raw.trim()) throw new CLIError("BUG_REPORT_LOGS_MISSING", "There's no recent CLI log to attach.");
  let source = tailBytes(raw, MAX_CONTENT_BYTES);
  let redacted = redactDiagnosticLog(source);
  const payload = { type: "cli-log", content: redacted.text, name: "tc-debug.log" };
  if (!payload.content.trim()) throw new CLIError("BUG_REPORT_LOGS_EMPTY", "Nothing is left to attach after sensitive values were removed.");
  let body = JSON.stringify(payload);
  while (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    const smaller = tailBytes(source, Math.floor(Buffer.byteLength(source) * 0.8));
    if (!smaller || smaller === source) throw new CLIError("BUG_REPORT_LOGS_TOO_LARGE", "The CLI log is too big to attach, even after trimming.");
    source = smaller;
    redacted = redactDiagnosticLog(source);
    payload.content = redacted.text;
    body = JSON.stringify(payload);
  }
  const bytes = Buffer.byteLength(body);
  const lines = payload.content.split(/\r?\n/).filter(Boolean).length;
  const lineLabel = lines === 1 ? "line" : "lines";
  const valueLabel = redacted.count === 1 ? "value" : "values";
  const summary = `Report ${reportId}: CLI log, ${bytes} bytes, ${lines} ${lineLabel}, ${redacted.count} ${valueLabel} hidden.`;
  const confirmed = await (dependencies.confirm ?? confirmUpload)(summary, payload.content, reportId);
  if (!confirmed) { output("Nothing was sent.\n"); return; }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const endpoint = dependencies.attachmentUrl ?? ATTACHMENT_URL;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchImpl(`${endpoint}/${reportId}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
    } catch {
      throw new CLIError("BUG_REPORT_UPLOAD_UNKNOWN", "Couldn't confirm the upload finished. You can try once more; the report may then get a second copy.");
    }
    if (response.status !== 429 || attempt > 0) break;
    await response.arrayBuffer();
    await sleep(60_000);
  }
  if (!response.ok) {
    const receipt = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
    const code = typeof receipt?.error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/i.test(receipt.error.code)
      ? receipt.error.code
      : `HTTP_${response.status}`;
    throw attachmentError(response.status, code);
  }
  const receipt = await response.json().catch(() => null) as { redactions?: Record<string, number> } | null;
  if (!receipt) {
    output(`Attached your CLI log to report ${reportId}. The server didn't say how many more values it hid.\n`);
    return;
  }
  const serverCount = Object.values(receipt.redactions ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  if (serverCount > 0) {
    const valueLabel = serverCount === 1 ? "value" : "values";
    output(`Attached your CLI log to report ${reportId}. The server hid ${serverCount} more ${valueLabel}.\n`);
  } else {
    output(`Attached your CLI log to report ${reportId}.\n`);
  }
}

export function registerBugReportCommand(program: Command, dependencies: BugReportDependencies = {}): void {
  const output = dependencies.write ?? ((text: string) => { stderr.write(text); });
  const root = dependencies.root ?? CONFIG_DIR;
  const command = program.command("bug-report")
    .description("Attach your recent CLI log to a bug report, with sensitive values removed where found")
    .option("--attach <report-id>", "Attach your recent CLI log to this report")
    .option("--token-stdin", "Read the attachment token from standard input")
    .option("--clear-logs", "Delete the CLI log saved on this computer");
  command.addHelpText("after", "\nThe CLI keeps a log of recent commands on this computer (up to 1 MB, readable only by your user account), with sensitive values removed where found. To stop recording, set TINYCLOUD_CLI_LOGS=0 or pass --no-diagnostic-logs. To delete it, run tinycloud bug-report --clear-logs.\n");
  command.action(async (options) => {
    try {
      if (options.clearLogs && options.attach) {
        throw new CLIError("BUG_REPORT_OPTIONS_CONFLICT", "Choose either --attach or --clear-logs; the CLI log was not changed.");
      }
      if (options.clearLogs) {
        await clearDiagnosticLogs(root);
        output("Deleted the CLI log on this computer.\n");
        return;
      }
      if (!options.attach) throw new CLIError("BUG_REPORT_USAGE", "Use `tinycloud bug-report --attach <report-id>` or `tinycloud bug-report --clear-logs`.");
      await attachLogs(options.attach, options.tokenStdin === true, dependencies);
    } catch (error) { return (dependencies.handleError ?? handleError)(error); }
  });
}
