import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rm, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE_NAME = "cli-diagnostics.jsonl";
const MAX_BYTES = 1024 * 1024;
let activeCommand: string | undefined;
let activeArgs: string[] = [];
let activeDisabled = false;
let activeCliVersion = "unknown";
let activeStartedAt = Date.now();

export function setDiagnosticCommandContext(options: {
  command: string;
  args: readonly string[];
  disabled: boolean;
  cliVersion: string;
}): void {
  activeCommand = options.command;
  activeArgs = [...options.args];
  activeDisabled = options.disabled;
  activeCliVersion = options.cliVersion;
  activeStartedAt = Date.now();
}

type DiagnosticEntry = {
  command: string;
  args: string[];
  exitCode: number;
  errorCode?: string;
  errorMessage?: string;
  cliVersion: string;
  nodeVersion: string;
  durationMs: number;
};

export function redactDiagnosticText(input: string): { text: string; count: number } {
  let text = input;
  let count = 0;
  const replace = (pattern: RegExp, replacement: string | ((...matches: string[]) => string)) => {
    text = text.replace(pattern, (...matches) => {
      count += 1;
      return typeof replacement === "string" ? replacement : replacement(...matches);
    });
  };
  replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "[ANSI_REMOVED]");
  replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@[^\s"'`]+/g, (_match, scheme) => `${scheme}[REDACTED_URL]`);
  replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "[REDACTED_TOKEN]");
  replace(/\b(?:token|api[_-]?key|secret|password|private[_-]?key|authorization)\b(\s*[=:]\s*)(?!(?:["'`])?\[REDACTED(?:_[A-Z]+)?\](?:["'`])?)(?:"[^"]*"|'[^']*'|`[^`]*`|[^,\s}\]]+)/gi, (_match, separator) => `${separator}"[REDACTED_SECRET]"`);
  replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED_SECRET]");
  replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, "[REDACTED_KEY]");
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  replace(/\bdid:[a-z0-9]+:[A-Za-z0-9._:%-]+/gi, "[REDACTED_DID]");
  replace(/\b0x[a-f0-9]{40}\b/gi, "[REDACTED_ADDRESS]");
  replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]");
  replace(/\b(?!(?:127\.|0\.0\.0\.0))(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[REDACTED_ADDRESS]");
  replace(/(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s"'`]+(?:[/\\][^\\\s"'`,}\]]+)*/g, "[REDACTED_PATH]");
  replace(/(--(?:profile|space|user|owner|account|key|name)(?:=|\s+))(?!(?:["'`])?\[REDACTED(?:_[A-Z]+)?\](?:["'`])?)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi, (_match, prefix) => `${prefix}"[REDACTED_NAME]"`);
  replace(/\b(profile|space|user|owner|account|key|name)\s*(?:name)?\s*([:=]\s*)(?!(?:["'`])?\[REDACTED(?:_[A-Z]+)?\](?:["'`]?))[^\s,"'`}]+["'`]?/gi, (_match, label, separator) => `${label}${separator}"[REDACTED_NAME]"`);
  replace(/\b(profile|space|user|owner|account|key)(?:\s+name)?\s+(?:is\s+)?(?!["'`]\[REDACTED(?:_[A-Z]+)?\]["'`])["'`]([^"'`]+)["'`]/gi, (_match, label) => `${label} "[REDACTED_NAME]"`);
  replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|z[1-9A-HJ-NP-Za-km-z]{30,}|[A-Za-z0-9_-]{32,})\b/g, "[REDACTED_OPAQUE]");
  replace(/("(?:name|fullName|user|owner)"\s*:\s*)(?!\[REDACTED(?:_[A-Z]+)?\])"[^"]*"/gi, (_match, prefix) => `${prefix}"[REDACTED_NAME]"`);
  return { text, count };
}

export function redactDiagnosticLog(input: string): { text: string; count: number } {
  let count = 0;
  const lines: string[] = [];
  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactDiagnosticText(value);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.localRedactions === "number" && Number.isFinite(record.localRedactions)) {
        count += Math.max(0, record.localRedactions);
      }
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, redactValue(child)]));
    }
    return value;
  };
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.stringify(redactValue(JSON.parse(line))));
    } catch {
      count += 1;
      lines.push(JSON.stringify({ message: "Malformed CLI log entry omitted", localRedactions: 1 }));
    }
  }
  return { text: `${lines.join("\n")}${input.endsWith("\n") && lines.length ? "\n" : ""}`, count };
}

function redactArgs(args: readonly string[]): { values: string[]; count: number } {
  const values: string[] = [];
  let count = 0;
  const booleanFlags = new Set(["--quiet", "-q", "--verbose", "-v", "--json", "--no-cache", "--no-retry", "--replication", "--no-replication", "--replication-debug", "--no-cli-logs"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    const shortFlag = /^-[A-Za-z]/.exec(arg)?.[0];
    if (shortFlag && arg.length > shortFlag.length) {
      values.push(`${shortFlag}=[REDACTED]`);
      count += 1;
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (equals >= 0) {
      values.push(`${flag}=[REDACTED]`);
      count += 1;
      continue;
    }
    if (booleanFlags.has(arg)) {
      values.push(arg);
      continue;
    }
    const next = args[index + 1];
    if (next && next !== "--" && !booleanFlags.has(next)) {
      values.push(`${arg}=[REDACTED]`);
      count += 1;
      index += 1;
    } else values.push(arg);
  }
  return { values, count };
}

export function redactDiagnosticEntry(entry: DiagnosticEntry): DiagnosticEntry & { localRedactions: number } {
  const command = redactDiagnosticText(entry.command);
  const args = redactArgs(entry.args);
  const errorCode = entry.errorCode ? redactDiagnosticText(entry.errorCode) : undefined;
  const errorMessage = entry.errorMessage ? redactDiagnosticText(entry.errorMessage) : undefined;
  return {
    command: command.text,
    args: args.values,
    exitCode: entry.exitCode,
    ...(errorCode ? { errorCode: errorCode.text } : {}),
    ...(errorMessage ? { errorMessage: errorMessage.text } : {}),
    cliVersion: entry.cliVersion,
    nodeVersion: entry.nodeVersion,
    durationMs: entry.durationMs,
    localRedactions: command.count + args.count + (errorCode?.count ?? 0) + (errorMessage?.count ?? 0),
  };
}

export async function recordDiagnosticFailure(error: {
  code: string;
  message: string;
  exitCode: number;
}, root: string): Promise<void> {
  if (!activeCommand || activeCommand === "bug-report" || activeDisabled || process.env.TINYCLOUD_CLI_LOGS === "0") return;
  await appendDiagnosticLog({
    root,
    entry: {
      command: activeCommand,
      args: activeArgs,
      exitCode: error.exitCode,
      errorCode: error.code,
      errorMessage: error.message,
      cliVersion: activeCliVersion,
      nodeVersion: process.version,
      durationMs: Date.now() - activeStartedAt,
    },
  });
}


export async function appendDiagnosticLog(options: {
  root: string;
  entry: DiagnosticEntry;
  maxBytes?: number;
  disabled?: boolean;
}): Promise<void> {
  if (options.disabled) return;
  const maximum = options.maxBytes ?? MAX_BYTES;
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const path = join(options.root, FILE_NAME);
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...redactDiagnosticEntry(options.entry) })}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes >= maximum) return;
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error("Diagnostic log path is not a regular file.");
    if (current.size + lineBytes > maximum) {
      const old = await readFile(path);
      const tail = old.subarray(Math.max(0, old.length - Math.floor(maximum / 2)));
      const firstNewline = tail.indexOf(0x0a);
      await writeFile(path, firstNewline < 0 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1), { mode: 0o600 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const file = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.write(line);
  } finally {
    await file.close();
  }
}

export async function readDiagnosticLogs(root: string, maxBytes = MAX_BYTES): Promise<string> {
  const path = join(root, FILE_NAME);
  let content: Buffer;
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Diagnostic log path is not a regular file.");
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  if (content.length <= maxBytes) return content.toString("utf8");
  const tail = content.subarray(content.length - maxBytes).toString("utf8");
  const firstNewline = tail.indexOf("\n");
  return firstNewline < 0 ? "" : tail.slice(firstNewline + 1);
}

export async function clearDiagnosticLogs(root: string): Promise<void> {
  await rm(join(root, FILE_NAME), { force: true });
}

export const diagnosticLogPath = (root: string): string => join(root, FILE_NAME);
