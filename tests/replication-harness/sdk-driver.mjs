import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const loader = process.env.TC893_LOADER;
if (!loader) throw new Error("DRIVER_CONFIG: TC893_LOADER is required");
const loaded = await import(pathToFileURL(loader).href);
const sdk = loaded.sdk;
const requests = new Map();
const active = new Set();
let node;
let savedSession;
let savedDeviceJwk;
let savedVerificationMethod;
let savedDelegation;
let savedPosture = "session-only";
let closing = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(line) { process.stdout.write(`${JSON.stringify(line)}\n`); }
function encoded(value) { return { $b64: Buffer.from(value).toString("base64") }; }
function decoded(value) { return value && typeof value.$b64 === "string" ? new Uint8Array(Buffer.from(value.$b64, "base64")) : value; }
function errorShape(error) { return { code: error?.code ?? error?.name ?? "DRIVER_ERROR", message: error?.message ?? String(error), name: error?.name, meta: error?.meta }; }
function sessionExpiry(session) {
  const direct = session?.expiresAt ?? session?.expirationTime;
  if (direct !== undefined && direct !== null) return direct;
  return typeof session?.siwe === "string" ? session.siwe.match(/^Expiration Time: (.+)$/m)?.[1] ?? null : null;
}
async function persistProof() {
  if (!process.env.TC893_HOME) return;
  const proof = savedPosture === "owner"
    ? { posture: "owner", session: savedSession, deviceJwk: savedDeviceJwk, verificationMethod: savedVerificationMethod, delegation: null }
    : savedPosture === "delegate-session" && savedDeviceJwk && savedVerificationMethod && savedDelegation
      ? { posture: "delegate-session", deviceJwk: savedDeviceJwk, verificationMethod: savedVerificationMethod, delegation: savedDelegation }
      : undefined;
  if (!proof) return;
  const path = `${process.env.TC893_HOME}/session.json`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
  await chmod(path, 0o600);
}
function captureEvent(event) { send({ v: 1, type: "event", inFlight: [...active], event }); }
function sdkValue(result) {
  if (result?.ok === false) return result;
  return result?.data ?? result;
}

function replicaOptions(config) {
  if (!config) return false;
  const { storageDir, ...options } = config;
  return { ...options, enabled: true, storage: sdk.sqliteReplicaStorage({ dir: storageDir }), onEvent: captureEvent };
}
function compactDelegateSession(proof, hosts) {
  const grant = proof?.delegation ?? proof;
  const jwk = proof?.deviceJwk ?? savedDeviceJwk ?? node?.sessionKeyJwk;
  const verificationMethod = proof?.verificationMethod ?? savedVerificationMethod ?? node?.sessionDid;
  if (!jwk || typeof verificationMethod !== "string" || !grant?.delegationHeader?.Authorization || !grant.cid || !grant.spaceId) {
    throw new Error("Delegate restore requires the device's own JWK, verification method, and delegation grant");
  }
  savedDeviceJwk = jwk;
  savedVerificationMethod = verificationMethod;
  return { delegationHeader: grant.delegationHeader, delegationCid: grant.cid, spaceId: grant.spaceId, jwk, verificationMethod, tinycloudHosts: hosts, grant };
}
async function handle(op, args, controller) {
  switch (op) {
    case "hello": return {
      driver: "tc893-sdk-driver",
      protocol: 1,
      node: process.versions.bun !== undefined ? `${process.version} (bun/${process.versions.bun})` : process.version,
      sdkVersion: sdk.version ?? "unknown",
      sdkResolved: loaded.resolved,
      exports: Object.keys(sdk).sort(),
    };
    case "init": {
      const replication = replicaOptions(args.replication);
      node = new sdk.TinyCloudNode({ host: args.host, domain: args.domain, privateKey: args.privateKeyHex, sessionExpirationMs: args.sessionExpiryMs, autoCreateSpace: true, autoBootstrapAccount: false, enablePublicSpace: false, ...(replication ? { replication } : {}) });
      savedPosture = args.privateKeyHex ? "owner" : "session-only";
      return { address: node.address ?? null };
    }
    case "signIn": {
      await node.signIn({ autoCreateSpace: true, autoBootstrapAccount: false, enablePublicSpace: false });
      savedSession = node.restorableSession;
      if (!savedSession) throw new Error("SDK returned no restorable session");
      savedDeviceJwk = savedSession.jwk;
      savedVerificationMethod = savedSession.verificationMethod;
      await persistProof();
      return { spaceId: savedSession.spaceId, sessionExpiresAt: sessionExpiry(savedSession) };
    }
    case "session.export": return { session: savedSession ?? node.restorableSession };
    case "session.restore": {
      savedPosture = "owner";
      await node.restoreSession({ ...args.session, tinycloudHosts: args.hosts });
      savedSession = { ...args.session, tinycloudHosts: args.hosts };
      savedDeviceJwk = savedSession.jwk;
      savedVerificationMethod = savedSession.verificationMethod;
      await persistProof();
      return { spaceId: savedSession.spaceId, sessionExpiresAt: sessionExpiry(savedSession) };
    }
    case "session.deviceKey": {
      if (savedPosture === "owner") throw Object.assign(new Error("Device key generation requires a session-only SDK driver"), { code: "CLIENT_UNSUPPORTED_OPTION" });
      savedDeviceJwk = node.sessionKeyJwk;
      savedVerificationMethod = node.sessionDid;
      if (!savedDeviceJwk || typeof savedVerificationMethod !== "string") throw new Error("SDK could not expose its generated session-only device key");
      return { did: savedVerificationMethod };
    }
    case "grant.issue": {
      const grant = await node.delegateTo(args.audience.split("#", 1)[0], args.caps.map((cap) => ({ service: "tinycloud.kv", space: node.restorableSession.spaceId, path: cap.prefix, actions: cap.actions })), { expiry: args.expiresInMs });
      if (grant?.ok === false) return grant;
      return { delegation: grant.delegation, cid: grant.delegation.cid, expiresAt: grant.delegation.expiry instanceof Date ? grant.delegation.expiry.toISOString() : String(grant.delegation.expiry) };
    }
    case "session.useDelegation": {
      const compact = compactDelegateSession(args.delegation, args.hosts);
      await node.restoreSession(compact);
      savedPosture = "delegate-session";
      savedSession = compact;
      savedDelegation = compact.grant;
      await persistProof();
      return { spaceId: compact.spaceId, sessionExpiresAt: sessionExpiry(compact) };
    }
    case "kv.get": {
      const result = await node.kv.get(args.key, { source: args.source, maxResponseBytes: args.maxResponseBytes, timeout: args.timeoutMs, space: args.space, signal: controller.signal, binary: true });
      if (result?.ok === false) return result.error?.code === "KV_NOT_FOUND" ? { found: false } : result;
      const value = sdkValue(result)?.data;
      return value === undefined || value === null ? { found: false } : { found: true, value: encoded(value) };
    }
    case "kv.put": return sdkValue(await node.kv.put(args.key, decoded(args.value), { contentType: args.contentType, timeout: args.timeoutMs, signal: controller.signal }));
    case "kv.delete": return sdkValue(await node.kv.delete(args.key, { timeout: args.timeoutMs, signal: controller.signal }));
    case "kv.list": return sdkValue(await node.kv.list({ prefix: args.prefix, source: args.source, limit: args.limit, cursor: args.cursor, timeout: args.timeoutMs, signal: controller.signal }));
    case "kv.batchPut": return sdkValue(await node.kv.batchPut(args.items.map((item) => ({ ...item, value: decoded(item.value) })), { timeout: args.timeoutMs, signal: controller.signal }));
    case "replication.status": return node.replication ? await node.replication.status() : [];
    case "replication.sync": {
      if (!node.replication) return { ok: false, error: { code: "REPLICATION_DISABLED", message: "Replication is disabled" } };
      await node.replication.sync({ prefix: args.prefix });
      return { ok: true };
    }
    case "replication.purge": return node.replication ? node.replication.purge({ timeoutMs: args.timeoutMs }) : { purged: [], failed: [] };
    case "replication.clearPending": return node.replication ? { cleared: await node.replication.clearPending() } : { cleared: 0 };
    case "cancel": {
      const target = requests.get(args.id);
      if (!target) return { cancelled: false };
      target.abort(new Error("Cancelled by client"));
      return { cancelled: true };
    }
    case "close": {
      await node?.replication?.close();
      closing = true;
      return { closed: true };
    }
    default: throw Object.assign(new Error(`Unknown RPC operation: ${op}`), { code: "DRIVER_UNKNOWN_OP" });
  }
}

for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.v !== 1 || !Number.isSafeInteger(request.id) || typeof request.op !== "string" || !request.args || typeof request.args !== "object") throw new Error("Invalid RPC request");
  } catch (error) {
    send({ v: 1, type: "response", id: request?.id ?? -1, ok: false, error: { code: "DRIVER_PROTOCOL", message: String(error) }, durationMs: 0 });
    continue;
  }
  const controller = new AbortController();
  requests.set(request.id, controller);
  active.add(request.id);
  const started = performance.now();
  Promise.resolve().then(() => handle(request.op, request.args, controller)).then((value) => {
    send({ v: 1, type: "response", id: request.id, ok: true, value, durationMs: performance.now() - started });
  }, (error) => {
    send({ v: 1, type: "response", id: request.id, ok: false, error: errorShape(error), durationMs: performance.now() - started });
  }).finally(() => {
    requests.delete(request.id);
    active.delete(request.id);
    if (closing && request.op === "close") setImmediate(() => process.exit(0));
  });
}
