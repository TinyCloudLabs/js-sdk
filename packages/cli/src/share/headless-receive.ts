import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SharePresentationMaterial } from "@tinycloud/share-sdk";
import { ExitCode } from "../config/constants.js";

/** Credential profile served by the email code gate. Other profiles are not handled here. */
export const CODE_GATE_PROFILE = "tinycloud.email-proof/v1";

/** Hard ceiling for a pending receive. Expiry never extends past this. */
export const PENDING_RECEIVE_MAX_AGE_MS = 15 * 60_000;

const PENDING_TYPE = "tinycloud.share-receive/pending/v1";
const RESUME_ID = /^[0-9a-f]{32}$/;
const CODE = /^\d{8}$/;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Presentation inputs produced by a verified code ceremony. The presentation itself is built by the access port. */
export type EmailProofMaterial = Omit<SharePresentationMaterial, "presentation">;

/**
 * Witness driver seam. The acquisition implementation (shared Courier module) plugs in here.
 * `state` is opaque JSON the gate needs to resume; it may hold holder key material, so it is
 * only ever written to the 0600 pending file. Gate errors are `EmailProofGateError`; their
 * messages are never shown to the user.
 */
export interface EmailProofGate {
  requestCode(input: { readonly recipient: string; readonly signal?: AbortSignal }): Promise<{ readonly state: JsonValue; readonly expiresAt: string }>;
  completeEmailProof(input: { readonly state: JsonValue; readonly code: string; readonly signal?: AbortSignal }): Promise<EmailProofMaterial>;
}

export type EmailProofGateErrorCode = "RATE_LIMITED" | "CODE_REJECTED" | "REQUEST_EXPIRED" | "UNAVAILABLE";

export class EmailProofGateError extends Error {
  readonly code: EmailProofGateErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: EmailProofGateErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "EmailProofGateError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Share access seam: opens the share with the presentation built from `material`, then loads the bytes. */
export interface ShareAccessPort {
  receive(envelope: JsonValue, material: EmailProofMaterial): Promise<ReceivedContent>;
}

export interface ReceivedContent {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType?: string;
}

/**
 * Credential source seam. `find` returns in-process material only; nothing is persisted by a source.
 * The pending file (`PendingStore`) is the only cross-process state.
 */
export interface CredentialSource<M> {
  find(recipient: string): Promise<M | undefined>;
  acquire(recipient: string, promptForCode: () => Promise<string>): Promise<M>;
  store(recipient: string, material: M): Promise<void>;
}

export type HeadlessReceiveErrorCode =
  | "USAGE"
  | "CODE_REJECTED"
  | "REQUEST_EXPIRED"
  | "RESUME_NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "NODE_REFUSED"
  | "UNSUPPORTED_PROFILE";

const EXIT_CODE: Record<HeadlessReceiveErrorCode, number> = {
  USAGE: ExitCode.USAGE_ERROR,
  CODE_REJECTED: ExitCode.AUTH_REQUIRED,
  REQUEST_EXPIRED: ExitCode.AUTH_REQUIRED,
  RESUME_NOT_FOUND: ExitCode.AUTH_REQUIRED,
  RATE_LIMITED: ExitCode.NETWORK_ERROR,
  UNAVAILABLE: ExitCode.NETWORK_ERROR,
  NODE_REFUSED: ExitCode.NODE_ERROR,
  UNSUPPORTED_PROFILE: ExitCode.ERROR,
};

export class HeadlessReceiveError extends Error {
  readonly code: HeadlessReceiveErrorCode;
  readonly exitCode: number;
  readonly retryAfterMs?: number;
  constructor(code: HeadlessReceiveErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "HeadlessReceiveError";
    this.code = code;
    this.exitCode = EXIT_CODE[code];
    this.retryAfterMs = retryAfterMs;
  }
}

export interface PendingReceive {
  readonly type: typeof PENDING_TYPE;
  readonly id: string;
  readonly expiresAt: number;
  readonly envelope: JsonValue;
  readonly gateState: JsonValue;
}

/** Cross-process pending state. Implementations MUST keep the file private (0600) and delete it on expiry. */
export interface PendingStore {
  save(pending: PendingReceive): Promise<void>;
  load(id: string, now: number): Promise<PendingReceive>;
  remove(id: string): Promise<void>;
}

export function validateCode(code: string): void {
  if (!CODE.test(code)) throw new HeadlessReceiveError("USAGE", "the code is the 8-digit code from the owner's email");
}

/** Minutes to wait, rounded up, never below one. */
export function retryMinutes(retryAfterMs: number | undefined): number {
  return retryAfterMs === undefined ? 1 : Math.max(1, Math.ceil(retryAfterMs / 60_000));
}

/** File-backed pending store under a private directory. The resume id is the file name, validated to block traversal. */
export function filePendingStore(dir: string): PendingStore {
  const pathFor = (id: string): string => {
    if (!RESUME_ID.test(id)) throw new HeadlessReceiveError("RESUME_NOT_FOUND", "no pending share receive matches this --resume id");
    return join(dir, `${id}.json`);
  };
  return {
    async save(pending) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeFile(pathFor(pending.id), JSON.stringify(pending), { mode: 0o600, flag: "wx" });
    },
    async load(id, now) {
      const path = pathFor(id);
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, "utf8")); } catch {
        throw new HeadlessReceiveError("RESUME_NOT_FOUND", "no pending share receive matches this --resume id");
      }
      if (!isPending(parsed) || parsed.id !== id) {
        await rm(path, { force: true });
        throw new HeadlessReceiveError("RESUME_NOT_FOUND", "no pending share receive matches this --resume id");
      }
      if (parsed.expiresAt <= now) {
        await rm(path, { force: true });
        throw new HeadlessReceiveError("REQUEST_EXPIRED", "the code request expired; start again with --request-code");
      }
      return parsed;
    },
    async remove(id) {
      await rm(pathFor(id), { force: true });
    },
  };
}

function isPending(value: unknown): value is PendingReceive {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === PENDING_TYPE && typeof record.id === "string" && typeof record.expiresAt === "number" && "envelope" in record && "gateState" in record;
}

async function gateCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HeadlessReceiveError) throw error;
    if (error instanceof EmailProofGateError) throw gateFailure(error);
    throw new HeadlessReceiveError("UNAVAILABLE", "could not reach the credential service; try again later");
  }
}

function gateFailure(error: EmailProofGateError): HeadlessReceiveError {
  switch (error.code) {
    case "RATE_LIMITED":
      return new HeadlessReceiveError("RATE_LIMITED", `rate limited for this mailbox; try again in ${retryMinutes(error.retryAfterMs)} minutes`, error.retryAfterMs);
    case "CODE_REJECTED":
      return new HeadlessReceiveError("CODE_REJECTED", "the code was not accepted; start again with --request-code to get a new code");
    case "REQUEST_EXPIRED":
      return new HeadlessReceiveError("REQUEST_EXPIRED", "the code request expired; start again with --request-code");
    case "UNAVAILABLE":
      return new HeadlessReceiveError("UNAVAILABLE", "could not reach the credential service; try again later");
  }
}

async function accessCall(call: () => Promise<ReceivedContent>): Promise<ReceivedContent> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HeadlessReceiveError) throw error;
    throw new HeadlessReceiveError("NODE_REFUSED", "the share node did not release the content");
  }
}

/** Email code gate: the only credential source implemented. Store and find are process-local. */
export function codeGateSource(gate: EmailProofGate): CredentialSource<EmailProofMaterial> {
  const held = new Map<string, EmailProofMaterial>();
  return {
    async find(recipient) {
      return held.get(recipient);
    },
    async acquire(recipient, promptForCode) {
      const requested = await gateCall(() => gate.requestCode({ recipient }));
      const code = await promptForCode();
      validateCode(code);
      return gateCall(() => gate.completeEmailProof({ state: requested.state, code }));
    },
    async store(recipient, material) {
      held.set(recipient, material);
    },
  };
}

/** Picks the source for the share's credential profile. Unknown profiles are refused, never guessed. */
export function selectCredentialSource<M>(profile: string, sources: Readonly<Record<string, CredentialSource<M>>>): CredentialSource<M> {
  const source = Object.hasOwn(sources, profile) ? sources[profile] : undefined;
  if (source === undefined) throw new HeadlessReceiveError("UNSUPPORTED_PROFILE", "this share's credential profile is not supported by this receive path");
  return source;
}

export interface RequestCodeInput {
  readonly envelope: JsonValue;
  readonly recipient: string;
  readonly gate: EmailProofGate;
  readonly store: PendingStore;
  readonly now: number;
  readonly randomId: () => string;
}

/** Process 1 of the headless flow: sends the code email and persists the pending receive. */
export async function requestHeadlessCode(input: RequestCodeInput): Promise<{ readonly id: string; readonly expiresAt: number }> {
  const requested = await gateCall(() => input.gate.requestCode({ recipient: input.recipient }));
  const parsed = Date.parse(requested.expiresAt);
  const ceiling = input.now + PENDING_RECEIVE_MAX_AGE_MS;
  const expiresAt = Number.isNaN(parsed) ? ceiling : Math.min(ceiling, parsed);
  if (expiresAt <= input.now) throw new HeadlessReceiveError("UNAVAILABLE", "the credential service returned an expired request; try again later");
  const id = input.randomId();
  if (!RESUME_ID.test(id)) throw new Error("randomId must return 32 lowercase hex characters");
  await input.store.save({ type: PENDING_TYPE, id, expiresAt, envelope: input.envelope, gateState: requested.state });
  return { id, expiresAt };
}

export interface CompleteHeadlessInput {
  readonly id: string;
  readonly code: string;
  readonly gate: EmailProofGate;
  readonly store: PendingStore;
  readonly access: ShareAccessPort;
  readonly now: number;
}

/**
 * Process 2 of the headless flow. The pending file is deleted on every outcome after it is loaded
 * (success, rejected code, rate limit, node refusal). A malformed code leaves it in place.
 */
export async function completeHeadlessReceive(input: CompleteHeadlessInput): Promise<ReceivedContent> {
  validateCode(input.code);
  const pending = await input.store.load(input.id, input.now);
  try {
    const material = await gateCall(() => input.gate.completeEmailProof({ state: pending.gateState, code: input.code }));
    return await accessCall(() => input.access.receive(pending.envelope, material));
  } finally {
    await input.store.remove(input.id);
  }
}

export interface PromptReceiveInput {
  readonly envelope: JsonValue;
  readonly recipient: string;
  readonly source: CredentialSource<EmailProofMaterial>;
  readonly access: ShareAccessPort;
  readonly promptForCode: () => Promise<string>;
}

/** Interactive TTY path: one process requests the code, prompts for it, and opens the share. */
export async function promptHeadlessReceive(input: PromptReceiveInput): Promise<ReceivedContent> {
  const material = await input.source.acquire(input.recipient, input.promptForCode);
  await input.source.store(input.recipient, material);
  return accessCall(() => input.access.receive(input.envelope, material));
}
