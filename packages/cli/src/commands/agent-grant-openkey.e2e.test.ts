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

// Real-node e2e for the agent OpenKey grant (TC-1422). The owner is an OpenKey
// profile holding a broad 3 h session. A fake OpenKey answers the approval URL
// the CLI prints, as the browser page would: the owner wallet signs the requested
// scope with the requested expiry, the approval is activated at the node, and the
// immutable signed request is opened; its encrypted result is fetched and ACKed.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const OWNER_SESSION_MS = 3 * 3600_000;
const SEVEN_DAYS_S = 7 * 86400;
const hoursUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 3600_000;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("agent OpenKey grant, against a real node", () => {
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
  let crashBoundary: "fetch" | "before-ack" | "after-ack" | undefined;
  let activeGrant: ReturnType<typeof Bun.spawn> | undefined;
  const observations: Array<Record<string, unknown>> = [];
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
      approvalRequests.set(id, { id, record, checked });
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
    if (!entry.relay) return Date.parse(entry.record.header.expiresAt) <= Date.now()
      ? Response.json({ code: "expired_request" }, { status: 410 }) : new Response(null, { status: 202 });
    if (Date.parse(entry.resultExpiresAt!) <= Date.now()) return Response.json({ code: "expired_result" }, { status: 410 });
    if (action === "discover") return Response.json({ resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt });
    if (action === "fetch") {
      if (crashBoundary === "fetch") { crashBoundary = undefined; activeGrant!.kill("SIGKILL"); }
      return Response.json({ requestId: entry.id, bodyCid: entry.record.header.bodyCid,
        resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt, relay: entry.relay });
    }
    if (typeof body.ackId !== "string" || !body.ackId) return new Response(null, { status: 400 });
    await observeDurableCommand(entry, body.ackId);
    if (crashBoundary === "before-ack") {
      crashBoundary = undefined; activeGrant!.kill("SIGKILL");
      return new Response(null, { status: 503 });
    }
    entry.ackId = body.ackId;
    entry.relay = undefined;
    if (crashBoundary === "after-ack") { crashBoundary = undefined; activeGrant!.kill("SIGKILL"); }
    return Response.json({ ackId: entry.ackId, status: "acknowledged" });
  }


  const home = (profile: string) => join(root, `home-${profile}`);

  function cliArgs(profile: string, args: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    delete env.TC_OPENKEY_HOST;
    env.TC_AUTH_NO_POPUP = "1";
    env.TC_OPENKEY_API_HOST = approvalServer!.url.origin;
    env.TC_LINKS_API_ORIGIN = approvalServer!.url.origin;
    env.NODE_EXTRA_CA_CERTS = approvalCertificatePath;
    env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    return { argv: [process.execPath, cliEntry, "--host", host, "--profile", profile, ...args], env };
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

  /** Runs the real CLI and answers its immutable request using the synthetic owner signer. */
  async function grantWithOpenKey(
    requestFile: string,
    approve: (permissions: PermissionEntry[]) => { permissions: PermissionEntry[]; signer: PrivateKeySigner },
  ) {
    const preparedRequest = JSON.parse(await readFile(requestFile, "utf8"));
    let approvalCallbacks = 0;
    const { argv, env } = cliArgs("owner", ["auth", "grant", requestFile, "--yes"]);
    const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    activeGrant = child;
    const stdoutText = new Response(child.stdout).text();
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = "";
    let url: URL | undefined;
    let grantLifetimeSeconds = 0;
    try {
      while (!url) {
        const { value, done } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value);
        const match = stderr.match(/https:\/\/\S+/);
        if (match) url = new URL(match[0]!);
      }
      if (url) {
        const opened = await resolveApprovalRequest(url.href, {
          trustedOrigins: ["https://openkey.so"], apiOrigin: approvalServer!.url.origin,
          fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            fetch(input, { ...init, tls: { ca: approvalCertificate } })) as typeof fetch,
        });
        if (opened.request.nodeOrigin !== host || opened.request.targetDid !== requesterDid) throw new Error("Fixture request binding mismatch");
        const entry = approvalRequests.get(opened.id!)!;
        entry.preparedRequestId = preparedRequest.requestId;
        entry.agentTargetDid = preparedRequest.sessionDid;
        approvalCallbacks++;
        const requested = opened.request.permissions as PermissionEntry[];
        const { permissions, signer } = approve(requested);
        const address = await signer.getAddress();
        const ownerDid = "did:pkh:eip155:1:" + address;
        const spaceName = (requested.find((p) => p.space)?.space ?? "applications").split(":").at(-1)!;
        const spaceId = wasm.makeSpaceId(address, 1, spaceName);
        grantLifetimeSeconds = opened.request.grantLifetimeSeconds;
        const now = Date.now();
        const prepared = wasm.prepareSession({
          abilities: abilitiesOf(permissions), address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId,
          jwk: opened.request.targetPublicJwk, issuedAt: new Date(now).toISOString(),
          expirationTime: new Date(now + grantLifetimeSeconds * 1000).toISOString(),
        });
        const signature = await signer.signMessage(prepared.siwe);
        const session = wasm.completeSessionSetup({ ...prepared, signature });
        await activateSessionWithHost(host, session.delegationHeader);
        const delegation = { ...session, address, chainId: 1, spaceId, ownerDid,
          verificationMethod: opened.request.targetDid, siwe: prepared.siwe, signature };
        const signedExpiry = prepared.siwe.match(/^Expiration Time:\s*(.+)$/m)?.[1];
        if (!signedExpiry) throw new Error("Fixture delegation has no signed expiry");
        const delegationExpiresAt = new Date(signedExpiry).toISOString();
        const relay = createECDH("prime256v1");
        relay.generateKeys();
        const recipient = opened.request.resultEncryptionPublicJwk;
        const secret = relay.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
        const extracted = createHmac("sha256", Buffer.from(entry.id)).update(secret).digest();
        const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
        cipher.setAAD(Buffer.from(entry.id));
        const plaintext = { resultVersion: 1, requestId: entry.id, requestDigest: entry.record.header.bodyCid,
          requesterDid: entry.record.header.issuer, ownerDid, targetDid: opened.request.targetDid, delegationExpiresAt, delegation };
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
        entry.resultRef = randomBytes(24).toString("base64url");
        // Explicit local fixture retention; never shortens the independently signed grant.
        entry.resultExpiresAt = new Date(Math.min(Date.parse(delegationExpiresAt), Date.now() + 600_000)).toISOString();
        const publicKey = relay.getPublicKey(undefined, "uncompressed");
        entry.relay = { version: 1, algorithm: "ECDH-P256-A256GCM",
          ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") },
          nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
        approvalResults.set(entry.resultRef, entry);
      }
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value);
      }
      const exitCode = await child.exited;
      const entry = [...approvalRequests.values()].find((item) => item.preparedRequestId === preparedRequest.requestId);
      const observation = { preparedRequestId: preparedRequest.requestId, agentTargetDid: preparedRequest.sessionDid,
        approvalCallbacks, approvalRequestId: entry?.id, requestDigest: entry?.record.header.bodyCid,
        approvalTargetDid: requesterDid, resultRef: entry?.resultRef, exitCode };
      observations.push(observation);
      return { exitCode, stdout: await stdoutText, stderr, sawUrl: url !== undefined, grantLifetimeSeconds,
        approvalCallbacks, approvalRequestId: entry?.id, resultRef: entry?.resultRef };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
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
    if (process.env.TC_AGENT_GRANT_FIXTURE_RECEIPT) {
      await writeFile(process.env.TC_AGENT_GRANT_FIXTURE_RECEIPT, JSON.stringify({ observations, ackEvidence }, null, 2), { mode: 0o600 });
    }
    approvalServer?.stop(true);
    if (priorTcHome === undefined) delete process.env.TC_HOME; else process.env.TC_HOME = priorTcHome;
    node?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  test("apps-agent preset: grant lasts the 7 d approval, not the 3 h owner session; agent reads its app only", async () => {
    const req = await agentRequest("agent", ["--preset", "apps-agent", "--app", "demo"]);
    const result = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: ownerSigner }));
    expect(result.sawUrl).toBe(true);
    expect(result.approvalCallbacks).toBe(1);
    expect(result.exitCode).toBe(0);

    const grant = JSON.parse(result.stdout) as { expiry: string; prompted: boolean };
    expect(result.grantLifetimeSeconds).toBe(SEVEN_DAYS_S);
    expect(grant.prompted).toBe(true);
    expect(hoursUntil(grant.expiry)).toBeGreaterThan(7 * 24 - 0.1);
    expect(hoursUntil(grant.expiry)).toBeLessThanOrEqual(7 * 24);

    const grantFile = join(root, "agent-grant.json");
    await writeFile(grantFile, result.stdout);
    expect((await cli("agent", ["auth", "import", grantFile])).exitCode).toBe(0);
    const read = await cli("agent", ["kv", "get", "--space", appSpace, "demo/knowledge/a.md"]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("hello-tc1422");
    expect((await cli("agent", ["kv", "put", "--space", appSpace, "demo/knowledge/b.md", "x"])).exitCode).not.toBe(0);
    expect((await cli("agent", ["kv", "get", "--space", appSpace, "demo2/knowledge/a.md"])).exitCode).not.toBe(0);
  });

  test("a 6 d request gets a 6 d grant from its own approval", async () => {
    const req = await agentRequest("agent6d", ["--cap", "tinycloud.kv:applications:demo/:get,list", "--expiry", "6d"]);
    const result = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: ownerSigner }));
    expect(result.exitCode).toBe(0);
    const grant = JSON.parse(result.stdout) as { expiry: string; prompted: boolean };
    expect(result.grantLifetimeSeconds).toBe(6 * 86400);
    expect(result.approvalCallbacks).toBe(1);
    expect(grant.prompted).toBe(true);
    expect(hoursUntil(grant.expiry)).toBeGreaterThan(6 * 24 - 0.1);
    expect(hoursUntil(grant.expiry)).toBeLessThanOrEqual(6 * 24);
  });

  test("an approval that unchecks an ability is refused with OPENKEY_APPROVAL_NARROWER and emits no grant", async () => {
    const req = await agentRequest("agentn", ["--preset", "apps-agent", "--app", "demo"]);
    const narrowed = await grantWithOpenKey(req, (permissions) => ({
      permissions: permissions
        .map((p) => ({ ...p, actions: p.actions.filter((a) => a !== "tinycloud.kv/list") }))
        .filter((p) => p.actions.length > 0),
      signer: ownerSigner,
    }));
    expect(narrowed.approvalCallbacks).toBe(1);
    expect(narrowed.exitCode).not.toBe(0);
    expect(narrowed.stderr).toContain("OPENKEY_APPROVAL_NARROWER");
    expect(narrowed.stdout).toBe("");
  });

  test("an approval signed by a different wallet is refused with OPENKEY_OWNER_MISMATCH", async () => {
    const req = await agentRequest("agentf", ["--preset", "apps-agent", "--app", "demo"]);
    const forger = new PrivateKeySigner("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const forged = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: forger }));
    expect(forged.approvalCallbacks).toBe(1);
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr).toContain("OPENKEY_OWNER_MISMATCH");
    expect(forged.stdout).toBe("");
  });

  for (const boundary of ["fetch", "before-ack", "after-ack"] as const) {
    test("same prepared command recovers exact identity after SIGKILL at " + boundary, async () => {
      const req = await agentRequest("recover-" + boundary, ["--preset", "apps-agent", "--app", "demo"]);
      const prepared = JSON.parse(await readFile(req, "utf8"));
      crashBoundary = boundary;
      const killed = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: ownerSigner }));
      expect(killed.exitCode).not.toBe(0);
      expect(killed.approvalCallbacks).toBe(1);
      const { profilePath } = await import("@tinycloud/operations/state");
      const pendingPath = join(profilePath("owner"), "approval-pending.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      const saved = pending.find((item: { requestId: string }) => item.requestId === killed.approvalRequestId);
      expect(saved.resultRef).toBe(killed.resultRef);
      if (boundary === "fetch") expect(saved.command).toBeUndefined();
      else expect(saved.command.result.requestId).toBe(prepared.requestId);
      const recovered = await grantWithOpenKey(req, () => { throw new Error("A saved command requested another approval"); });
      expect(recovered.exitCode).toBe(0);
      expect(recovered.approvalCallbacks).toBe(0);
      expect(recovered.approvalRequestId).toBe(killed.approvalRequestId);
      expect(recovered.resultRef).toBe(killed.resultRef);
      const result = JSON.parse(recovered.stdout);
      if (saved.command) expect(result).toEqual(saved.command.result);
      const final = JSON.parse(await readFile(pendingPath, "utf8")).find((item: { requestId: string }) => item.requestId === killed.approvalRequestId);
      expect(final.ackId).toBe(saved.ackId);
      expect(final.acknowledged).toBe(true);
      expect(final.command.result).toEqual(result);
      const repeated = await grantWithOpenKey(req, () => { throw new Error("Completed command requested another approval"); });
      expect(repeated.exitCode).toBe(0);
      expect(repeated.approvalCallbacks).toBe(0);
      expect(JSON.parse(repeated.stdout)).toEqual(result);
      expect(repeated.approvalRequestId).toBe(killed.approvalRequestId);
      expect(repeated.resultRef).toBe(killed.resultRef);
      const history = (await readFile(join(profilePath("owner"), "auth-grants.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(history.filter((item) => item.delegationCid === result.delegationCid)).toHaveLength(1);
    });
  }

  test("different prepared requests retain distinct approval and result bindings", () => {
    const bindings = new Map<string, { approval: string; result: string; target: string }>();
    for (const item of observations) {
      const request = item.preparedRequestId as string;
      const binding = { approval: item.approvalRequestId as string, result: item.resultRef as string, target: item.agentTargetDid as string };
      expect(binding.approval).toBeDefined();
      expect(binding.result).toBeDefined();
      if (bindings.has(request)) expect(binding).toEqual(bindings.get(request)!);
      else {
        expect([...bindings.values()].some((other) => other.approval === binding.approval || other.result === binding.result)).toBe(false);
        bindings.set(request, binding);
      }
      expect(item.approvalTargetDid).toBe(requesterDid);
    }
    expect(bindings.size).toBeGreaterThan(1);
  });
});
