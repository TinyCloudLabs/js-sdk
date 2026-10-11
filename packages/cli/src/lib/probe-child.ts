import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** One `tc secrets wait` attempt: from spawn until the child's result line, or a timeout. */
export const ATTEMPT_BUDGET_MS = 20_000;
/** Grace between SIGTERM and SIGKILL when stopping a probe child. */
export const KILL_GRACE_MS = 500;
/** The result is the child's first stdout line, at most this many bytes. */
export const MAX_PROBE_LINE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STATUS_OPERATION_ID = "tinycloud.secrets.status";
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** What the probe child is asked: names, scope and the requested owner only, never a key. */
export interface ProbeRequest {
  readonly profile: string;
  readonly host: string;
  readonly names: readonly string[];
  readonly scope?: string;
  readonly owner?: string;
}

export interface StatusEnvelopeError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The canonical `tinycloud.secrets.status@1` envelope the probe child prints. */
export type StatusEnvelope =
  | {
    readonly status: "ok";
    readonly operation: { readonly operationId: string };
    readonly output: Readonly<Record<string, unknown>>;
    readonly warnings?: readonly unknown[];
  }
  | {
    readonly status: "error";
    readonly operation: { readonly operationId: string };
    readonly error: StatusEnvelopeError;
    readonly warnings?: readonly unknown[];
  };

export type ProbeOutcome =
  | { readonly kind: "ok"; readonly envelope: StatusEnvelope }
  /** The attempt budget ran out before a result line; retryable. */
  | { readonly kind: "timeout" }
  /** The child exited (or wrote too much) without a parsable status line. */
  | { readonly kind: "probe_failed"; readonly childErrorCode?: string }
  /** The caller's signal aborted the attempt. */
  | { readonly kind: "cancelled" };

export type ProbeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ProbeChildOptions {
  /** Executable; defaults to `process.execPath`. */
  readonly command?: string;
  /** Full argument list; defaults to this `tc` running `secrets probe` (see {@link probeChildArgv}). */
  readonly argv?: readonly string[];
  readonly budgetMs?: number;
  readonly killGraceMs?: number;
  readonly spawn?: ProbeSpawn;
  readonly signal?: AbortSignal;
  /** Called with the child's PID once it is spawned. */
  readonly onSpawn?: (pid: number) => void;
}

/** The `tc` arguments of one probe: global flags, then `secrets probe NAMES [--scope S] [--owner DID]`. */
export function probeCommandArgs(request: ProbeRequest): string[] {
  return [
    "--json", "--profile", request.profile, "--host", request.host,
    "secrets", "probe", ...request.names,
    ...(request.scope === undefined ? [] : ["--scope", request.scope]),
    ...(request.owner === undefined ? [] : ["--owner", request.owner]),
  ];
}

/** The same binary as this process: its runtime flags, its script, then the probe arguments. */
export function probeChildArgv(request: ProbeRequest): string[] {
  const script = process.argv[1];
  if (script === undefined) throw new Error("Cannot locate the tc entry point for the probe child.");
  return [...process.execArgv, script, ...probeCommandArgs(request)];
}

/**
 * Run one status probe in a child process. Resolves only after the child has
 * exited: once the result line arrives, the budget runs out, or `signal`
 * aborts, the child gets SIGTERM, then SIGKILL after the grace period.
 * `TC_PRIVATE_KEY` and `TC_HOME` reach the child only through the inherited
 * environment, never through its arguments.
 */
export function runProbeChild(request: ProbeRequest, options: ProbeChildOptions = {}): Promise<ProbeOutcome> {
  const command = options.command ?? process.execPath;
  const args = options.argv ?? probeChildArgv(request);
  const budgetMs = options.budgetMs ?? ATTEMPT_BUDGET_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const spawn = options.spawn ?? nodeSpawn;
  const signal = options.signal;

  // Executor form: the CLI supports Node 20, which lacks Promise.withResolvers.
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "cancelled" });
      return;
    }
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let outcome: ProbeOutcome | undefined;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exited = false;
    let stopping = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
      if (exited || stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, killGraceMs);
    };
    const settle = (value: ProbeOutcome): void => {
      if (outcome !== undefined) return;
      outcome = value;
      stop();
    };
    const onAbort = (): void => settle({ kind: "cancelled" });
    const budgetTimer = setTimeout(() => settle({ kind: "timeout" }), budgetMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      if (exited) return;
      exited = true;
      clearTimeout(budgetTimer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      if (outcome === undefined) {
        // An unterminated last line still counts once the child has exited.
        const envelope = stdout.length > 0 && stdout.length <= MAX_PROBE_LINE_BYTES
          ? parseStatusEnvelope(stdout.toString("utf8"))
          : undefined;
        outcome = envelope !== undefined
          ? { kind: "ok", envelope }
          : probeFailed(stderr.toString("utf8"));
      }
      resolve(outcome);
    };

    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outcome !== undefined) return;
      stdout = Buffer.concat([stdout, chunk]);
      const newline = stdout.indexOf(0x0a);
      if (newline >= 0 && newline <= MAX_PROBE_LINE_BYTES) {
        const envelope = parseStatusEnvelope(stdout.subarray(0, newline).toString("utf8"));
        settle(envelope !== undefined ? { kind: "ok", envelope } : { kind: "probe_failed" });
      } else if (newline > MAX_PROBE_LINE_BYTES || (newline < 0 && stdout.length > MAX_PROBE_LINE_BYTES)) {
        settle({ kind: "probe_failed" });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.subarray(stderr.length - MAX_STDERR_BYTES);
    });
    child.on("error", () => {
      settle({ kind: "probe_failed" });
      // A child that never started emits no exit/close.
      if (child.pid === undefined) finish();
    });
    child.on("close", finish);
  });
}

function probeFailed(stderr: string): ProbeOutcome {
  const code = childErrorCode(stderr);
  return code === undefined ? { kind: "probe_failed" } : { kind: "probe_failed", childErrorCode: code };
}

/** The `error.code` of the last JSON error document the child wrote to stderr (`handleError --json`). */
function childErrorCode(stderr: string): string | undefined {
  const lines = stderr.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!lines[start]!.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(lines.slice(start).join("\n"));
      if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) continue;
      const error = parsed.error;
      if (typeof error !== "object" || error === null || !("code" in error)) continue;
      return typeof error.code === "string" && ERROR_CODE_RE.test(error.code) ? error.code : undefined;
    } catch {
      // Not the start of a complete JSON document; keep looking upward.
    }
  }
  return undefined;
}

/** Untrusted JSON from the child, before {@link parseStatusEnvelope} checks each field it uses. */
interface RawEnvelope {
  readonly status?: unknown;
  readonly operation?: { readonly operationId?: unknown } | null;
  readonly output?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly retryable?: unknown; readonly details?: unknown } | null;
  readonly warnings?: unknown;
}

function plainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A canonical `tinycloud.secrets.status` envelope with an `ok` output or an `error`, else undefined. */
export function parseStatusEnvelope(line: string): StatusEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!plainObject(parsed)) return undefined;
  const value = parsed as RawEnvelope;
  if (!plainObject(value.operation) || value.operation?.operationId !== STATUS_OPERATION_ID) return undefined;
  const warnings = Array.isArray(value.warnings) ? { warnings: value.warnings as unknown[] } : {};
  const operation = { operationId: STATUS_OPERATION_ID };
  if (value.status === "ok" && plainObject(value.output)) {
    return { status: "ok", operation, output: value.output as Record<string, unknown>, ...warnings };
  }
  const error = value.error;
  if (value.status === "error" && plainObject(error) &&
    typeof error?.code === "string" && typeof error.message === "string") {
    return {
      status: "error",
      operation,
      error: {
        code: error.code,
        message: error.message,
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
        ...(plainObject(error.details) ? { details: error.details as Record<string, unknown> } : {}),
      },
      ...warnings,
    };
  }
  return undefined;
}
