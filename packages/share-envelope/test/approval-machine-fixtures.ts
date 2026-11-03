import { generateKeyPairSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  approvalEntrySchema,
  linkIssuerPublicKey,
  prepareLinkRecord,
  signerFromSeed,
  type ApprovalEntry,
  type ApprovalPhase,
  type Ed25519PrivateJwk,
  type RequesterState,
  type RunContext,
} from "../src/links/index.js";

/** Shared fixtures of the requester state-machine tests: real signed headers, sentinel private keys. */

export const T0 = Date.parse("2026-11-03T12:00:00.000Z");
/** The request's life in the fixtures; its signed `expiresAt` is `T0 + LIFE_MS`. */
export const LIFE_MS = 3_600_000;
/** The local expiry `E` of every fixture entry: the signed header's `expiresAt`. */
export const E = T0 + LIFE_MS;
export const S = 30_000;
export const R = 600_000;
export const iso = (ms: number): string => new Date(ms).toISOString();

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
/** Distinct, recognisable private-key strings: no test output, effect or outcome may ever contain them. */
export const RELAY_KEY = b64(new Uint8Array(32).fill(0xab));
const stagedSeed = new Uint8Array(32).fill(0xcd);
export const STAGED_KEY: Ed25519PrivateJwk = { kty: "OKP", crv: "Ed25519", x: b64(ed25519.getPublicKey(stagedSeed)), d: b64(stagedSeed) };
export const SECRET_STRINGS = [RELAY_KEY, STAGED_KEY.d] as const;

const signer = signerFromSeed(new Uint8Array(32).fill(17));
const requestBody = {
  issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
  targetPublicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: b64(linkIssuerPublicKey(signer.did)!) },
  nodeOrigin: "https://node.example",
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
  grantLifetimeSeconds: 2_592_000,
  resultEncryptionPublicJwk: (() => {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    return { kty: "EC" as const, crv: "P-256" as const, x: key.x!, y: key.y! };
  })(),
};

const prepared = await prepareLinkRecord({
  type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(requestBody)), issuerKey: signer,
  apiOrigin: "https://api.tinycloud.xyz", now: T0, expiresAt: new Date(E),
});

export const REQUEST_ID = "abcdefghijklmnopqrstuvwxyz";
export const RESULT_REF = "synthetic-result-reference-123456";
export const RESULT_EXPIRES = iso(T0 + 120_000 + R);

export interface EntryOptions {
  readonly staged?: boolean;
  readonly retainUntil?: number;
  readonly requestId?: string;
  readonly resultExpiresAt?: string;
}

const parsed = new Map<string, ApprovalEntry>();

/** A valid v2 entry in `phase`, parsed by the real schema so a fixture can never drift from the format. Entries are immutable: cached. */
export function entryIn(phase: ApprovalPhase, options: EntryOptions = {}): ApprovalEntry {
  const cacheKey = JSON.stringify([phase, options]);
  const cached = parsed.get(cacheKey);
  if (cached !== undefined) return cached;
  const entry = buildEntry(phase, options);
  parsed.set(cacheKey, entry);
  return entry;
}

function buildEntry(phase: ApprovalPhase, options: EntryOptions): ApprovalEntry {
  const keyed = phase !== "acked";
  const found = phase !== "open";
  return approvalEntrySchema.parse({
    requestId: options.requestId ?? REQUEST_ID,
    bodyCid: prepared.bodyCid,
    approvalUrl: `https://openkey.example/a/${options.requestId ?? REQUEST_ID}#v=4&k=content-key-in-the-fragment`,
    request: requestBody,
    record: { header: prepared.record.header, signature: prepared.record.signature },
    apiOrigin: "https://api.openkey.example", linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example",
    ...(keyed ? { keys: { relayPrivateKey: RELAY_KEY, ...(options.staged === true && phase !== "committed" ? { stagedSigningKey: STAGED_KEY } : {}) } } : {}),
    phase,
    ...(found ? { resultRef: RESULT_REF, resultExpiresAt: options.resultExpiresAt ?? RESULT_EXPIRES } : {}),
    ...(phase === "fetched" || phase === "committed" ? { resultEnvelope: { relay: "opaque-ciphertext" } } : {}),
    ackId: "ack-id-0123456789abcdef",
    ...(phase === "acked" ? { retainUntil: iso(options.retainUntil ?? E + R) } : {}),
    ...(options.retainUntil !== undefined && phase === "committed" ? { retainUntil: iso(options.retainUntil) } : {}),
    createdAt: iso(T0),
    ext: {},
  });
}

export const FRESH_RUN: RunContext = { unexpectedStreak: 0, firstCheckDone: true, finalPoll: false };

/** A running (not settled) state: `run` defaults to a run that already completed its first check. */
export function liveState(entry: ApprovalEntry, run: Partial<RunContext> = {}): RequesterState {
  const base: RunContext = { ...FRESH_RUN, ...(entry.phase === "discovered" ? { collectUntil: T0 + 60_000 + 30_000 } : {}), ...run };
  return { entry, run: base };
}

export const PHASES: readonly ApprovalPhase[] = ["open", "discovered", "fetched", "committed", "acked"];
export { prepared as preparedRecord, requestBody };
