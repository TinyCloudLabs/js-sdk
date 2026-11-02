import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";
import { checkLinkRecord, resolveApprovalRequest, signerFromJwk, type CheckedLinkRecord, type LinkRecord, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { canonicalize } from "@tinycloud/share-envelope";
import { profilePath } from "@tinycloud/operations/state";

// TC-2299 real-node e2e for `tinycloud auth grant --timeout`, on the fixture of agent-grant-openkey.e2e.test.ts
// (an OpenKey owner profile with a broad 3 h session and a fake OpenKey that signs the requested scope with the
// owner wallet). A new approval link exits 8 at once, a resumed one waits to the deadline, an approval that
// arrives is collected and exits 0, and a process SIGKILLed at each seam resumes with no new request and one ack.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const OWNER_SESSION_MS = 3 * 3600_000;
const SEVEN_DAYS_S = 7 * 86400;
const hoursUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 3600_000;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("auth grant --timeout, against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let ownerSigner: PrivateKeySigner;
  let appSpace: string;
  const wasm = new NodeWasmBindings();

  interface ApprovalFixtureEntry {
    id: string;
    record: LinkRecord;
    checked: CheckedLinkRecord;
    resultRef?: string;
    resultExpiresAt?: string;
    relay?: Record<string, unknown>;
    ackId?: string;
    preparedRequestId?: string;
    agentTargetDid?: string;
    expired?: boolean;
    /** OpenKey answers a discover like production does for an expired request: HTTP 400 invalid_request. */
    invalidRequest?: boolean;
    polls: number;
    homeOpened?: boolean;
  }
  let approvalServer: ReturnType<typeof Bun.serve> | undefined;
  let approvalCertificate = "";
  let approvalCertificatePath = "";
  let requesterDid = "";
  let requesterJwk: OpenKeyApprovalRequestV1["targetPublicJwk"] | undefined;
  let priorTcHome: string | undefined;
  const approvalRequests = new Map<string, ApprovalFixtureEntry>();
  const approvalResults = new Map<string, ApprovalFixtureEntry>();
  const seenProofs = new Set<string>();
  const ackEvidence: Array<{ requestId: string; resultRef: string; ackId: string; childCid: string; intent: string; filesMatch: boolean }> = [];

  async function observeDurableCommand(entry: ApprovalFixtureEntry, ackId: string) {
    const { profilePath } = await import("@tinycloud/operations/state");
    const directory = profilePath("owner");
    const pending = JSON.parse(await readFile(join(directory, "approval-pending.json"), "utf8"));
    const saved = pending.find((item: { requestId: string }) => item.requestId === entry.id);
    const artifacts = JSON.parse(await readFile(join(directory, "auth-grant-artifacts.json"), "utf8"));
    const history = (await readFile(join(directory, "auth-grants.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const result = saved?.command?.result;
    const filesMatch = saved?.ackId === ackId && saved?.command?.request?.requestId === entry.preparedRequestId &&
      result?.requestId === entry.preparedRequestId && result?.delegation?.delegateDID === entry.agentTargetDid &&
      artifacts.some((item: { delegationCid: string }) => item.delegationCid === result?.delegationCid) &&
      history.some((item: { delegationCid: string }) => item.delegationCid === result?.delegationCid);
    if (!filesMatch) throw new Error("ACK arrived before the matching command result and history were saved");
    ackEvidence.push({ requestId: entry.id, resultRef: entry.resultRef!, ackId,
      childCid: result.delegationCid, intent: saved.commandIntent, filesMatch });
  }

  function validRequesterProof(request: Request, entry: ApprovalFixtureEntry, action: string, body: Record<string, unknown>): boolean {
    if (!requesterJwk || body.bodyCid !== entry.record.header.bodyCid ||
      (action !== "discover" && body.requestId !== entry.id)) return false;
    try {
      const parts = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
      if (parts.length !== 3) return false;
      const [header, payload, signature] = parts as [string, string, string];
      if (!verify(null, Buffer.from(header + "." + payload), createPublicKey({ key: requesterJwk, format: "jwk" }), Buffer.from(signature, "base64url"))) return false;
      const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const kid = createHash("sha256").update(JSON.stringify({ crv: requesterJwk.crv, kty: requesterJwk.kty, x: requesterJwk.x })).digest("base64url");
      const credential = JSON.stringify([action, entry.id, entry.record.header.bodyCid,
        action === "discover" ? "" : entry.resultRef, action === "ack" ? body.ackId : ""]);
      if (decodedHeader.alg !== "EdDSA" || decodedHeader.typ !== "openkey-session-proof+jwt" || decodedHeader.kid !== kid ||
        claims.client_id !== "openkey-approval-result-v1" || claims.htm !== "POST" || claims.htu !== request.url ||
        claims.cred_hash !== createHash("sha256").update(credential).digest("base64url") ||
        typeof claims.iat !== "number" || Math.abs(Date.now() / 1000 - claims.iat) > 60 ||
        typeof claims.jti !== "string" || !claims.jti || seenProofs.has(claims.jti)) return false;
      seenProofs.add(claims.jti);
      return true;
    } catch { return false; }
  }

  async function approvalFixtureResponse(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/links") {
      const record = await request.json() as LinkRecord;
      const checked = await checkLinkRecord(record, Date.now());
      if (!record.signature || checked.header.type !== "openkey-approval-request" ||
        checked.header.audience !== approvalServer!.url.origin || checked.header.issuer !== requesterDid) return new Response(null, { status: 401 });
      const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
      approvalRequests.set(id, { id, record, checked, polls: 0 });
      return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
    }
    const read = path.match(/^\/v1\/links\/([a-z2-7]{26})$/);
    if (request.method === "GET" && read) {
      const entry = approvalRequests.get(read[1]!);
      if (!entry || Date.parse(entry.record.header.expiresAt) <= Date.now()) return new Response(null, { status: 404 });
      return new Response(entry.checked.body, { headers: {
        "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
        "X-Link-Record": Buffer.from(canonicalize({ header: entry.record.header, signature: entry.record.signature })).toString("base64url"),
      } });
    }
    const discovery = path.match(/^\/api\/approval-requests\/([a-z2-7]{26})\/result$/);
    const delivery = path.match(/^\/api\/approval-results\/([A-Za-z0-9_-]+)\/(fetch|ack)$/);
    const entry = discovery ? approvalRequests.get(discovery[1]!) : delivery ? approvalResults.get(delivery[1]!) : undefined;
    if (request.method !== "POST" || !entry) return new Response(null, { status: 404 });
    const action = discovery ? "discover" : delivery![2]!;
    const body = await request.json() as Record<string, unknown>;
    if (!validRequesterProof(request, entry, action, body)) return new Response(null, { status: 401 });
    if (entry.ackId) return action === "ack" && body.ackId === entry.ackId
      ? Response.json({ ackId: entry.ackId, status: "acknowledged" })
      : Response.json({ code: "result_acknowledged" }, { status: 410 });
    if (discovery) entry.polls++;
    if (discovery && entry.invalidRequest) return Response.json({ error: "Signed approval request header is invalid or expired", code: "invalid_request" }, { status: 400 });
    if (!entry.relay) return entry.expired || Date.parse(entry.record.header.expiresAt) <= Date.now()
      ? Response.json({ code: "expired_request" }, { status: 410 }) : new Response(null, { status: 202 });
    if (Date.parse(entry.resultExpiresAt!) <= Date.now()) return Response.json({ code: "expired_result" }, { status: 410 });
    if (action === "discover") return Response.json({ resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt });
    if (action === "fetch") {
      return Response.json({ requestId: entry.id, bodyCid: entry.record.header.bodyCid,
        resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt, relay: entry.relay });
    }
    if (typeof body.ackId !== "string" || !body.ackId) return new Response(null, { status: 400 });
    await observeDurableCommand(entry, body.ackId);
    entry.ackId = body.ackId;
    entry.relay = undefined;
    return Response.json({ ackId: entry.ackId, status: "acknowledged" });
  }


  const home = (profile: string) => join(root, `home-${profile}`);

  function cliArgs(profile: string, args: string[], extraEnv: Record<string, string> = {}, preload?: string) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    delete env.TC_OPENKEY_HOST;
    env.TC_AUTH_NO_POPUP = "1";
    env.TC_OPENKEY_API_HOST = approvalServer!.url.origin;
    env.TC_LINKS_API_ORIGIN = approvalServer!.url.origin;
    env.NODE_EXTRA_CA_CERTS = approvalCertificatePath;
    env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    Object.assign(env, extraEnv);
    return { argv: [process.execPath, ...(preload ? ["--preload", preload] : []), cliEntry, "--host", host, "--profile", profile, ...args], env };
  }

  async function cli(profile: string, args: string[]) {
    const { argv, env } = cliArgs(profile, args);
    const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  function abilitiesOf(permissions: PermissionEntry[]) {
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const p of permissions) {
      const service = p.service.slice("tinycloud.".length);
      abilities[service] = {
        ...abilities[service],
        [p.path]: [...new Set([...(abilities[service]?.[p.path] ?? []), ...p.actions])],
      };
    }
    return abilities;
  }


  async function agentRequest(name: string, args: string[]) {
    await mkdir(home(name), { recursive: true });
    const created = await cli(name, ["profile", "create", name, "--posture", "delegate-session", "--operator", "agent"]);
    expect(created.exitCode).toBe(0);
    const file = join(root, `${name}-req.json`);
    const made = await cli(name, ["auth", "request", ...args, "--emit", file]);
    expect(made.exitCode).toBe(0);
    return file;
  }


  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-agent-openkey-e2e-"));
    priorTcHome = process.env.TC_HOME;
    process.env.TC_HOME = home("owner");
    approvalCertificatePath = join(root, "approval-cert.pem");
    const approvalKeyPath = join(root, "approval-key.pem");
    const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", approvalKeyPath, "-out", approvalCertificatePath],
      { stdout: "pipe", stderr: "pipe" });
    const [, certificateError, certificateExit] = await Promise.all([new Response(certificate.stdout).text(), new Response(certificate.stderr).text(), certificate.exited]);
    if (certificateExit !== 0) throw new Error("Fixture TLS setup failed: " + certificateError);
    approvalCertificate = await readFile(approvalCertificatePath, "utf8");
    approvalServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
      tls: { key: Bun.file(approvalKeyPath), cert: approvalCertificate }, fetch: approvalFixtureResponse });
    const { profileConfigPath, profilePath, sessionPath, tinycloudConfigPath, writeJsonAtomic } = await import(
      "@tinycloud/operations/state"
    );

    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    host = `http://127.0.0.1:${port}`;
    node = spawn(NODE_BIN!, [], {
      cwd: root,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(root, "data"),
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = Promise.withResolvers<void>();
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    node.stdout!.on("data", onData);
    node.stderr!.on("data", onData);
    await launched.promise;

    // The owner wallet (local key) hosts the applications space and seeds one document.
    await mkdir(home("lowner"), { recursive: true });
    expect((await cli("lowner", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("lowner", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    expect(
      (await cli("lowner", ["auth", "request", "--cap", "tinycloud.kv:applications::get,list,put,del", "--grant", "--yes"]))
        .exitCode,
    ).toBe(0);
    expect((await cli("lowner", ["space", "create", "applications"])).exitCode).toBe(0);
    expect(
      (await cli("lowner", ["kv", "put", "--space", "applications", "demo/knowledge/a.md", "hello-tc1422"])).exitCode,
    ).toBe(0);
    let ownerKey = "";
    for await (const file of new Bun.Glob("**/profile.json").scan({ cwd: home("lowner"), dot: true, absolute: true })) {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && "privateKey" in parsed && typeof parsed.privateKey === "string") {
        ownerKey = parsed.privateKey;
      }
    }
    ownerSigner = new PrivateKeySigner(ownerKey.replace(/^0x/, ""));
    const ownerAddress = await ownerSigner.getAddress();
    appSpace = wasm.makeSpaceId(ownerAddress, 1, "applications");
    const ownerDid = `did:pkh:eip155:1:${ownerAddress}`;

    // OpenKey owner profile: a broad 3 h session on applications.
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const sessionDid = manager.getDID("default");
    requesterDid = signerFromJwk(jwk).did;
    requesterJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    const now = Date.now();
    const expiresAt = new Date(now + OWNER_SESSION_MS).toISOString();
    const prepared = wasm.prepareSession({
      abilities: {
        kv: { "": ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] },
        sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write"] },
        capabilities: { "": ["tinycloud.capabilities/read"] },
      },
      address: ownerAddress,
      chainId: 1,
      domain: "cli.tinycloud.xyz",
      spaceId: appSpace,
      jwk,
      issuedAt: new Date(now - 1000).toISOString(),
      expirationTime: expiresAt,
    });
    const signature = await ownerSigner.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    await activateSessionWithHost(host, session.delegationHeader);
    await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "owner", version: 1 });
    await writeJsonAtomic(profileConfigPath("owner"), {
      name: "owner",
      host,
      chainId: 1,
      spaceName: "applications",
      spaceId: appSpace,
      did: sessionDid,
      sessionDid,
      ownerDid,
      authMethod: "openkey",
      posture: "owner-openkey",
      operatorType: "human",
      createdAt: "2026-10-21T00:00:00.000Z",
      openkeyHost: "https://openkey.so",
    });
    await writeJsonAtomic(join(profilePath("owner"), "key.json"), jwk);
    await writeJsonAtomic(sessionPath("owner"), {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      jwk,
      address: ownerAddress,
      chainId: 1,
      spaceId: appSpace,
      verificationMethod: sessionDid,
      siwe: prepared.siwe,
      signature,
      ownerDid,
      expiresAt,
      tinycloudHosts: [host],
    });
  });

  afterAll(async () => {
    try {
    } finally {
      approvalServer?.stop(true);
      if (priorTcHome === undefined) delete process.env.TC_HOME; else process.env.TC_HOME = priorTcHome;
      node?.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  });


  const killPreload = async () => {
    const path = join(root, "kill-seam.ts");
    await writeFile(path, `import { readFileSync } from "node:fs";
const seam = process.env.TC_KILL_SEAM;
const die = () => process.kill(process.pid, "SIGKILL");
const actualFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (seam === "before-ack" && url.pathname.endsWith("/ack")) die();
  const response = await actualFetch(input, init);
  if (seam === "after-poll" && /\\/api\\/approval-requests\\/[^/]+\\/result$/.test(url.pathname) && response.status === 200) die();
  if (seam === "after-fetch" && url.pathname.endsWith("/fetch") && response.ok) {
    const read = response.json.bind(response);
    Object.defineProperty(response, "json", { value: async () => { const value = await read(); die(); return value; } });
  }
  return response;
}) as typeof fetch;
if (seam === "after-save") {
  // Die when the process next asks for the profile lock after a result was saved: outside any held lock.
  const fsp = require("node:fs/promises");
  const mkdir = fsp.mkdir;
  fsp.mkdir = async (path: string, ...rest: unknown[]) => {
    if (String(path).includes("/profile-locks")) {
      try {
        const saved = JSON.parse(readFileSync(process.env.TC_KILL_PENDING_FILE!, "utf8")) as Array<{ requestId: string; resultEnvelope?: unknown }>;
        if (saved.some((item) => item.requestId === process.env.TC_KILL_REQUEST_ID && item.resultEnvelope !== undefined)) die();
      } catch {}
    }
    return mkdir(path, ...rest);
  };
}
`, { mode: 0o600 });
    return path;
  };

  async function run(requestFile: string, extra: string[], options: { seam?: string; requestId?: string; stdin?: string /* a file whose content is the stdin */; during?: () => Promise<void> } = {}) {
    const pendingFile = join(profilePath("owner"), "approval-pending.json");
    const { argv, env } = cliArgs("owner", ["auth", "grant", requestFile, "--yes", ...extra],
      options.seam ? { TC_KILL_SEAM: options.seam, TC_KILL_PENDING_FILE: pendingFile, TC_KILL_REQUEST_ID: options.requestId ?? "" } : {},
      options.seam ? await killPreload() : undefined);
    const started = Date.now();
    const child = Bun.spawn(argv, { env, stdin: options.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (options.stdin !== undefined) {
      child.stdin!.write(await readFile(options.stdin, "utf8"));
      await child.stdin!.end();
    }
    try {
      const watching = options.during?.();
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await watching;
      return { exitCode, signalCode: child.signalCode, stdout, stderr, ms: Date.now() - started };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
  }

  async function until(condition: () => boolean, what: string): Promise<void> {
    const limit = Date.now() + 60_000;
    while (!condition()) {
      if (Date.now() > limit) throw new Error("Timed out waiting for " + what);
      await Bun.sleep(25);
    }
  }

  const linkOf = (stderr: string) => [...stderr.matchAll(/Approve this request in OpenKey: (https:\/\/\S+)/g)].at(-1)?.[1];

  /** The link the CLI printed, opened the way OpenKey opens it. */
  async function openLink(stderr: string, preparedRequest: { requestId: string; sessionDid: string }) {
    const url = linkOf(stderr);
    if (!url) throw new Error("No approval link on stderr: " + stderr);
    const opened = await resolveApprovalRequest(url, {
      trustedOrigins: ["https://openkey.so"], apiOrigin: approvalServer!.url.origin,
      fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(input, { ...init, tls: { ca: approvalCertificate } })) as typeof fetch,
    });
    if (opened.request.nodeOrigin !== host || opened.request.targetDid !== requesterDid) throw new Error("Fixture request binding mismatch");
    const entry = approvalRequests.get(opened.id!)!;
    entry.preparedRequestId = preparedRequest.requestId;
    entry.agentTargetDid = preparedRequest.sessionDid;
    return { entry, request: opened.request, url };
  }

  /** The owner approves exactly what was requested: an owner-signed, encrypted result appears at OpenKey. */
  async function approve(entry: ApprovalFixtureEntry, request: OpenKeyApprovalRequestV1, signer: PrivateKeySigner) {
    const requested = request.permissions as PermissionEntry[];
    const address = await signer.getAddress();
    const ownerDid = "did:pkh:eip155:1:" + address;
    const spaceName = (requested.find((p) => p.space)?.space ?? "applications").split(":").at(-1)!;
    const spaceId = wasm.makeSpaceId(address, 1, spaceName);
    const now = Date.now();
    const prepared = wasm.prepareSession({
      abilities: abilitiesOf(requested), address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId,
      jwk: request.targetPublicJwk, issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(now + request.grantLifetimeSeconds * 1000).toISOString(),
    });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    await activateSessionWithHost(host, session.delegationHeader);
    const delegation = { ...session, address, chainId: 1, spaceId, ownerDid,
      verificationMethod: request.targetDid, siwe: prepared.siwe, signature };
    const signedExpiry = prepared.siwe.match(/^Expiration Time:\s*(.+)$/m)?.[1];
    if (!signedExpiry) throw new Error("Fixture delegation has no signed expiry");
    const delegationExpiresAt = new Date(signedExpiry).toISOString();
    const relay = createECDH("prime256v1");
    relay.generateKeys();
    const recipient = request.resultEncryptionPublicJwk;
    const secret = relay.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
    const extracted = createHmac("sha256", Buffer.from(entry.id)).update(secret).digest();
    const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(entry.id));
    const plaintext = { resultVersion: 1, requestId: entry.id, requestDigest: entry.record.header.bodyCid,
      requesterDid: entry.record.header.issuer, ownerDid, targetDid: request.targetDid, delegationExpiresAt, delegation };
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
    entry.resultRef = randomBytes(24).toString("base64url");
    entry.resultExpiresAt = new Date(Math.min(Date.parse(delegationExpiresAt), Date.now() + 600_000)).toISOString();
    const publicKey = relay.getPublicKey(undefined, "uncompressed");
    entry.relay = { version: 1, algorithm: "ECDH-P256-A256GCM",
      ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") },
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    approvalResults.set(entry.resultRef, entry);
  }

  const acksOf = (entry: ApprovalFixtureEntry) => ackEvidence.filter((item) => item.requestId === entry.id);
  const pendingOf = (stdout: string) => JSON.parse(stdout) as { pending: { step: number; of: number; approvalUrl: string; expiresAt: string } };
  const savedPending = async () => JSON.parse(await readFile(join(profilePath("owner"), "approval-pending.json"), "utf8")) as Array<{ requestId: string; resultRef?: string; resultEnvelope?: unknown; committed?: boolean; command?: { result: { requestId: string } } }>;

  test("the agent loop: a new link exits 8 at once as step 1 of 1, a resumed wait keeps waiting, the approval is collected, exit 0", async () => {
    const file = await agentRequest("loop", ["--preset", "apps-agent", "--app", "demo"]);
    const prepared = JSON.parse(await readFile(file, "utf8")) as { requestId: string; sessionDid: string };
    const baseline = approvalRequests.size;

    const first = await run(file, ["--timeout", "90s"]);
    expect(first.exitCode).toBe(8);
    expect(Object.keys(JSON.parse(first.stdout))).toEqual(["pending"]);
    const { entry, request, url } = await openLink(first.stderr, prepared);
    expect(pendingOf(first.stdout).pending).toEqual({ step: 1, of: 1, approvalUrl: url, expiresAt: entry.record.header.expiresAt });
    expect(entry.polls).toBe(0);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect((await savedPending()).map((item) => item.requestId)).toEqual([entry.id]);

    // Nobody answers: the same command waits to its deadline and reports the same link, without a second request.
    const waited = await run(file, ["--timeout", "3s"]);
    expect(waited.exitCode).toBe(8);
    expect(waited.stdout).toBe(first.stdout);
    expect(waited.ms).toBeGreaterThanOrEqual(3000);
    expect(entry.polls).toBeGreaterThanOrEqual(2);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect((await savedPending()).map((item) => item.requestId)).toEqual([entry.id]);

    // The owner approves while the command waits: it returns the grant, exit 0, acknowledged once.
    const polled = entry.polls;
    const done = await run(file, ["--timeout", "60s"], { during: async () => {
      await until(() => entry.polls > polled, "the resumed command to poll");
      await approve(entry, request, ownerSigner);
    } });
    expect(done.exitCode, done.stderr).toBe(0);
    const grant = JSON.parse(done.stdout) as { requestId: string; prompted: boolean; delegationCid: string };
    expect(grant.requestId).toBe(prepared.requestId);
    expect(grant.prompted).toBe(true);
    expect(done.stdout).not.toContain('"pending"');
    expect(acksOf(entry)).toHaveLength(1);
    expect(approvalRequests.size).toBe(baseline + 1);

    // Running it again returns the same grant from the saved command: no new request, no early exit 8.
    const again = await run(file, ["--timeout", "90s"]);
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual(grant);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect(acksOf(entry)).toHaveLength(1);
  });

  test("an expired request is exit 3 APPROVAL_REQUEST_EXPIRED without the pending object", async () => {
    const file = await agentRequest("expire", ["--preset", "apps-agent", "--app", "demo"]);
    const prepared = JSON.parse(await readFile(file, "utf8")) as { requestId: string; sessionDid: string };
    const first = await run(file, ["--timeout", "90s"]);
    expect(first.exitCode).toBe(8);
    const { entry } = await openLink(first.stderr, prepared);
    entry.expired = true;
    const expired = await run(file, ["--timeout", "30s"]);
    expect(expired.exitCode).toBe(3);
    expect(expired.stdout + expired.stderr).toContain("APPROVAL_REQUEST_EXPIRED");
    expect(expired.stdout).not.toContain('"pending"');
    expect((await savedPending()).some((item) => item.requestId === entry.id)).toBe(false);
  });

  test("`auth grant --paste --timeout`: --paste only chooses stdin as the request source; the approval wait is bounded as usual", async () => {
    const file = await agentRequest("paste", ["--preset", "apps-agent", "--app", "demo"]);
    const prepared = JSON.parse(await readFile(file, "utf8")) as { requestId: string; sessionDid: string };
    const baseline = approvalRequests.size;
    // The file argument is replaced by stdin; nothing but the request source differs from the loop test.
    const first = await run("-", ["--paste", "--timeout", "60s"], { stdin: file });
    expect(first.exitCode, first.stderr).toBe(8);
    const { entry, request, url } = await openLink(first.stderr, prepared);
    expect(pendingOf(first.stdout).pending).toEqual({ step: 1, of: 1, approvalUrl: url, expiresAt: entry.record.header.expiresAt });
    expect(approvalRequests.size).toBe(baseline + 1);
    await approve(entry, request, ownerSigner);
    const done = await run("-", ["--paste", "--timeout", "60s"], { stdin: file });
    expect(done.exitCode, done.stderr).toBe(0);
    expect((JSON.parse(done.stdout) as { requestId: string }).requestId).toBe(prepared.requestId);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect(acksOf(entry)).toHaveLength(1);
  });

  test("an expired link ends the loop: production's 400 invalid_request is exit 3 and a local expiry exits 3 with no OpenKey call; the next run makes a new link", async () => {
    const file = await agentRequest("lapsed", ["--preset", "apps-agent", "--app", "demo"]);
    const prepared = JSON.parse(await readFile(file, "utf8")) as { requestId: string; sessionDid: string };
    const pendingFile = join(profilePath("owner"), "approval-pending.json");
    // The owner profile also holds the finished commands of earlier tests: change this request's entry only.
    const setExpiry = async (requestId: string, agoMs: number) => {
      const saved = JSON.parse(await readFile(pendingFile, "utf8")) as Array<Record<string, unknown>>;
      saved.find((item) => item.requestId === requestId)!.requestExpiresAt = new Date(Date.now() - agoMs).toISOString();
      await writeFile(pendingFile, JSON.stringify(saved), { mode: 0o600 });
    };
    const first = await run(file, ["--timeout", "60s"]);
    expect(first.exitCode).toBe(8);
    const { entry } = await openLink(first.stderr, prepared);

    await setExpiry(entry.id, 30_000);
    entry.invalidRequest = true;
    const polled = entry.polls;
    const viaOpenKey = await run(file, ["--timeout", "60s"]);
    expect(viaOpenKey.exitCode, viaOpenKey.stderr).toBe(3);
    expect(viaOpenKey.stdout + viaOpenKey.stderr).toContain("APPROVAL_REQUEST_EXPIRED");
    expect(viaOpenKey.stdout).not.toContain('"pending"');
    expect(entry.polls).toBeGreaterThan(polled);
    expect((await savedPending()).some((item) => item.requestId === entry.id)).toBe(false);

    const renewed = await run(file, ["--timeout", "60s"]);
    expect(renewed.exitCode).toBe(8);
    const { entry: second } = await openLink(renewed.stderr, prepared);
    expect(second.id).not.toBe(entry.id);
    expect(pendingOf(renewed.stdout).pending.step).toBe(1);

    await setExpiry(second.id, 20 * 60_000);
    const before = second.polls;
    const local = await run(file, ["--timeout", "60s"]);
    expect(local.exitCode, local.stderr).toBe(3);
    expect(second.polls).toBe(before);
    expect((await savedPending()).some((item) => item.requestId === second.id)).toBe(false);
    const again = await run(file, ["--timeout", "60s"]);
    expect(again.exitCode).toBe(8);
    expect((await openLink(again.stderr, prepared)).entry.id).not.toBe(second.id);
  });

  for (const seam of ["after-poll", "after-fetch", "after-save", "before-ack"] as const) {
    test(`SIGKILLed ${seam}: the next run finishes the same approval, exit 0, no new request, acknowledged once`, async () => {
      const file = await agentRequest("kill-" + seam, ["--preset", "apps-agent", "--app", "demo"]);
      const prepared = JSON.parse(await readFile(file, "utf8")) as { requestId: string; sessionDid: string };
      const baseline = approvalRequests.size;
      const first = await run(file, ["--timeout", "90s"]);
      expect(first.exitCode).toBe(8);
      const { entry, request } = await openLink(first.stderr, prepared);
      await approve(entry, request, ownerSigner);

      const killed = await run(file, ["--timeout", "90s"], { seam, requestId: entry.id });
      expect(killed.signalCode, killed.stderr).toBe("SIGKILL");
      expect(killed.stdout).toBe("");
      expect(approvalRequests.size).toBe(baseline + 1);
      expect(acksOf(entry)).toHaveLength(0);
      const saved = (await savedPending()).find((item) => item.requestId === entry.id);
      expect(saved, "the pending entry survives the kill").toBeDefined();
      if (seam === "after-poll") expect(saved!.resultRef).toBeUndefined();
      if (seam === "after-fetch") { expect(saved!.resultRef).toBe(entry.resultRef); expect(saved!.resultEnvelope).toBeUndefined(); }
      if (seam === "after-save") {
        expect(saved!.resultEnvelope).toBeDefined();
        expect(saved!.resultRef).toBe(entry.resultRef);
        expect(saved!.command).toBeUndefined();
      }
      if (seam === "before-ack") {
        expect(saved!.resultEnvelope).toBeDefined();
        expect(saved!.command?.result.requestId).toBe(prepared.requestId);
      }

      const resumed = await run(file, ["--timeout", "90s"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      expect(resumed.stdout).not.toContain('"pending"');
      const grant = JSON.parse(resumed.stdout) as { requestId: string; prompted: boolean };
      expect(grant.requestId).toBe(prepared.requestId);
      expect(grant.prompted).toBe(true);
      expect(approvalRequests.size).toBe(baseline + 1);
      expect(acksOf(entry)).toHaveLength(1);
      const repeated = await run(file, ["--timeout", "90s"]);
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout)).toEqual(grant);
      expect(approvalRequests.size).toBe(baseline + 1);
      expect(acksOf(entry)).toHaveLength(1);
    });
  }
});
