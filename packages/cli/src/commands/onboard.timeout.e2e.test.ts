import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { activateSessionWithHost, principalDidEquals } from "@tinycloud/sdk-core";
import { canonicalize } from "@tinycloud/share-envelope";
import { checkLinkRecord, linkIssuerPublicKey, resolveApprovalRequest, type CheckedLinkRecord, type LinkRecord, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { additionalDelegationsPath, profileConfigPath, profilePath, readJson, sessionPath, withTinyCloudStateRoot } from "@tinycloud/operations/state";

// TC-2299 real-node e2e for `tinycloud onboard --timeout`: the same owned synthetic OpenKey transport as
// onboard.e2e.test.ts. A new approval link exits 8 at once, a resumed one waits to the deadline, an approval that
// arrives is collected, and a process SIGKILLed at each seam resumes with no new request and exactly one ack.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const THIRTY_DAYS_S = 30 * 86400;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("tinycloud onboard --timeout, against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let ownerSigner: PrivateKeySigner;
  const wasm = new NodeWasmBindings();
  const home = (name: string) => join(root, `home-${name}`);

  interface ApprovalEntry {
    id: string;
    record: LinkRecord;
    checked: CheckedLinkRecord;
    requesterJwk: OpenKeyApprovalRequestV1["targetPublicJwk"];
    homeName?: string;
    request?: OpenKeyApprovalRequestV1;
    delegation?: Record<string, unknown>;
    signedLifetimeSeconds?: number;
    resultRef?: string;
    resultExpiresAt?: string;
    relay?: Record<string, unknown>;
    ackId?: string;
    /** The fixture reports this request as expired. */
    expired?: boolean;
    /** OpenKey answers every result lookup with HTTP 503. */
    unavailable?: boolean;
    polls: number;
  }
  interface SavedState {
    profile: Record<string, unknown> | null;
    session: Record<string, unknown> | null;
    grants: Array<{ delegation: { cid: string; spaceId: string; siweProof?: { siwe: string; signature: string } } }>;
    pending: Array<{ requestId: string; bodyCid: string; resultRef?: string; ackId: string; expectedOwner?: string }>;
  }
  let approvalServer: ReturnType<typeof Bun.serve> | undefined;
  let approvalCertificate = "";
  let approvalCertificatePath = "";
  let networkGuardPath = "";
  const approvalRequests = new Map<string, ApprovalEntry>();
  const approvalResults = new Map<string, ApprovalEntry>();
  const seenProofs = new Set<string>();
  const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();
  const ackEvidence: Array<{ requestId: string; requestDigest: string; resultRef: string; ackId: string; delegationCid: string; savedAs: string }> = [];
  const ackChecks: Array<{ requestId: string; targetDid: string; profilePrincipal: string | null; ackIdMatches: boolean; digestMatches: boolean; resultRefMatches: boolean; ownerMatches: boolean; principalMatches: boolean; sessionMatches: boolean; grantMatches: boolean }> = [];

  async function savedState(name: string): Promise<SavedState> {
    return withTinyCloudStateRoot(home(name), async () => ({
      profile: await readJson<Record<string, unknown>>(profileConfigPath("default")),
      session: await readJson<Record<string, unknown>>(sessionPath("default")),
      grants: await readJson<SavedState["grants"]>(additionalDelegationsPath("default")) ?? [],
      pending: await readJson<SavedState["pending"]>(join(profilePath("default"), "approval-pending.json")) ?? [],
    }));
  }

  async function observeDurableApproval(entry: ApprovalEntry, ackId: string) {
    if (!entry.homeName || !entry.request || !entry.delegation) throw new Error("ACK has no matching approval");
    const saved = await savedState(entry.homeName);
    const pending = saved.pending.find((item) => item.requestId === entry.id);
    const delegation = entry.delegation;
    const sessionMatches = saved.session?.delegationCid === delegation.delegationCid &&
      saved.session.signature === delegation.signature && saved.session.siwe === delegation.siwe;
    const grantMatches = saved.grants.some((item) => item.delegation.cid === delegation.delegationCid &&
      item.delegation.siweProof?.signature === delegation.signature && item.delegation.siweProof?.siwe === delegation.siwe);
    const profilePrincipal = saved.profile?.sessionDid ?? saved.profile?.did;
    const checks = {
      ackIdMatches: pending?.ackId === ackId,
      digestMatches: pending?.bodyCid === entry.record.header.bodyCid,
      resultRefMatches: pending?.resultRef === entry.resultRef,
      ownerMatches: String(saved.profile?.ownerDid).toLowerCase() === String(delegation.ownerDid).toLowerCase(),
      principalMatches: typeof profilePrincipal === "string" && principalDidEquals(profilePrincipal, entry.request.targetDid),
      sessionMatches,
      grantMatches,
    };
    ackChecks.push({ requestId: entry.id, targetDid: entry.request.targetDid,
      profilePrincipal: typeof profilePrincipal === "string" ? profilePrincipal : null, ...checks });
    if (!checks.ackIdMatches || !checks.digestMatches || !checks.resultRefMatches || !checks.ownerMatches ||
      !checks.principalMatches || (!checks.sessionMatches && !checks.grantMatches)) {
      throw new Error("ACK arrived before the matching verified authority and ACK intent were saved");
    }
    if (grantMatches) {
      const text = await withTinyCloudStateRoot(home(entry.homeName), () =>
        readFile(join(profilePath("default"), "auth-grants.jsonl"), "utf8"));
      const history = text.trim().split("\n").map((line) => JSON.parse(line));
      if (!history.some((item) => item.delegationCid === delegation.delegationCid)) throw new Error("ACK preceded grant history");
    }
    ackEvidence.push({ requestId: entry.id, requestDigest: entry.record.header.bodyCid,
      resultRef: entry.resultRef!, ackId, delegationCid: String(delegation.delegationCid), savedAs: sessionMatches ? "session" : "additional-grant" });
  }

  function validRequesterProof(request: Request, entry: ApprovalEntry, action: string, body: Record<string, unknown>): boolean {
    if (body.bodyCid !== entry.record.header.bodyCid || (action !== "discover" && body.requestId !== entry.id)) return false;
    try {
      const parts = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
      if (parts.length !== 3) return false;
      const [header, payload, signature] = parts as [string, string, string];
      const jwk = entry.requesterJwk;
      if (!verify(null, Buffer.from(header + "." + payload), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"))) return false;
      const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const kid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
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
        checked.header.audience !== approvalServer!.url.origin) return new Response(null, { status: 401 });
      const key = linkIssuerPublicKey(checked.header.issuer);
      if (!key) return new Response(null, { status: 401 });
      const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
      approvalRequests.set(id, { id, record, checked, polls: 0, requesterJwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") } });
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
    if (discovery && entry.unavailable) return new Response(null, { status: 503 });
    if (!entry.relay) return entry.expired || Date.parse(entry.record.header.expiresAt) <= Date.now()
      ? Response.json({ code: "expired_request" }, { status: 410 }) : new Response(null, { status: 202 });
    if (Date.parse(entry.resultExpiresAt!) <= Date.now()) return Response.json({ code: "expired_result" }, { status: 410 });
    if (action === "discover") return Response.json({ resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt });
    if (action === "fetch") return Response.json({ requestId: entry.id, bodyCid: entry.record.header.bodyCid,
      resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt, relay: entry.relay });
    if (typeof body.ackId !== "string" || !body.ackId) return new Response(null, { status: 400 });
    await observeDurableApproval(entry, body.ackId);
    entry.ackId = body.ackId;
    entry.relay = undefined;
    return Response.json({ ackId: entry.ackId, status: "acknowledged" });
  }

  function cliArgs(name: string, args: string[], extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(name), TC_HOME: home(name),
      TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
      BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"), XDG_CACHE_HOME: join(root, "cache") };
    for (const key of ["TC_HOST", "TC_PRIVATE_KEY", "TC_OPENKEY_HOST", "TC_PROFILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
    env.TC_AUTH_NO_POPUP = "1";
    env.TC_OPENKEY_API_HOST = approvalServer!.url.origin;
    env.TC_LINKS_API_ORIGIN = approvalServer!.url.origin;
    env.TC_ONBOARD_ALLOWED_ORIGINS = JSON.stringify([host, approvalServer!.url.origin]);
    env.NODE_EXTRA_CA_CERTS = approvalCertificatePath;
    env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    Object.assign(env, extraEnv);
    return { argv: [process.execPath, "--no-env-file", "--preload", networkGuardPath, cliEntry, "--host", host, ...args], env, cwd: root };
  }

  async function cli(name: string, args: string[]) {
    const { argv, env, cwd } = cliArgs(name, args);
    const child = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    activeChildren.add(child);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { exitCode, stdout, stderr };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally { activeChildren.delete(child); }
  }

  function spaceOf(request: OpenKeyApprovalRequestV1): string {
    const spaces = [...new Set(request.permissions.map((permission) => permission.space?.split(":").at(-1)))];
    if (spaces.length !== 1 || !spaces[0]) throw new Error("Onboarding approval did not name exactly one space");
    return spaces[0];
  }

  async function approve(entry: ApprovalEntry, request: OpenKeyApprovalRequestV1, signer: PrivateKeySigner) {
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const permission of request.permissions) {
      const service = permission.service.slice("tinycloud.".length);
      abilities[service] = { ...abilities[service], [permission.path]: [...new Set([...(abilities[service]?.[permission.path] ?? []), ...permission.actions])] };
    }
    const address = await signer.getAddress();
    const ownerDid = "did:pkh:eip155:1:" + address;
    const spaceId = wasm.makeSpaceId(address, 1, spaceOf(request));
    const now = Date.now();
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId,
      jwk: request.targetPublicJwk, issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(now + request.grantLifetimeSeconds * 1000).toISOString() });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    await activateSessionWithHost(host, session.delegationHeader);
    const delegation = { ...session, address, chainId: 1, spaceId, ownerDid, verificationMethod: request.targetDid, siwe: prepared.siwe, signature };
    const signedExpiry = prepared.siwe.match(/^Expiration Time:\s*(.+)$/m)?.[1];
    const signedIssuedAt = prepared.siwe.match(/^Issued At:\s*(.+)$/m)?.[1];
    if (!signedExpiry || !signedIssuedAt) throw new Error("Fixture grant lacks signed lifetime");
    const delegationExpiresAt = new Date(signedExpiry).toISOString();
    entry.delegation = delegation;
    entry.signedLifetimeSeconds = (Date.parse(signedExpiry) - Date.parse(signedIssuedAt)) / 1000;
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
    const publicKey = relay.getPublicKey(undefined, "uncompressed");
    entry.resultRef = randomBytes(24).toString("base64url");
    // Local fixture retention only; independent of the request and signed 30-day grant.
    entry.resultExpiresAt = new Date(Math.min(Date.parse(delegationExpiresAt), Date.now() + 600_000)).toISOString();
    entry.relay = { version: 1, algorithm: "ECDH-P256-A256GCM",
      ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") },
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    approvalResults.set(entry.resultRef, entry);
  }


  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-onboard-e2e-"));
    await chmod(root, 0o700);
    for (const directory of ["tmp", "cache"]) await mkdir(join(root, directory), { mode: 0o700 });
    approvalCertificatePath = join(root, "approval-cert.pem");
    const approvalKeyPath = join(root, "approval-key.pem");
    const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", approvalKeyPath, "-out", approvalCertificatePath],
      { stdout: "pipe", stderr: "pipe" });
    const [, certificateError, certificateExit] = await Promise.all([new Response(certificate.stdout).text(), new Response(certificate.stderr).text(), certificate.exited]);
    if (certificateExit !== 0) throw new Error("Fixture TLS setup failed: " + certificateError);
    await chmod(approvalKeyPath, 0o600);
    approvalCertificate = await readFile(approvalCertificatePath, "utf8");
    approvalServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
      tls: { key: Bun.file(approvalKeyPath), cert: approvalCertificate }, fetch: approvalFixtureResponse });
    networkGuardPath = join(root, "loopback-fetch.ts");
    // The network guard of onboard.e2e.test.ts, plus optional SIGKILL seams (TC_KILL_SEAM) that stand in for a
    // killed process: the tool limit that ends a command, an OOM, a closed terminal.
    await writeFile(networkGuardPath, `import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const allowed = new Set(JSON.parse(process.env.TC_ONBOARD_ALLOWED_ORIGINS!));
const seam = process.env.TC_KILL_SEAM;
const die = () => process.kill(process.pid, "SIGKILL");
const actualFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!allowed.has(url.origin)) throw new Error("Onboarding fixture refused an off-loopback fetch");
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
  // Die when the process next asks for the profile lock (the login commit) after a result was saved: outside any
  // held lock, so the kill leaves nothing behind but the saved state.
  const fsp = require("node:fs/promises");
  const mkdir = fsp.mkdir;
  fsp.mkdir = async (path: string, ...rest: unknown[]) => {
    if (String(path).includes("/profile-locks")) {
      try { if (readFileSync(process.env.TC_KILL_PENDING_FILE!, "utf8").includes('"resultEnvelope"')) die(); } catch {}
    }
    return mkdir(path, ...rest);
  };
}
`, { mode: 0o600 });
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

    // OpenKey hosts a new owner's spaces when they first approve; here the owner wallet hosts them.
    await mkdir(home("wallet"), { recursive: true, mode: 0o700 });
    expect((await cli("wallet", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("wallet", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    for (const space of ["applications", "account"]) {
      expect((await cli("wallet", ["auth", "request", "--cap", `tinycloud.kv:${space}::get,list,put,del`, "--grant", "--yes"])).exitCode).toBe(0);
      expect((await cli("wallet", ["space", "create", space])).exitCode).toBe(0);
    }
    expect((await cli("wallet", ["kv", "put", "--space", "account", "spaces/applications", "hosted"])).exitCode).toBe(0);
    let ownerKey = "";
    for await (const file of new Bun.Glob("**/profile.json").scan({ cwd: home("wallet"), dot: true, absolute: true })) {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && "privateKey" in parsed && typeof parsed.privateKey === "string") ownerKey = parsed.privateKey;
    }
    ownerSigner = new PrivateKeySigner(ownerKey.replace(/^0x/, ""));
  });


  afterAll(async () => {
    try {
      approvalServer?.stop(true);
      for (const child of activeChildren) child.kill("SIGTERM");
      node?.kill("SIGTERM");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function run(name: string, args: string[], extraEnv: Record<string, string> = {}, during?: () => Promise<void>) {
    const { argv, env, cwd } = cliArgs(name, args, extraEnv);
    const started = Date.now();
    const child = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    activeChildren.add(child);
    try {
      const watching = during?.();
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await watching;
      return { exitCode, signalCode: child.signalCode, stdout, stderr, ms: Date.now() - started };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally { activeChildren.delete(child); }
  }

  async function until(condition: () => boolean, what: string): Promise<void> {
    const limit = Date.now() + 60_000;
    while (!condition()) {
      if (Date.now() > limit) throw new Error("Timed out waiting for " + what);
      await Bun.sleep(25);
    }
  }

  /** The link the CLI printed for the owner, opened the way OpenKey opens it. */
  async function openLink(name: string, stderr: string): Promise<ApprovalEntry> {
    // A resumed run prints the links it passes again; the newest is the last.
    const url = [...stderr.matchAll(/Approve in OpenKey: (https:\/\/\S+)/g)].at(-1)?.[1];
    if (!url) throw new Error("No approval link on stderr: " + stderr);
    const opened = await resolveApprovalRequest(url, {
      trustedOrigins: ["https://openkey.so"], apiOrigin: approvalServer!.url.origin,
      fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const destination = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (destination.origin !== approvalServer!.url.origin) throw new Error("Fixture link read escaped its own API");
        return fetch(input, { ...init, tls: { ca: approvalCertificate } });
      }) as typeof fetch,
    });
    const entry = approvalRequests.get(opened.id!);
    if (!entry || opened.request.nodeOrigin !== host || opened.request.targetDid !== entry.record.header.issuer) throw new Error("Fixture request binding mismatch");
    entry.homeName = name;
    entry.request = opened.request;
    return entry;
  }

  const lastLink = (stderr: string) => [...stderr.matchAll(/Approve in OpenKey: (\S+)/g)].at(-1)![1]!;
  const acksOf = (entry: ApprovalEntry) => ackEvidence.filter((item) => item.requestId === entry.id);
  const stdoutPending = (stdout: string) => JSON.parse(stdout) as { pending: { step: number; of: number; approvalUrl: string; expiresAt: string } };

  test("the agent loop: a new link exits 8 at once, a resumed wait keeps waiting, an approval is collected, the end exits 0", async () => {
    await mkdir(home("loop"), { recursive: true, mode: 0o700 });
    const baseline = approvalRequests.size;

    // 1. A fresh home: the link for step 1 comes back at once, before any poll.
    const first = await run("loop", ["onboard", "--timeout", "90s"]);
    expect(first.exitCode).toBe(8);
    expect(first.stdout.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(first.stdout))).toEqual(["pending"]);
    const entry1 = await openLink("loop", first.stderr);
    expect(stdoutPending(first.stdout).pending).toEqual({ step: 1, of: 2, approvalUrl: lastLink(first.stderr), expiresAt: entry1.record.header.expiresAt });
    expect(spaceOf(entry1.request!)).toBe("applications");
    expect(entry1.polls).toBe(0);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect((await savedState("loop")).pending.map((item) => item.requestId)).toEqual([entry1.id]);

    // 2. Nobody approves: the resumed request keeps waiting to the deadline, then reports the same link.
    const waited = await run("loop", ["onboard", "--timeout", "3s"]);
    expect(waited.exitCode).toBe(8);
    expect(waited.stdout).toBe(first.stdout);
    expect(waited.ms).toBeGreaterThanOrEqual(3000);
    expect(entry1.polls).toBeGreaterThanOrEqual(2);
    expect(approvalRequests.size).toBe(baseline + 1);
    expect((await savedState("loop")).pending.map((item) => item.requestId)).toEqual([entry1.id]);

    // 3. The owner approves while the command is waiting: it collects step 1, saves and acknowledges it,
    //    then returns the link of step 2 at once.
    const polled = entry1.polls;
    const collecting = await run("loop", ["onboard", "--timeout", "60s"], {}, async () => {
      await until(() => entry1.polls > polled, "the resumed command to poll");
      await approve(entry1, entry1.request!, ownerSigner);
    });
    expect(collecting.exitCode, collecting.stderr).toBe(8);
    expect(approvalRequests.size).toBe(baseline + 2);
    const entry2 = await openLink("loop", collecting.stderr);
    expect(entry2.id).not.toBe(entry1.id);
    expect(stdoutPending(collecting.stdout).pending).toEqual({ step: 2, of: 2, approvalUrl: lastLink(collecting.stderr), expiresAt: entry2.record.header.expiresAt });
    expect(spaceOf(entry2.request!)).toBe("account");
    expect(acksOf(entry1)).toHaveLength(1);
    expect((await savedState("loop")).session?.delegationCid).toBe(entry1.delegation!.delegationCid);

    // 4. Step 2 approved: the final run exits 0 with the normal result, and every ack happened once.
    await approve(entry2, entry2.request!, ownerSigner);
    const done = await run("loop", ["onboard", "--timeout", "90s"]);
    expect(done.exitCode, done.stderr).toBe(0);
    const result = JSON.parse(done.stdout) as { onboarded: boolean; profile: string; ownerDid: string; granted: Array<{ space: string }> };
    expect(result.onboarded).toBe(true);
    expect(result.granted.map((item) => item.space)).toEqual(["applications", "account"]);
    expect(done.stdout).not.toContain("pending");
    expect(acksOf(entry1)).toHaveLength(1);
    expect(acksOf(entry2)).toHaveLength(1);
    expect(approvalRequests.size).toBe(baseline + 2);
    expect((await savedState("loop")).pending).toEqual([]);
    expect((await run("loop", ["kv", "put", "--space", "applications", "loop/note", "hello"])).exitCode).toBe(0);
    expect((await run("loop", ["kv", "get", "--space", "account", "spaces/applications"])).stdout).toContain("hosted");

    // 5. Run again once onboarded: still exit 0, no new request, no early exit 8.
    const again = await run("loop", ["onboard", "--timeout", "90s"]);
    expect(again.exitCode).toBe(0);
    expect(approvalRequests.size).toBe(baseline + 2);
  });

  test("an expired request is exit 3 APPROVAL_REQUEST_EXPIRED, not a pending approval, and the next run starts a new link", async () => {
    await mkdir(home("expire"), { recursive: true, mode: 0o700 });
    const first = await run("expire", ["onboard", "--timeout", "90s"]);
    expect(first.exitCode).toBe(8);
    const entry = await openLink("expire", first.stderr);
    entry.expired = true;
    const expired = await run("expire", ["onboard", "--timeout", "30s"]);
    expect(expired.exitCode).toBe(3);
    expect(expired.stdout + expired.stderr).toContain("APPROVAL_REQUEST_EXPIRED");
    expect(expired.stdout).not.toContain('"pending"');
    expect((await savedState("expire")).pending).toEqual([]);
    const renewed = await run("expire", ["onboard", "--timeout", "90s"]);
    expect(renewed.exitCode).toBe(8);
    const next = await openLink("expire", renewed.stderr);
    expect(next.id).not.toBe(entry.id);
    expect(stdoutPending(renewed.stdout).pending.approvalUrl).not.toBe(stdoutPending(first.stdout).pending.approvalUrl);
  });

  test("OpenKey being unavailable stays its own exit 8 error, without the pending JSON", async () => {
    await mkdir(home("unavailable"), { recursive: true, mode: 0o700 });
    const first = await run("unavailable", ["onboard", "--timeout", "90s"]);
    expect(first.exitCode).toBe(8);
    const entry = await openLink("unavailable", first.stderr);
    entry.unavailable = true;
    const down = await run("unavailable", ["onboard", "--timeout", "30s"]);
    expect(down.exitCode).toBe(8);
    expect(down.stdout + down.stderr).toContain("APPROVAL_REQUEST_UNAVAILABLE");
    expect(down.stdout).not.toContain('"pending"');
    expect((await savedState("unavailable")).pending.map((item) => item.requestId)).toEqual([entry.id]);
  });

  for (const seam of ["after-poll", "after-fetch", "after-save", "before-ack"] as const) {
    test(`SIGKILLed ${seam}: the next run resumes the same approval with no new request, and the owner's approval is acknowledged once`, async () => {
      const name = "kill-" + seam;
      await mkdir(home(name), { recursive: true, mode: 0o700 });
      const baseline = approvalRequests.size;
      const first = await run(name, ["onboard", "--timeout", "90s"]);
      expect(first.exitCode).toBe(8);
      const entry1 = await openLink(name, first.stderr);
      await approve(entry1, entry1.request!, ownerSigner);

      const pendingFile = await withTinyCloudStateRoot(home(name), async () => join(profilePath("default"), "approval-pending.json"));
      const killed = await run(name, ["onboard", "--timeout", "90s"], { TC_KILL_SEAM: seam, TC_KILL_PENDING_FILE: pendingFile });
      expect(killed.signalCode, killed.stderr).toBe("SIGKILL");
      expect(killed.stdout).toBe("");
      expect(approvalRequests.size).toBe(baseline + 1);
      const afterKill = await savedState(name);
      const saved = afterKill.pending.find((item) => item.requestId === entry1.id) as (SavedState["pending"][number] & { resultEnvelope?: unknown; committed?: boolean }) | undefined;
      expect(saved, "the pending entry survives the kill").toBeDefined();
      expect(acksOf(entry1)).toHaveLength(0);
      if (seam === "after-poll") expect(saved!.resultRef).toBeUndefined();
      if (seam === "after-fetch") { expect(saved!.resultRef).toBe(entry1.resultRef); expect(saved!.resultEnvelope).toBeUndefined(); }
      if (seam === "after-save") {
        // The fetched result is on disk (with its reference) before any login commit or ack.
        expect(saved!.resultEnvelope).toBeDefined();
        expect(saved!.resultRef).toBe(entry1.resultRef);
        expect(afterKill.session).toBeNull();
        expect(saved!.committed).toBeUndefined();
      }
      if (seam === "before-ack") {
        expect(saved!.resultEnvelope).toBeDefined();
        expect(saved!.committed).toBe(true);
        expect(afterKill.session?.delegationCid).toBe(entry1.delegation!.delegationCid);
      }

      // The re-run finishes step 1 from what was saved (or re-collects it) and moves on to step 2.
      const resumed = await run(name, ["onboard", "--timeout", "90s"]);
      expect(resumed.exitCode, resumed.stderr).toBe(8);
      expect(stdoutPending(resumed.stdout).pending.step).toBe(2);
      expect(approvalRequests.size).toBe(baseline + 2);
      expect(acksOf(entry1)).toHaveLength(1);
      expect((await savedState(name)).session?.delegationCid).toBe(entry1.delegation!.delegationCid);
      const entry2 = await openLink(name, resumed.stderr);
      await approve(entry2, entry2.request!, ownerSigner);
      const done = await run(name, ["onboard", "--timeout", "90s"]);
      expect(done.exitCode, done.stderr).toBe(0);
      expect(JSON.parse(done.stdout).onboarded).toBe(true);
      expect(approvalRequests.size).toBe(baseline + 2);
      expect(acksOf(entry1)).toHaveLength(1);
      expect(acksOf(entry2)).toHaveLength(1);
      expect((await savedState(name)).pending).toEqual([]);
    });
  }
});
