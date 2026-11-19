/**
 * A real run of the TC-2377 requester machine: `driveApproval` with the real HTTP transport (`callApproval`), a real signed
 * request record and a real `approval-pending.v2.json` on disk, against a scripted OpenKey on 127.0.0.1. No network beyond
 * loopback; nothing is sent to OpenKey or TinyCloud.
 *
 *   bun scripts/approval-realrun.ts approve   # discover 202 then approved, fetch, ack 200: completed, entry removed, exit 0
 *   bun scripts/approval-realrun.ts decline   # discover 410 expired_request + status "denied": denied, entry removed, exit 3
 *   bun scripts/approval-realrun.ts ackfail   # approved, fetched, committed, ack 503: completed + ack-pending, entry kept, exit 6
 *
 * `verify` and `commit` stand in for the caller (the CLI or Courier decrypt and save the grant); everything else is the package.
 */
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  APPROVAL_FILE,
  approvalEntrySchema,
  callApproval,
  driveApproval,
  parseApprovalFile,
  prepareLinkRecord,
  serializeApprovalFile,
  signerFromSeed,
  type ApprovalEntry,
  type ApprovalFile,
  type CallOptions,
} from "../src/links/index.js";

const scenario = process.argv[2];
if (scenario !== "approve" && scenario !== "decline" && scenario !== "ackfail") {
  console.error("usage: bun scripts/approval-realrun.ts approve|decline|ackfail");
  process.exit(2);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const seed = randomBytes(32);
const signer = signerFromSeed(seed);
const signingKey = { kty: "OKP" as const, crv: "Ed25519" as const, x: b64(ed25519.getPublicKey(seed)), d: b64(seed) };
const requestId = Array.from(randomBytes(26), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
const resultRef = b64(randomBytes(24));
const now = Date.now();
const resultExpiresAt = new Date(Math.floor(now / 1000) * 1000 + 600_000).toISOString();

const request = {
  issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
  targetPublicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: signingKey.x },
  nodeOrigin: "https://node.example",
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
  grantLifetimeSeconds: 3_600,
  resultEncryptionPublicJwk: (() => {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    return { kty: "EC" as const, crv: "P-256" as const, x: key.x!, y: key.y! };
  })(),
};
const prepared = await prepareLinkRecord({
  type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(request)), issuerKey: signer,
  apiOrigin: "https://api.tinycloud.xyz", now, expiresAt: new Date(now + 3_600_000),
});

// The scripted OpenKey: it answers the exact wire shapes `classifyReply` reads.
let discovers = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(incoming) {
    const path = new URL(incoming.url).pathname;
    const proof = incoming.headers.get("openkey-session-proof") ? "proof" : "NO PROOF";
    console.log(`openkey: ${incoming.method} ${path.replace(requestId, ":requestId").replace(resultRef, ":resultRef")} (${proof})`);
    if (path === `/api/approval-requests/${requestId}/result`) {
      if (scenario === "decline") return Response.json({ error: "request expired", code: "expired_request", status: "denied" }, { status: 410 });
      if (discovers++ === 0) return Response.json({ status: "pending" }, { status: 202 });
      return Response.json({ status: "approved", resultRef, expiresAt: resultExpiresAt });
    }
    if (path === `/api/approval-results/${resultRef}/fetch`) {
      return Response.json({ requestId, bodyCid: prepared.bodyCid, resultRef, expiresAt: resultExpiresAt, relay: { sealed: "opaque" } });
    }
    if (path === `/api/approval-results/${resultRef}/ack`) {
      if (scenario === "ackfail") return Response.json({ error: "unavailable", code: "unavailable" }, { status: 503 });
      const body = await incoming.json() as { ackId: string };
      return Response.json({ ackId: body.ackId, status: "acknowledged" });
    }
    return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
  },
});
const apiOrigin = `http://127.0.0.1:${server.port}`;

// A real `approval-pending.v2.json`, written atomically with mode 0600 in a 0700 directory, as an adapter does.
const dir = mkdtempSync(join(tmpdir(), "approval-realrun-"));
const file = join(dir, APPROVAL_FILE);
const load = (): ApprovalFile => {
  if (!existsSync(file)) return { version: 2, entries: [], unrecognized: [] };
  const parsed = parseApprovalFile(JSON.parse(readFileSync(file, "utf8")), { now: Date.now() });
  if (parsed.kind !== "ok") throw new Error(`${APPROVAL_FILE}: ${parsed.kind}`);
  return parsed.file;
};
const save = (next: ApprovalFile): void => {
  writeFileSync(`${file}.tmp`, serializeApprovalFile(next), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

const entry: ApprovalEntry = approvalEntrySchema.parse({
  requestId, bodyCid: prepared.bodyCid, approvalUrl: `https://openkey.example/a/${requestId}#v=4&k=${prepared.key}`, request,
  record: prepared.record, apiOrigin, linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example",
  keys: { relayPrivateKey: b64(randomBytes(32)), stagedSigningKey: signingKey }, phase: "open", ackId: randomUUID(),
  createdAt: new Date(prepared.record.header.issuedAt).toISOString(), ext: {},
});
save({ version: 2, entries: [entry], unrecognized: [] });

const call = (action: "discover" | "fetch" | "ack") => (current: ApprovalEntry, options: CallOptions) => callApproval(
  { requestId: current.requestId, bodyCid: current.bodyCid, record: current.record, apiOrigin: current.apiOrigin, signingKey },
  action,
  { ...(current.resultRef === undefined ? {} : { resultRef: current.resultRef }),
    ...(current.resultExpiresAt === undefined ? {} : { resultExpiresAt: current.resultExpiresAt }), ackId: current.ackId },
  { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
);

const result = await driveApproval({
  store: {
    read: async (id) => load().entries.find((item) => item.requestId === id),
    write: async (next) => { const current = load(); save({ ...current, entries: [...current.entries.filter((item) => item.requestId !== next.requestId), next] }); },
    remove: async (id) => { const current = load(); save({ ...current, entries: current.entries.filter((item) => item.requestId !== id) }); },
  },
  transport: { discover: call("discover"), fetch: call("fetch"), ack: call("ack") },
  verify: async () => "ok",
  commit: async () => { console.log("caller: grant saved"); },
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
}, requestId);

const left = load().entries.find((item) => item.requestId === requestId);
console.log(`outcome: ${JSON.stringify(result.outcome)}`);
console.log(`entry on disk: ${left === undefined ? "removed" : `${left.phase}, keys ${left.keys === undefined ? "none" : Object.keys(left.keys).join("+")}`}`);
server.stop(true);
rmSync(dir, { recursive: true, force: true });
process.exit(result.exitCode);
