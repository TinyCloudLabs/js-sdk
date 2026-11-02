// Test double of the OpenCredentials witness for `tinycloud.email-held/v1`, written from the TC-2254 contract v2.4
// (routes R0-R8, error envelope, binding of C4.2, credential of C5.3, result of C5.2) and its `vectors.json`.
// It is a stateful mini witness with a controllable SERVER clock, a mailbox that records every mail, and a call log, so
// tests can assert "zero network calls" and "zero mails". Not shipped: tests only.
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalDigest, jcsCanonicalize, type IssuerVerificationKey } from "@tinycloud/sdk-core";
import { toChecksumAddress } from "@tinycloud/sdk-core/held-credentials";
import { readFileSync } from "node:fs";
import type { HolderSigner } from "../email-proof";

export const WITNESS_ORIGIN = "https://witness.credentials.org";
const ISSUER_DID = "did:web:issuer.credentials.org";
const ISSUER_KID = `${ISSUER_DID}#controller`;
const ACCOUNT_DOMAIN = "tinycloud.credentials/account-binding/v1";
const HELD = "tinycloud.email-held/v1";
const PROTOCOL = "tinycloud.credentials/acquisition/v1";
export const HELD_DESCRIPTOR_DIGEST = "dc3_DuvzipXwYkTfjKqTaK1c3VS0YSPnaBsYSQriC0w";

// Read synchronously: this module is imported by many test files, and a top-level `await` in a shared module is evaluated late under Bun 1.3.14's
// single-worker `bun test packages/web-sdk/tests` (the Replica baseline job), so a test file could see `vectors` before it was initialised.
export const vectors = JSON.parse(readFileSync(new URL("../fixtures/held-wire-v2.4/vectors.json", import.meta.url), "utf8"));

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));
const rfc3339 = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const randomId = (bytes: number): string => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function uuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** EIP-191 `personal_sign` hash of `message` bytes. */
export function personalHash(message: Uint8Array): Uint8Array {
  return keccak_256(concat(text(`\x19Ethereum Signed Message:\n${message.length}`), message));
}

/** A test account holder: EIP-55 did, `blockchainAccountId` kid, EIP-191 signature (r‖s‖v, v 27/28). Counts wallet calls. */
export function testAccountHolder(privateKeyHex: string): HolderSigner & { readonly calls: { count: number; seen: Uint8Array[] }; readonly address: string } {
  const key = Uint8Array.from(Buffer.from(privateKeyHex.replace(/^0x/, ""), "hex"));
  const publicKey = secp256k1.getPublicKey(key, false).slice(1);
  const address = toChecksumAddress(`0x${hex(keccak_256(publicKey).slice(-20))}`);
  const did = `did:pkh:eip155:1:${address}`;
  const calls = { count: 0, seen: [] as Uint8Array[] };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls.count += 1;
    calls.seen.push(bytes);
    const signature = secp256k1.sign(personalHash(bytes), key);
    return concat(signature.toCompactRawBytes(), Uint8Array.of(27 + signature.recovery));
  };
  return { did, alg: "EIP191", kid: `${did}#blockchainAccountId`, sign, calls, address };
}

function recoverAddress(message: Uint8Array, signatureHex: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) return undefined;
  const raw = Uint8Array.from(Buffer.from(signatureHex.slice(2), "hex"));
  const v = raw[64]!;
  if (![0, 1, 27, 28].includes(v)) return undefined;
  try {
    const sig = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v >= 27 ? v - 27 : v);
    const publicKey = sig.recoverPublicKey(personalHash(message)).toRawBytes(false).slice(1);
    return toChecksumAddress(`0x${hex(keccak_256(publicKey).slice(-20))}`);
  } catch {
    return undefined;
  }
}

/** The fixed rule of OpenCredentials PR #205: lowercase body, or an uppercase-bearing body equal to the EIP-55 form. */
export function witnessAcceptsHolder(did: unknown): string | undefined {
  if (typeof did !== "string") return undefined;
  const match = /^did:pkh:eip155:1:0x([0-9a-fA-F]{40})$/.exec(did);
  if (!match) return undefined;
  const body = match[1]!;
  const checksum = toChecksumAddress(`0x${body.toLowerCase()}`);
  if (body === body.toLowerCase() || `0x${body}` === checksum) return `did:pkh:eip155:1:${checksum}`;
  return undefined;
}

/** The witness's email rules (C2.5.3): exact lowercase ASCII, 254 total, dotted domain, atoms, no empty `+` local. */
export function witnessAcceptsEmail(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 3 || value.length > 254) return false;
  if (value !== value.toLowerCase() || /[^\x21-\x7e]/.test(value) || value.split("@").length !== 2) return false;
  const [local, domain] = value.split("@") as [string, string];
  if (local.length === 0 || local.length > 64 || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)) return false;
  if (local.split("+")[0] === "" || !domain.includes(".") || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return domain.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

export interface RecordedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}
export type WitnessRoute = "catalog" | "create" | "state" | "challenge" | "proof" | "holder-binding" | "holder-signature" | "issue" | "result";

export interface HeldWitnessOptions {
  /** The witness's own clock, in epoch ms. Tests shift it against the client's clock. */
  readonly serverClock?: () => number;
  /** Catalog `enabled`. The held entry is always listed. */
  readonly capability?: boolean;
  readonly otp?: string;
  readonly issuerSeed?: Uint8Array;
  /** Replaces the held descriptor in the catalog (digest recomputed by the caller if needed). */
  readonly catalogDescriptor?: Record<string, unknown>;
  /** The `descriptorDigest` the catalog entry advertises (default: the pinned held digest). */
  readonly catalogDigest?: string;
  /** The first call on `route` answers with this recorded response instead (the handler is not run). */
  readonly force?: Partial<Record<WitnessRoute, RecordedResponse>>;
  /** Mutates the binding the witness serves AND recomputes for R6 (a malicious or buggy witness). */
  readonly mutateBinding?: (binding: Record<string, unknown>) => Record<string, unknown>;
  /** Mutates the result body (a malicious or buggy witness). */
  readonly mutateResult?: (result: Record<string, unknown>) => Record<string, unknown>;
  /** The mailbox the credential (and the result) discloses, instead of the one the request proved: a witness that issues for another address. */
  readonly issueEmail?: string;
  /** The mailbox only the signed credential discloses; the result envelope still names the requested mailbox. */
  readonly credentialEmail?: string;
  /** The first N issue (R7) calls fail with 503 DELIVERY_FAILED: the notice mail is not sent and the record stays ready_to_issue (OC mod.rs:2453-2458). */
  readonly failNotice?: number;
  /** Mutates the binding the witness serves from the SECOND R5 on only (a witness that changes its binding on a retry). R6 is not affected. */
  readonly retryBinding?: (binding: Record<string, unknown>) => Record<string, unknown>;
  /** Mutates the credential payload before signing. */
  readonly mutatePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  /** Called after each route, e.g. to advance the clocks to model a slow user. */
  readonly onRoute?: (route: WitnessRoute) => void;
}

interface Record_ {
  id: string;
  verifierChallenge: string;
  holderDid: string;
  email: string;
  requirementDigest: string;
  openerOrigin: string;
  completionContext: string;
  audience: string;
  createdMs: number;
  expiresSec: number;
  nonce?: string;
  challengeAtMs?: number;
  attempts: number;
  proved: boolean;
  bindingServed: boolean;
  bindingServes: number;
  noticeFailures: number;
  signed: boolean;
  jti: string;
  result?: Record<string, unknown>;
}

export function createHeldWitness(options: HeldWitnessOptions = {}) {
  const clock = options.serverClock ?? (() => Date.now());
  const seed = options.issuerSeed ?? new Uint8Array(32).fill(7);
  const issuerX = b64u(ed25519.getPublicKey(seed));
  const records = new Map<string, Record_>();
  const calls: { readonly method: string; readonly route: WitnessRoute; readonly id?: string }[] = [];
  const mails: { readonly kind: "code" | "notice"; readonly to: string; readonly code?: string; readonly requestId: string }[] = [];
  const forced: Partial<Record<WitnessRoute, RecordedResponse>> = { ...(options.force ?? {}) };
  const descriptor = options.catalogDescriptor ?? vectors.descriptor.held;

  const respond = (r: RecordedResponse): Response =>
    new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  const failure = (status: number, code: string, state: string, recoverable: boolean, headers: Record<string, string> = {}): RecordedResponse =>
    ({ status, headers, body: { code, correlationId: randomId(12).slice(0, 16), recoverable, state, type: "tinycloud.credentials/error/v1" } });
  const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();

  const bindingFor = (record: Record_): Record<string, unknown> => {
    const binding = {
      audience: record.audience,
      challengeNonce: record.nonce ?? "",
      completionContext: record.completionContext,
      completionOrigin: record.openerOrigin,
      credentialLifetimeSeconds: 31_536_000,
      descriptorDigest: HELD_DESCRIPTOR_DIGEST,
      expiresAt: rfc3339(record.expiresSec * 1000),
      holderDid: record.holderDid,
      issuedAt: rfc3339((record.expiresSec - 600) * 1000),
      issuer: ISSUER_DID,
      issuerKid: ISSUER_KID,
      jti: record.jti,
      normalizedClaimsDigest: "",
      openerOrigin: record.openerOrigin,
      profile: HELD,
      profileVersion: 1,
      protocol: PROTOCOL,
      requestId: record.id,
      requirementDigest: record.requirementDigest,
      type: ACCOUNT_DOMAIN,
    };
    binding.normalizedClaimsDigest = b64u(sha256(text(jcsCanonicalize({ email: record.email }))));
    return options.mutateBinding ? options.mutateBinding(binding) : binding;
  };

  const issue = (record: Record_, nowMs: number): Record<string, unknown> => {
    const iat = Math.floor(nowMs / 1000);
    const salt = () => randomId(16);
    const email = options.issueEmail ?? record.email;
    const disclosed = options.credentialEmail ?? email;
    const parts = [[salt(), "email", disclosed], [salt(), "emailDomain", disclosed.split("@")[1]]];
    const disclosures = parts.map((part) => b64u(text(JSON.stringify(part))));
    const holderBinding = { did: record.holderDid, signingDomain: ACCOUNT_DOMAIN };
    let payload: Record<string, unknown> = {
      _sd: disclosures.map((d) => b64u(sha256(text(d)))),
      _sd_alg: "sha-256",
      exp: iat + 31_536_000,
      holderBinding,
      iat,
      iss: ISSUER_DID,
      jti: record.jti,
      nbf: iat,
      profile: HELD,
      profileVersion: 1,
      status: { method: "none" },
      sub: record.holderDid,
      vct: "opencredentials.email/v1",
    };
    if (options.mutatePayload) payload = options.mutatePayload(payload);
    const signingInput = `${b64u(text(JSON.stringify({ alg: "EdDSA", typ: "vc+sd-jwt", kid: ISSUER_KID })))}.${b64u(text(JSON.stringify(payload)))}`;
    const credential = `${signingInput}.${b64u(ed25519.sign(text(signingInput), seed))}~${disclosures.join("~")}~`;
    const result = {
      claims: { email, emailDomain: email.split("@")[1] },
      credential,
      credentialDigest: b64u(sha256(text(credential))),
      descriptorDigest: HELD_DESCRIPTOR_DIGEST,
      format: "vc+sd-jwt",
      holderBinding,
      issuer: ISSUER_DID,
      issuerKid: ISSUER_KID,
      profile: HELD,
      profileVersion: 1,
      protocol: PROTOCOL,
      status: { freshnessSeconds: 300, type: "none" },
      subject: record.holderDid,
      type: "tinycloud.credentials/result/v1",
      validity: { expiresAt: rfc3339((iat + 31_536_000) * 1000), issuedAt: rfc3339(iat * 1000) },
    };
    return options.mutateResult ? options.mutateResult(result) : result;
  };

  const handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const authorization = new Headers(init?.headers).get("authorization");
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const nowMs = clock();
    const finish = (route: WitnessRoute, response: RecordedResponse, id?: string): Response => {
      calls.push({ method, route, id });
      const out = forced[route] ? (() => { const f = forced[route]!; delete forced[route]; return respond(f); })() : respond(response);
      options.onRoute?.(route);
      return out;
    };
    if (url.origin !== WITNESS_ORIGIN) return new Response("not found", { status: 404 });

    if (url.pathname === "/.well-known/opencredentials") {
      const enabled = options.capability !== false;
      const entry = { descriptor, descriptorDigest: options.catalogDigest ?? HELD_DESCRIPTOR_DIGEST, enabled, profile: HELD, profileVersion: 1, readiness: enabled ? "ready" : "disabled", supported: true };
      return finish("catalog", { status: 200, body: { type: "tinycloud.credentials/catalog/v1", protocol: PROTOCOL, catalogVersion: 1, canonicalization: "RFC8785", digest: "sha-256-base64url-nopad", profiles: [entry] } });
    }

    if (url.pathname === "/v1/acquisitions" && method === "POST") {
      let body: unknown;
      try { body = raw === undefined ? undefined : JSON.parse(raw); } catch { return finish("create", failure(400, "MALFORMED_JSON", "request_rejected", false)); }
      const keys = ["audience", "completionContext", "completionOrigin", "completionVerifierChallenge", "descriptorDigest", "holderDid", "inputs", "openerOrigin", "profile", "profileVersion", "protocol", "requirementDigest"];
      if (!exactKeys(body, keys)) return finish("create", failure(400, "MALFORMED_REQUEST", "request_rejected", false));
      if (options.capability === false || body.profile !== HELD) return finish("create", failure(400, "UNSUPPORTED_PROFILE", "unsupported_profile", true));
      if (body.protocol !== PROTOCOL || body.profileVersion !== 1) return finish("create", failure(400, "UNSUPPORTED_VERSION", "unsupported_profile", false));
      if (body.descriptorDigest !== HELD_DESCRIPTOR_DIGEST) return finish("create", failure(400, "DESCRIPTOR_MISMATCH", "unsupported_profile", false));
      const holderDid = witnessAcceptsHolder(body.holderDid);
      if (holderDid === undefined) return finish("create", failure(400, "INVALID_HOLDER", "request_rejected", false));
      if (!exactKeys(body.inputs, ["email"]) || !witnessAcceptsEmail(body.inputs.email)) return finish("create", failure(400, "MALFORMED_INPUT", "request_rejected", false));
      if (body.openerOrigin !== body.completionOrigin || !/^https:\/\/[^/?#@]+$/.test(String(body.openerOrigin))) return finish("create", failure(400, "ORIGIN_REJECTED", "request_rejected", false));
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(body.completionVerifierChallenge))) return finish("create", failure(400, "MALFORMED_VERIFIER_CHALLENGE", "request_rejected", false));
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(body.requirementDigest))) return finish("create", failure(400, "MALFORMED_DIGEST", "request_rejected", false));
      const id = randomId(24);
      const record: Record_ = {
        id, verifierChallenge: String(body.completionVerifierChallenge), holderDid, email: String(body.inputs.email), requirementDigest: String(body.requirementDigest),
        openerOrigin: String(body.openerOrigin), completionContext: String(body.completionContext), audience: String(body.audience),
        createdMs: nowMs, expiresSec: Math.floor(nowMs / 1000) + 600, attempts: 0, proved: false, bindingServed: false, bindingServes: 0, noticeFailures: 0, signed: false, jti: uuidV4(),
      };
      records.set(id, record);
      return finish("create", { status: 201, body: { endpoint: "challenge", expiresAt: rfc3339(record.expiresSec * 1000), next: "challenge", protocol: PROTOCOL, requestId: id, type: "tinycloud.credentials/acquisition-request/v1" } }, id);
    }

    const match = /^\/v1\/acquisitions\/([^/]+)\/(state|challenge|proof|holder-binding|holder-signature|issue|result)$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const [, id, routeName] = match as unknown as [string, string, WitnessRoute];
    const route = routeName;
    const record = records.get(id);
    const verifier = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!record || verifier === undefined || b64u(sha256(text(verifier))) !== record.verifierChallenge) return finish(route, failure(401, "AUTHENTICATION_REQUIRED", "authentication_required", true), id);
    if (nowMs >= record.expiresSec * 1000) return finish(route, failure(410, "REQUEST_EXPIRED", "expired", true), id);
    let body: unknown;
    if (method === "POST" && raw !== undefined) { try { body = JSON.parse(raw); } catch { return finish(route, failure(400, "MALFORMED_JSON", "request_rejected", false), id); } }

    switch (route) {
      case "state": {
        const state = record.result ? "issued" : record.signed ? "ready_to_issue" : record.bindingServed ? "holder_signature_required" : record.proved ? "holder_binding_required" : record.nonce ? "proof_required" : "challenge_required";
        return finish(route, { status: 200, body: { challengeNonce: record.nonce ?? null, expiresAt: rfc3339(record.expiresSec * 1000), openerOrigin: record.openerOrigin, profile: HELD, profileVersion: 1, requestId: id, resultAvailable: Boolean(record.result), resultPreviouslyRead: false, state, type: "tinycloud.credentials/acquisition-state/v1" } }, id);
      }
      case "challenge": {
        if (!exactKeys(body, ["step", "stepVersion"]) || body.step !== "mailbox_otp" || body.stepVersion !== 1) return finish(route, failure(400, "UNSUPPORTED_STEP", "unsupported_profile", false), id);
        if (record.nonce !== undefined) return finish(route, failure(409, "CHALLENGE_REPLAYED", "challenge_replayed", false), id);
        record.nonce = randomId(24);
        record.challengeAtMs = nowMs;
        const code = options.otp ?? "12345678";
        mails.push({ kind: "code", to: record.email, code, requestId: id });
        return finish(route, { status: 200, body: { attemptsRemaining: 5, challengeNonce: record.nonce, expiresAt: rfc3339(nowMs + 300_000), step: "mailbox_otp", stepVersion: 1, type: "tinycloud.credentials/challenge/v1" } }, id);
      }
      case "proof": {
        if (!exactKeys(body, ["challengeNonce", "proof", "step", "stepVersion"])) return finish(route, failure(400, "MALFORMED_REQUEST", "request_rejected", false), id);
        if (record.nonce === undefined) return finish(route, failure(400, "INVALID_STATE", "challenge_required", false), id);
        if (record.proved || record.attempts >= 5) return finish(route, failure(409, "CHALLENGE_REPLAYED", "challenge_replayed", false), id);
        if (body.challengeNonce !== record.nonce) return finish(route, failure(400, "MALFORMED_REQUEST", "request_rejected", false), id);
        record.attempts += 1;
        const proof = body.proof as Record<string, unknown>;
        if (!exactKeys(proof, ["otp"]) || proof.otp !== (options.otp ?? "12345678")) return finish(route, failure(422, "PROOF_REJECTED", "proof_rejected", record.attempts < 5), id);
        record.proved = true;
        return finish(route, { status: 200, body: { next: "holder_binding", type: "tinycloud.credentials/proof-result/v1", verified: true } }, id);
      }
      case "holder-binding": {
        if (!record.proved) return finish(route, failure(400, "INVALID_STATE", "proof_required", false), id);
        record.bindingServed = true;
        record.bindingServes += 1;
        const binding = record.bindingServes > 1 && options.retryBinding ? options.retryBinding(bindingFor(record)) : bindingFor(record);
        return finish(route, { status: 200, body: { alg: "EIP191", binding, canonical: b64u(text(jcsCanonicalize(binding))), signingDomain: ACCOUNT_DOMAIN, type: "tinycloud.credentials/holder-binding-request/v1" } }, id);
      }
      case "holder-signature": {
        if (!exactKeys(body, ["alg", "kid", "signature"])) return finish(route, failure(400, "MALFORMED_REQUEST", "request_rejected", false), id);
        if (record.signed) return finish(route, failure(409, "SIGNATURE_REPLAYED", "signature_replayed", false), id);
        if (!record.bindingServed) return finish(route, failure(400, "INVALID_STATE", "holder_binding_required", false), id);
        const rejected = failure(400, "SIGNATURE_REJECTED", "signature_rejected", true);
        if (body.alg !== "EIP191" || body.kid !== `${record.holderDid}#blockchainAccountId` || typeof body.signature !== "string") return finish(route, rejected, id);
        const input = concat(text(ACCOUNT_DOMAIN), Uint8Array.of(0), text(jcsCanonicalize(bindingFor(record))));
        const recovered = recoverAddress(input, body.signature);
        if (recovered === undefined || `did:pkh:eip155:1:${recovered}` !== record.holderDid) return finish(route, rejected, id);
        record.signed = true;
        return finish(route, { status: 200, body: { next: "issue", type: "tinycloud.credentials/holder-signature-result/v1", verified: true } }, id);
      }
      case "issue": {
        if (!record.signed) return finish(route, failure(400, "INVALID_STATE", "holder_signature_required", false), id);
        if (!record.result && record.noticeFailures < (options.failNotice ?? 0)) {
          record.noticeFailures += 1;
          return finish(route, failure(503, "DELIVERY_FAILED", "delivery_failed", true), id);
        }
        if (!record.result) {
          record.result = issue(record, nowMs);
          mails.push({ kind: "notice", to: record.email, requestId: id });
        }
        return finish(route, { status: 200, body: { credentialDigest: record.result.credentialDigest, format: "vc+sd-jwt", next: "result", status: "issued", type: "tinycloud.credentials/issuance-result/v1" } }, id);
      }
      case "result": {
        if (!record.result) return finish(route, failure(400, "INVALID_STATE", "issuance_required", false), id);
        return finish(route, { status: 200, body: record.result }, id);
      }
      default:
        return new Response("not found", { status: 404 });
    }
  };

  const fetch = Object.assign(handle, { preconnect: () => {} }) as typeof globalThis.fetch;
  const issuerKeys: readonly IssuerVerificationKey[] = [{ kid: ISSUER_KID, alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: issuerX }, validFrom: "2020-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" }];
  return { fetch, calls, mails, records, issuerKeys, force: forced, descriptorDigest: HELD_DESCRIPTOR_DIGEST, issuerX, descriptorCanonical: () => canonicalDigest(descriptor) };
}
