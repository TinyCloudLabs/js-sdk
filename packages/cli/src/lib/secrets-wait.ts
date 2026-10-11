import { ExitCode } from "../config/constants.js";
import { CLIError, cliErrorFromService } from "../output/errors.js";
import type { ProbeOutcome, StatusEnvelopeError } from "./probe-child.js";

/** Sleeps between attempts, each measured from the end of the previous attempt; then 15 s. */
export const WAIT_BACKOFF_MS: readonly number[] = [3_000, 4_500, 6_750, 10_125];
export const WAIT_STEADY_INTERVAL_MS = 15_000;
export const DEFAULT_WAIT_TIMEOUT = "5m";
export const MAX_WAIT_TIMEOUT_MS = 9 * 60_000;
/** Retryable failures in a row that end the wait with `NETWORK_ERROR`. */
export const MAX_CONSECUTIVE_FAILURES = 5;

const TIMEOUT_RE = /^(0|\d+s|\d+m)$/;
const RETRYABLE_STATUS_ERRORS: Record<string, true> = { NODE_UNREACHABLE: true, NODE_ERROR: true };

export const EXPLICIT_KEY_HINT =
  "tc secrets wait never signs in, and an explicit private key has no stored session. " +
  "Use a local profile signed in once with tc --profile <profile> auth login --method local, without TC_PRIVATE_KEY.";

/** The production {@link WaitDependencies.sleep}: a timer that an abort cancels at once. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  // Executor form: the CLI supports Node 20, which lacks Promise.withResolvers.
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** `--timeout D`: `0`, `Ns` or `Nm`, at most 9 minutes, in milliseconds. */
export function parseWaitTimeout(value: string): number {
  if (!TIMEOUT_RE.test(value)) {
    throw new CLIError("INVALID_TIMEOUT", `Invalid --timeout ${JSON.stringify(value)}: use 0, Ns or Nm (for example 90s or 5m).`, ExitCode.USAGE_ERROR);
  }
  const amount = value === "0" ? 0 : Number(value.slice(0, -1));
  const ms = value.endsWith("m") ? amount * 60_000 : amount * 1_000;
  if (ms > MAX_WAIT_TIMEOUT_MS) {
    throw new CLIError("INVALID_TIMEOUT", "--timeout may be at most 9m.", ExitCode.USAGE_ERROR);
  }
  return ms;
}

export interface WaitRequest {
  readonly profile: string;
  readonly timeoutMs: number;
  /** Hint for a `consent_required` result (the profile's scoped-login route). */
  readonly consentHint: string;
}

export interface WaitDependencies {
  now(): number;
  /** Resolves after `ms`, or early once `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** One attempt; must stop its child once `signal` aborts. */
  runProbe(signal: AbortSignal): Promise<ProbeOutcome>;
  readonly signal: AbortSignal;
}

export type WaitStdout =
  | { readonly status: "ready"; readonly names: readonly string[]; readonly scope?: string }
  | {
    readonly status: "pending";
    readonly pending: readonly string[];
    readonly present: readonly string[];
    readonly url?: string;
    readonly hint?: string;
  };

export interface WaitResult {
  readonly exitCode: typeof ExitCode.SUCCESS | typeof ExitCode.PENDING;
  readonly stdout: WaitStdout;
  readonly warnings?: readonly unknown[];
}

interface StatusOutput {
  readonly status: "ready" | "pending" | "consent_required";
  readonly owner: string;
  readonly names: readonly string[];
  readonly scope?: string;
  readonly present: readonly string[];
  readonly pending: readonly string[];
  readonly denied: readonly string[];
  readonly setup?: Readonly<{ url: string }> & Readonly<Record<string, unknown>>;
  readonly hint?: string;
}

interface Progress {
  readonly present: readonly string[];
  readonly pending: readonly string[];
}

/**
 * Poll `tinycloud.secrets.status` until every name is present, a terminal
 * error, or the deadline. The first attempt runs at once; later ones follow
 * {@link WAIT_BACKOFF_MS} then {@link WAIT_STEADY_INTERVAL_MS}, measured from
 * the end of the previous attempt. A final attempt runs at the deadline and
 * nothing starts after it, so the wait is bounded by the timeout plus one
 * attempt budget. Throws a `CLIError` for every non-zero outcome except
 * pending at the deadline (exit 8).
 */
export async function runSecretsWait(request: WaitRequest, deps: WaitDependencies): Promise<WaitResult> {
  const deadline = deps.now() + request.timeoutMs;
  let progress: Progress | undefined;
  let lastPending: StatusOutput | undefined;
  let lastWarnings: readonly unknown[] | undefined;
  let failures = 0;
  let step = 0;

  const cancelled = (): CLIError => new CLIError(
    "CANCELLED",
    "Interrupted: tc secrets wait stopped before the secrets were ready.",
    ExitCode.CANCELLED,
    progress === undefined ? {} : { progress },
  );
  const networkError = (message: string): CLIError => new CLIError(
    "NETWORK_ERROR",
    message,
    ExitCode.NETWORK_ERROR,
    {
      ...(progress === undefined ? {} : { progress }),
      ...(lastWarnings === undefined ? {} : { warnings: lastWarnings }),
    },
  );

  for (;;) {
    if (deps.signal.aborted) throw cancelled();
    const final = deps.now() >= deadline;
    const outcome = await deps.runProbe(deps.signal);
    if (deps.signal.aborted || outcome.kind === "cancelled") throw cancelled();

    let failed = false;
    switch (outcome.kind) {
      case "timeout":
        failed = true;
        break;
      case "probe_failed":
        throw new CLIError(
          "PROBE_FAILED",
          outcome.childErrorCode === undefined
            ? "The status probe exited without a result."
            : `The status probe exited without a result (${outcome.childErrorCode}).`,
          ExitCode.ERROR,
        );
      case "ok": {
        const envelope = outcome.envelope;
        lastWarnings = envelope.warnings;
        if (envelope.status === "error") {
          if (RETRYABLE_STATUS_ERRORS[envelope.error.code] === true && envelope.error.retryable !== false) {
            failed = true;
            break;
          }
          throw statusError(envelope.error, request.profile, envelope.warnings);
        }
        const output = statusOutput(envelope.output);
        if (output === undefined) throw new CLIError("PROBE_FAILED", "The status probe returned an unexpected result.", ExitCode.ERROR);
        if (output.status === "ready") {
          return {
            exitCode: ExitCode.SUCCESS,
            stdout: { status: "ready", names: [...output.names], ...(output.scope === undefined ? {} : { scope: output.scope }) },
            ...(envelope.warnings === undefined ? {} : { warnings: envelope.warnings }),
          };
        }
        if (output.status === "consent_required") throw consentError(output, request.consentHint, envelope.warnings);
        progress = { present: [...output.present], pending: [...output.pending] };
        lastPending = output;
        break;
      }
    }

    if (failed) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw networkError(`The TinyCloud node could not be reached (${failures} attempts in a row).`);
      }
    } else {
      failures = 0;
    }

    const end = deps.now();
    if (final || end >= deadline) {
      if (failed || lastPending === undefined) {
        throw networkError("The TinyCloud node could not be reached before the wait's deadline.");
      }
      return {
        exitCode: ExitCode.PENDING,
        stdout: {
          status: "pending",
          pending: [...lastPending.pending],
          present: [...lastPending.present],
          ...(lastPending.setup !== undefined
            ? { url: lastPending.setup.url }
            : lastPending.hint !== undefined
            ? { hint: lastPending.hint }
            : {}),
        },
        ...(lastWarnings === undefined ? {} : { warnings: lastWarnings }),
      };
    }
    const interval = WAIT_BACKOFF_MS[step] ?? WAIT_STEADY_INTERVAL_MS;
    step += 1;
    await deps.sleep(Math.min(interval, deadline - end), deps.signal);
  }
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

/** The fields of a status `ok` output this loop relies on; undefined when any is malformed. */
function statusOutput(output: Readonly<Record<string, unknown>>): StatusOutput | undefined {
  const { status, owner, scope, setup, hint } = output;
  const names = stringList(output.names);
  const present = stringList(output.present);
  const pending = stringList(output.pending);
  const denied = stringList(output.denied);
  if (status !== "ready" && status !== "pending" && status !== "consent_required") return undefined;
  if (typeof owner !== "string" || !names || !present || !pending || !denied) return undefined;
  if (scope !== undefined && typeof scope !== "string") return undefined;
  if (hint !== undefined && typeof hint !== "string") return undefined;
  if (setup !== undefined &&
    (typeof setup !== "object" || setup === null || !("url" in setup) || typeof setup.url !== "string")) return undefined;
  return {
    status,
    owner,
    names,
    present,
    pending,
    denied,
    ...(scope === undefined ? {} : { scope }),
    ...(setup === undefined ? {} : { setup: setup as StatusOutput["setup"] & object }),
    ...(hint === undefined ? {} : { hint }),
  };
}

/** `consent_required` → `PERMISSION_DENIED` (5): request access for the denied names; setup for the pending ones. */
function consentError(output: StatusOutput, hint: string, warnings: readonly unknown[] | undefined): CLIError {
  const denied = [...output.denied];
  return new CLIError(
    "PERMISSION_DENIED",
    `This profile may not read ${denied.join(", ")}. The owner must approve access first.`,
    ExitCode.PERMISSION_DENIED,
    {
      hint,
      recovery: {
        action: "request_access",
        names: denied,
        owner: output.owner,
        ...(output.scope === undefined ? {} : { scope: output.scope }),
      },
      deniedNames: denied,
      ...(output.setup === undefined ? {} : { setup: output.setup }),
      ...(warnings === undefined ? {} : { warnings }),
    },
  );
}

function recoveryOf(error: StatusEnvelopeError, action: string): { action: string; command?: string } | undefined {
  const recovery = error.details?.recovery;
  if (typeof recovery !== "object" || recovery === null) return undefined;
  const candidate = recovery as { action?: unknown; command?: unknown };
  if (candidate.action !== action) return undefined;
  return candidate.command === undefined || typeof candidate.command === "string"
    ? recovery as { action: string; command?: string }
    : undefined;
}

/** A terminal status error envelope as the CLI error `wait` exits with (plan §2.4 mapping). */
function statusError(error: StatusEnvelopeError, profile: string, warnings: readonly unknown[] | undefined): CLIError {
  const extra = warnings === undefined ? {} : { warnings };
  if (error.code === "AUTH_REQUIRED" && error.details?.reason === "explicit_key") {
    return new CLIError("AUTH_REQUIRED", error.message, ExitCode.AUTH_REQUIRED, { hint: EXPLICIT_KEY_HINT, ...extra });
  }
  if (error.code === "AUTH_REQUIRED" || error.code === "SESSION_NOT_FOUND") {
    const recovery = recoveryOf(error, "sign_in");
    if (recovery !== undefined) {
      const hint = recovery.command !== undefined
        ? `Sign in once with: ${recovery.command}, then retry.`
        : `Sign in to profile "${profile}" once with tc auth login, then retry.`;
      return new CLIError("AUTH_REQUIRED", error.message, ExitCode.AUTH_REQUIRED, { hint, recovery, ...extra });
    }
  }
  if (error.code === "PROFILE_MIGRATION_REQUIRED") {
    const recovery = recoveryOf(error, "complete_migration");
    const hint = recovery?.command !== undefined
      ? `Run ${recovery.command} once to finish this profile's one-time upgrade, then retry wait.`
      : `Run tc auth caps once with profile "${profile}" to finish its one-time upgrade, then retry wait.`;
    return new CLIError("PROFILE_MIGRATION_REQUIRED", error.message, ExitCode.ERROR, {
      hint,
      ...(recovery === undefined ? {} : { recovery }),
      ...extra,
    });
  }
  if (error.code === "INPUT_INVALID") {
    const reason = error.details?.reason;
    if (reason === "OWNER_MISMATCH") return new CLIError("OWNER_MISMATCH", error.message, ExitCode.USAGE_ERROR, extra);
    if (reason === "OWNER_DID_UNKNOWN") return new CLIError("OWNER_DID_UNKNOWN", error.message, ExitCode.AUTH_REQUIRED, extra);
    return new CLIError("INPUT_INVALID", error.message, ExitCode.USAGE_ERROR, extra);
  }
  const mapped = cliErrorFromService(error);
  return new CLIError(mapped.code, mapped.message, mapped.exitCode, { ...mapped.metadata, ...extra });
}
