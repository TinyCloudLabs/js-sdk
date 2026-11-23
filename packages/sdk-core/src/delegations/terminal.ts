import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { decodeBase64Url, encodeBase64Url } from "../credentials/digest";

/** Top-level ReCap / UCAN fact key carrying the delegation mode (`"terminal"` | `"attenuable"`). */
export const DELEGATION_MODE_KEY = "xyz.tinycloud.policy/delegationMode";

/** Explicit delegation mode carried on a wallet-signed ReCap or UCAN fact. */
export type DelegationMode = "terminal" | "attenuable";

/** User-facing refusal when a caller tries to re-delegate a terminal grant. */
export const TERMINAL_REDELEGATION_REFUSED_MESSAGE =
  "This access was given only to you, so it can't be passed on. Ask the owner to give it directly to the app or agent that needs it.";

/**
 * The UCAN fact a TinyCloud node reads when admitting a child delegation:
 * a parent carrying it is refused with `terminal-parent-cannot-redelegate`.
 * The node matches any object in the payload's `fct` array with this exact
 * key and string value (tinycloud-core `util.rs` `DelegationMode`).
 */
export const TERMINAL_DELEGATION_FACT: Readonly<Record<string, string>> = Object.freeze({
  [DELEGATION_MODE_KEY]: "terminal",
});

const RECAP_PREFIX = "urn:recap:";

/** True when an error or node response reports `terminal-parent-cannot-redelegate`. */
export function isTerminalParentRefusal(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || error === undefined) return false;
  if (typeof error === "string") return error.includes("terminal-parent-cannot-redelegate");
  if (typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.code === "TERMINAL_PARENT_CANNOT_REDELEGATE" || record.code === "terminal-parent-cannot-redelegate") {
    return true;
  }
  return (
    (typeof record.message === "string" && record.message.includes("terminal-parent-cannot-redelegate")) ||
    (typeof record.error === "string" && record.error.includes("terminal-parent-cannot-redelegate")) ||
    isTerminalParentRefusal(record.cause, depth + 1) ||
    isTerminalParentRefusal(record.meta, depth + 1)
  );
}

/**
 * Reject duplicate JSON object member names (including `\uXXXX` escaped-name
 * equivalents) before trusting `JSON.parse`'s last-key-wins output.
 */
export function assertNoDuplicateJsonKeys(json: string): void {
  const objects: Array<Set<string> | null> = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g;
  const parts = [...json.matchAll(tokens)].map((match) => match[0]!);
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (token.startsWith('"') && parts[i + 1] === ":") {
      const keys = objects.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw new Error("ReCap duplicate member is ambiguous");
      keys?.add(key);
    }
  }
}

/**
 * Read and strictly validate the optional top-level
 * `xyz.tinycloud.policy/delegationMode` member on a parsed ReCap object.
 * Absent returns `undefined`; `null`, unknown strings, and non-strings throw.
 */
export function parseDelegationModeField(parsed: Record<string, unknown>): DelegationMode | undefined {
  if (!Object.prototype.hasOwnProperty.call(parsed, DELEGATION_MODE_KEY)) return undefined;
  const mode = parsed[DELEGATION_MODE_KEY];
  if (mode !== "terminal" && mode !== "attenuable") {
    throw new Error(`ReCap ${DELEGATION_MODE_KEY} must be "terminal" or "attenuable"`);
  }
  return mode;
}

function findSingleRecapLine(siwe: string): { encoded: string; start: number; end: number } | undefined {
  const lines = siwe.split(/\r?\n/);
  let resourcesIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "Resources:") { resourcesIdx = i; break; }
  }
  if (resourcesIdx < 0) return undefined;
  const resourceLines: string[] = [];
  for (let i = resourcesIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("- ")) break;
    resourceLines.push(line);
  }
  const recapIndices: number[] = [];
  for (let i = 0; i < resourceLines.length; i++) {
    if (resourceLines[i]!.slice(2).toLowerCase().startsWith(RECAP_PREFIX)) recapIndices.push(i);
  }
  if (recapIndices.length === 0) return undefined;
  if (recapIndices.length > 1 || recapIndices[0] !== resourceLines.length - 1) {
    throw new Error("SIWE has ambiguous ReCap resources");
  }
  const line = resourceLines[recapIndices[0]!]!;
  if (!line.startsWith(`- ${RECAP_PREFIX}`)) throw new Error("ReCap URI prefix must be lowercase urn:recap:");
  const encoded = line.slice(2 + RECAP_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+=*$/.test(encoded)) throw new Error("ReCap URI payload is not valid base64url");
  const start = siwe.lastIndexOf(line);
  return { encoded, start, end: start + line.length };
}

function decodeStrictRecapObject(encoded: string): {
  att: Record<string, unknown>;
  prf: string[];
  delegationMode?: DelegationMode;
} {
  const json = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(encoded.replace(/=+$/, "")));
  const parsed: unknown = JSON.parse(json);
  assertNoDuplicateJsonKeys(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ReCap payload must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "att" && key !== "prf" && key !== DELEGATION_MODE_KEY)) {
    throw new Error("ReCap fields are invalid");
  }
  if (typeof record.att !== "object" || record.att === null || Array.isArray(record.att)) {
    throw new Error("ReCap attenuation must be an object");
  }
  const prf = "prf" in record ? record.prf : [];
  if (!Array.isArray(prf) || !prf.every((entry) => typeof entry === "string")) {
    throw new Error("ReCap proofs must be strings");
  }
  const delegationMode = parseDelegationModeField(record);
  return {
    att: record.att as Record<string, unknown>,
    prf,
    ...(delegationMode === undefined ? {} : { delegationMode }),
  };
}

/**
 * Strictly read the top-level `xyz.tinycloud.policy/delegationMode` from a SIWE
 * message's final `urn:recap:` resource. Returns `"terminal"`, `"attenuable"`,
 * or `undefined` when absent (legacy attenuable). Refuses malformed values,
 * unknown top-level keys, ambiguous ReCap resources, and duplicate JSON keys
 * (including escaped-name equivalents).
 */
export function extractSiweDelegationMode(siwe: string): DelegationMode | undefined {
  const found = findSingleRecapLine(siwe);
  if (found === undefined) return undefined;
  return decodeStrictRecapObject(found.encoded).delegationMode;
}

/**
 * Whether `signedMode` is compatible with the requested `originalMode` during
 * step-2 rollout (when absent means legacy-attenuable):
 * - A declared `"terminal"` mode MUST stay `"terminal"` (dropping to absent or
 *   flipping to `"attenuable"` would escalate privileges and is refused).
 * - `"attenuable"` and absent (legacy-attenuable) are compatible with each
 *   other (pre-#735 / legacy OpenKey responses without the field stay accepted),
 *   but flipping to `"terminal"` is refused.
 */
export function isCompatibleSignedDelegationMode(
  originalMode: DelegationMode | undefined,
  signedMode: DelegationMode | undefined,
): boolean {
  if (originalMode === "terminal") return signedMode === "terminal";
  return signedMode !== "terminal";
}

/**
 * Rewrite the final `- urn:recap:...` line of a SIWE message to carry the
 * top-level `xyz.tinycloud.policy/delegationMode` field in canonical key order
 * (`att`, `prf`, `xyz.tinycloud.policy/delegationMode`), encoded as unpadded
 * base64url. Every other byte of the SIWE message is preserved verbatim.
 */
export function withSiweDelegationMode(siwe: string, mode: DelegationMode): string {
  if (mode !== "terminal" && mode !== "attenuable") {
    throw new Error(`Invalid delegationMode: ${String(mode)}`);
  }
  const found = findSingleRecapLine(siwe);
  if (found === undefined) throw new Error("SIWE has no urn:recap: resource");
  const { att, prf } = decodeStrictRecapObject(found.encoded);
  const rebuilt = JSON.stringify({ att, prf, [DELEGATION_MODE_KEY]: mode });
  const encoded = encodeBase64Url(new TextEncoder().encode(rebuilt));
  return `${siwe.slice(0, found.start)}- ${RECAP_PREFIX}${encoded}${siwe.slice(found.end)}`;
}

/** The Ed25519 session key a UCAN delegation was signed with. */
export interface TerminalDelegationSigningKey {
  readonly kty?: string;
  readonly crv?: string;
  readonly d?: string;
}

/**
 * Add {@link TERMINAL_DELEGATION_FACT} to a signed session-key UCAN delegation.
 *
 * The WASM delegation builder takes no facts, so the token it signed is
 * reopened, the fact appended to `fct`, and the payload re-signed with the
 * same key, which must be the token's issuer. Every other claim is kept as
 * signed; a token that already carries the fact is returned unchanged.
 * Returns the token and its CID (CIDv1, raw codec, BLAKE3-256, as the node
 * stores it).
 */
export function markDelegationTerminal(
  token: string,
  key: TerminalDelegationSigningKey,
): { delegation: string; cid: string } {
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(decodeBase64Url(headerSegment!)));
  const payload = JSON.parse(decoder.decode(decodeBase64Url(payloadSegment!)));
  if (signatureSegment === undefined || header.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519" || !key.d) {
    throw new Error("terminal delegations require an Ed25519 session key");
  }
  const privateKey = decodeBase64Url(key.d);
  const signer = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(privateKey)))}`;
  if (typeof payload.iss !== "string" || payload.iss.split("#")[0] !== signer) {
    throw new Error("session key is not the delegation issuer");
  }
  const facts: unknown = payload.fct ?? [];
  if (!Array.isArray(facts)) throw new Error("delegation facts are not an array");
  const encoder = new TextEncoder();
  let delegation = token;
  if (!facts.some((fact) => fact?.["xyz.tinycloud.policy/delegationMode"] === "terminal")) {
    payload.fct = [...facts, { ...TERMINAL_DELEGATION_FACT }];
    const signingInput = `${headerSegment}.${encodeBase64Url(encoder.encode(JSON.stringify(payload)))}`;
    delegation = `${signingInput}.${encodeBase64Url(ed25519.sign(encoder.encode(signingInput), privateKey))}`;
  }
  return { delegation, cid: CID.createV1(0x55, createDigest(0x1e, blake3(encoder.encode(delegation)))).toString() };
}
