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

// Real-node e2e for `tinycloud onboard`: an owned synthetic OpenKey transport
// opens the CLI's signed immutable requests and returns real owner-signed,
// encrypted results. The CLI verifies and durably saves authority before ACK.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const THIRTY_DAYS_S = 30 * 86400;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("tinycloud onboard, against a real node", () => {
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
      approvalRequests.set(id, { id, record, checked, requesterJwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") } });
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
    if (action === "fetch") return Response.json({ requestId: entry.id, bodyCid: entry.record.header.bodyCid,
      resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt, relay: entry.relay });
    if (typeof body.ackId !== "string" || !body.ackId) return new Response(null, { status: 400 });
    await observeDurableApproval(entry, body.ackId);
    entry.ackId = body.ackId;
    entry.relay = undefined;
    return Response.json({ ackId: entry.ackId, status: "acknowledged" });
  }

  function cliArgs(name: string, args: string[]) {
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

  async function onboardWithApprovals(name: string, chooseSigner: (request: OpenKeyApprovalRequestV1) => Promise<PrivateKeySigner | null> | PrivateKeySigner | null) {
    const { argv, env, cwd } = cliArgs(name, ["onboard"]);
    const child = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    activeChildren.add(child);
    const stdoutText = new Response(child.stdout).text();
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    const offered: ApprovalEntry[] = [];
    const seen = new Set<string>();
    let stderr = "";
    let partial = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stderr += text;
        partial += text;
        for (;;) {
          const newline = partial.indexOf("\n");
          if (newline < 0) break;
          const line = partial.slice(0, newline);
          partial = partial.slice(newline + 1);
          for (const url of line.match(/https:\/\/\S+/g) ?? []) {
            if (seen.has(url)) continue;
            seen.add(url);
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
            offered.push(entry);
            const signer = await chooseSigner(opened.request);
            if (signer === null) child.kill("SIGKILL");
            else await approve(entry, opened.request, signer);
          }
        }
      }
      return { exitCode: await child.exited, stdout: await stdoutText, stderr, offered };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally { activeChildren.delete(child); }
  }

  function assertThirtyDays(entry: ApprovalEntry) {
    expect(entry.request!.grantLifetimeSeconds).toBe(THIRTY_DAYS_S);
    expect(entry.signedLifetimeSeconds).toBe(THIRTY_DAYS_S);
    expect(Date.parse(entry.record.header.expiresAt)).toBe(Math.floor(Date.parse(entry.record.header.issuedAt) / 1000) * 1000 + 3600_000);
  }

  function authority(permissions: ReadonlyArray<Omit<PermissionEntry, "space">>) {
    return permissions.map((permission) => ({ ...permission, actions: [...permission.actions].sort() }))
      .sort((left, right) => left.service.localeCompare(right.service) || left.path.localeCompare(right.path));
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
    await writeFile(networkGuardPath, `const allowed = new Set(JSON.parse(process.env.TC_ONBOARD_ALLOWED_ORIGINS!));
const actualFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!allowed.has(url.origin)) throw new Error("Onboarding fixture refused an off-loopback fetch");
  return actualFetch(input, init);
}) as typeof fetch;
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
      const receiptPath = process.env.TC_ONBOARD_FIXTURE_RECEIPT;
      if (receiptPath) {
        const parent = await stat(dirname(receiptPath));
        if (parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0) throw new Error("Fixture receipt requires its own private directory");
        const approvals = [...approvalRequests.values()].map((entry) => ({ requestId: entry.id, requestDigest: entry.record.header.bodyCid,
          targetDid: entry.record.header.issuer, space: entry.request ? spaceOf(entry.request) : undefined,
          grantLifetimeSeconds: entry.request?.grantLifetimeSeconds, signedLifetimeSeconds: entry.signedLifetimeSeconds,
          resultRef: entry.resultRef, ackId: entry.ackId }));
        await writeFile(receiptPath, JSON.stringify({ approvals, ackEvidence, ackChecks }, null, 2), { mode: 0o600, flag: "wx" });
      }
    } finally {
      approvalServer?.stop(true);
      for (const child of activeChildren) child.kill("SIGTERM");
      node?.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fresh home: two approvals, each for one space and 30 days; the grant does exactly what it names", async () => {
    await mkdir(home("agent"), { recursive: true, mode: 0o700 });
    const first = await onboardWithApprovals("agent", (request) => spaceOf(request) === "applications" ? ownerSigner : null);
    expect(first.exitCode).not.toBe(0);
    expect(first.offered.map((entry) => spaceOf(entry.request!))).toEqual(["applications", "account"]);
    const approval1 = first.offered[0]!;
    assertThirtyDays(approval1);
    expect(new Set(approval1.request!.permissions.map((permission) => permission.space))).toEqual(new Set(["applications"]));
    expect(authority(approval1.request!.permissions.map(({ space: _, ...permission }) => permission))).toEqual(authority([
      { service: "tinycloud.capabilities", path: "", actions: ["tinycloud.capabilities/read"] },
      { service: "tinycloud.kv", path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/metadata"] },
      { service: "tinycloud.sql", path: "", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
    ]));
    const beforeResume = await savedState("agent");
    expect(beforeResume.session?.delegationCid).toBe(approval1.delegation!.delegationCid);
    const accountRequestId = first.offered[1]!.id;
    expect(beforeResume.pending.some((entry) => entry.requestId === accountRequestId)).toBe(true);
    expect(beforeResume.grants.some((entry) => entry.delegation.spaceId.split(":").at(-1) === "account")).toBe(false);
    expect((await cli("agent", ["kv", "get", "--space", "account", "spaces/applications"])).stderr).toContain("Unauthorized Action");
    const done = await onboardWithApprovals("agent", (request) => {
      if (spaceOf(request) !== "account") throw new Error("Resume requested an already-saved onboarding space");
      return ownerSigner;
    });
    expect(done.exitCode).toBe(0);
    expect(done.offered.map((entry) => entry.id)).toEqual([accountRequestId]);
    const approval2 = done.offered[0]!;
    assertThirtyDays(approval2);
    expect(approval2.request!.permissions.filter((permission) => permission.service === "tinycloud.kv").map((permission) => [permission.path, permission.actions])).toEqual([
      ["spaces/", ["tinycloud.kv/get", "tinycloud.kv/list"]],
      ["applications/", ["tinycloud.kv/get", "tinycloud.kv/list"]],
    ]);
    expect(authority(approval2.request!.permissions.map(({ space: _, ...permission }) => permission))).toEqual(authority([
      { service: "tinycloud.capabilities", path: "", actions: ["tinycloud.capabilities/read"] },
      { service: "tinycloud.kv", path: "spaces/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
      { service: "tinycloud.kv", path: "applications/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
    ]));
    const result = JSON.parse(done.stdout) as { onboarded: boolean; profile: string; ownerDid: string };
    expect(result.onboarded).toBe(true);
    expect(result.profile).toBe("default");
    expect(result.ownerDid.toLowerCase()).toBe(`did:pkh:eip155:1:${(await ownerSigner.getAddress()).toLowerCase()}`);
    const afterResume = await savedState("agent");
    expect(afterResume.session?.delegationCid).toBe(beforeResume.session?.delegationCid);
    expect(afterResume.grants.some((entry) => entry.delegation.cid === approval2.delegation!.delegationCid)).toBe(true);
    expect(approval1.ackId).toBeDefined();
    expect(approval2.ackId).toBeDefined();
    const repeated = await onboardWithApprovals("agent", () => { throw new Error("Completed onboarding requested another approval"); });
    expect(repeated.exitCode).toBe(0);
    expect(repeated.offered).toHaveLength(0);

    expect((await cli("agent", ["kv", "put", "--space", "applications", "onboard/note", "hello"])).exitCode).toBe(0);
    expect((await cli("agent", ["kv", "get", "--space", "applications", "onboard/note"])).stdout).toContain("hello");
    expect((await cli("agent", ["kv", "get", "--space", "account", "spaces/applications"])).stdout).toContain("hosted");
    // One approval covers a Health Log SQL write and read on the applications space, and `auth caps --diff` sees it.
    const healthDb = "xyz.tinycloud.sample.healthlog/healthlog";
    const caps = await cli("agent", ["auth", "caps", "--diff", `tinycloud.sql:applications:${healthDb}:read,write`]);
    expect(JSON.parse(caps.stdout)).toMatchObject({ covered: true });
    // Health Log's table is made by its install, which holds the schema grant onboarding doesn't give; the owner wallet stands in for it.
    expect((await cli("wallet", ["auth", "request", "--cap", `tinycloud.sql:applications:${healthDb}:schema,write`, "--grant", "--yes"])).exitCode).toBe(0);
    const create = await cli("wallet", ["sql", "execute", "CREATE TABLE IF NOT EXISTS meal (id INTEGER PRIMARY KEY, name TEXT)", "--db", healthDb, "--space", "applications"]);
    expect(create.exitCode, create.stderr + create.stdout).toBe(0);
    expect((await cli("agent", ["sql", "execute", "INSERT INTO meal(name) VALUES ('salmon')", "--db", healthDb, "--space", "applications"])).exitCode).toBe(0);
    expect(JSON.parse((await cli("agent", ["sql", "query", "SELECT name FROM meal", "--db", healthDb, "--space", "applications"])).stdout).rows).toEqual([["salmon"]]);
    expect((await cli("agent", ["sql", "execute", "INSERT INTO meal(name) VALUES ('x')", "--db", "other/db", "--space", "account"])).stderr).toContain("Unauthorized Action");
    // Read-only where the grant says read-only, and nothing outside what it names.
    expect((await cli("agent", ["kv", "put", "--space", "account", "spaces/x", "y"])).stderr).toContain("Unauthorized Action");
    expect((await cli("agent", ["kv", "get", "--space", "default", "anything"])).stderr).toContain("Unauthorized Action");
    expect((await cli("agent", ["kv", "get", "--space", "account", "outside-prefix"])).stderr).toContain("Unauthorized Action");
  });

  test("a signed result for a different wallet is refused and onboarding retains its saved applications step", async () => {
    await mkdir(home("forged"), { recursive: true, mode: 0o700 });
    const forger = new PrivateKeySigner("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    let applications: SavedState | undefined;
    const forged = await onboardWithApprovals("forged", async (request) => {
      if (spaceOf(request) === "applications") return ownerSigner;
      if (spaceOf(request) !== "account") throw new Error("Unexpected onboarding space");
      applications = await savedState("forged");
      return forger;
    });
    expect(forged.offered.map((entry) => spaceOf(entry.request!))).toEqual(["applications", "account"]);
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr.includes("OPENKEY_OWNER_MISMATCH")).toBe(true);
    expect(forged.stdout).toBe("");
    const rejected = forged.offered[1]!;
    expect(rejected.resultRef).toBeDefined();
    expect(rejected.ackId).toBeUndefined();
    const after = await savedState("forged");
    expect(after.session?.delegationCid).toBe(applications!.session?.delegationCid);
    expect(after.profile?.ownerDid).toBe(applications!.profile?.ownerDid);
    expect(after.grants.some((entry) => entry.delegation.cid === rejected.delegation!.delegationCid)).toBe(false);
    expect(after.pending.some((entry) => entry.requestId === rejected.id)).toBe(true);
    // An unacknowledged bad result is immutable: retry must fail closed, not erase
    // it, fabricate a new consent, or replace the already verified applications session.
    const again = await onboardWithApprovals("forged", () => { throw new Error("Retry requested new consent for an existing result"); });
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr.includes("OPENKEY_OWNER_MISMATCH")).toBe(true);
    expect(again.stdout).toBe("");
    expect(again.offered).toHaveLength(0);
    const retained = await savedState("forged");
    expect(retained.session?.delegationCid).toBe(applications!.session?.delegationCid);
    expect(retained.profile?.ownerDid).toBe(applications!.profile?.ownerDid);
    expect(retained.pending.some((entry) => entry.requestId === rejected.id)).toBe(true);
    expect(rejected.ackId).toBeUndefined();
  });
});
