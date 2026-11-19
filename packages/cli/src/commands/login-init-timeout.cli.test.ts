import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { checkLinkRecord, type LinkRecord, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { profileConfigPath, profilePath, withTinyCloudStateRoot } from "@tinycloud/operations/state";

// TC-2433: `auth login --timeout` and `init --timeout` against a local OpenKey and links API (TLS on loopback; a preload
// refuses every other origin). A new link exits 8 at once with the pending JSON, a rerun resumes the same saved request
// (no new link) and exits 8 again at the deadline, and an approval given after the deadline is collected by the rerun.
const cliEntry = join(import.meta.dir, "../index.ts");
const TEST_BOOTSTRAP = join(import.meta.dir, "../../../operations/test-support/test-bootstrap.mjs");
setDefaultTimeout(60_000);

interface Entry { id: string; record: LinkRecord; resultRef?: string; resultExpiresAt?: string; relay?: Record<string, unknown>; acks: number; discovers: number }
const entries = new Map<string, Entry>();
const byResult = new Map<string, Entry>();
let root: string;
let server: ReturnType<typeof Bun.serve>;
let certificatePath: string;
let guardPath: string;
const wasm = new NodeWasmBindings();
const owner = new PrivateKeySigner(randomBytes(32).toString("hex"));

async function fixture(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/v1/links") {
    const record = await request.json() as LinkRecord;
    const checked = await checkLinkRecord(record, Date.now());
    if (checked.header.type !== "openkey-approval-request") return new Response(null, { status: 400 });
    const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    entries.set(id, { id, record, acks: 0, discovers: 0 });
    return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
  }
  const discover = path.match(/^\/api\/approval-requests\/([a-z]{26})\/result$/);
  const delivery = path.match(/^\/api\/approval-results\/([A-Za-z0-9_-]+)\/(fetch|ack)$/);
  const entry = discover ? entries.get(discover[1]!) : delivery ? byResult.get(delivery[1]!) : undefined;
  if (request.method !== "POST" || !entry || !request.headers.get("OpenKey-Session-Proof")) return new Response(null, { status: 404 });
  const body = await request.json() as { ackId?: string };
  if (discover) {
    entry.discovers++;
    return entry.relay ? Response.json({ resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt }) : new Response(null, { status: 202 });
  }
  if (delivery![2] === "fetch") {
    return Response.json({ requestId: entry.id, bodyCid: entry.record.header.bodyCid, resultRef: entry.resultRef, expiresAt: entry.resultExpiresAt, relay: entry.relay });
  }
  entry.acks++;
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
}

const home = (name: string) => join(root, `home-${name}`);

async function cli(name: string, args: string[]) {
  await mkdir(home(name), { recursive: true, mode: 0o700 });
  const origin = server.url.origin;
  const env: Record<string, string> = {
    PATH: process.env.PATH!, HOME: home(name), TC_HOME: home(name), TMPDIR: join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(root, "cache"), TC_AUTH_NO_POPUP: "1",
    TC_OPENKEY_HOST: origin, TC_OPENKEY_API_HOST: origin, TC_LINKS_API_ORIGIN: origin,
    TC_ALLOWED_ORIGIN: origin, NODE_EXTRA_CA_CERTS: certificatePath, NODE_TLS_REJECT_UNAUTHORIZED: "1",
  };
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", TEST_BOOTSTRAP, "--preload", guardPath, cliEntry, "--host", origin, ...args],
    { env, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

async function pendingFile(name: string, profile: string): Promise<Array<{ requestId: string; request: OpenKeyApprovalRequestV1 }>> {
  const path = await withTinyCloudStateRoot(home(name), async () => join(profilePath(profile), "approval-pending.json"));
  return JSON.parse(await readFile(path, "utf8"));
}

async function profileExists(name: string): Promise<boolean> {
  return Bun.file(await withTinyCloudStateRoot(home(name), async () => profileConfigPath("default"))).exists();
}

/** The owner approves the profile's saved request: an owner-signed session for its key, encrypted to the request's result key. */
async function approve(name: string, profile: string): Promise<void> {
  const [saved] = await pendingFile(name, profile);
  const entry = entries.get(saved!.requestId)!;
  const request = saved!.request;
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of request.permissions) {
    const service = permission.service.slice("tinycloud.".length);
    abilities[service] = { ...abilities[service], [permission.path]: [...(abilities[service]?.[permission.path] ?? []), ...permission.actions] };
  }
  const address = await owner.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const now = Date.now();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId,
    jwk: request.targetPublicJwk, issuedAt: new Date(now - 1000).toISOString(),
    expirationTime: new Date(now + request.grantLifetimeSeconds * 1000).toISOString() });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const delegation = { ...session, address, chainId: 1, spaceId, ownerDid, verificationMethod: request.targetDid, siwe: prepared.siwe, signature };
  const delegationExpiresAt = new Date(prepared.siwe.match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
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
  entry.resultExpiresAt = new Date(now + 600_000).toISOString();
  entry.relay = { version: 1, algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") },
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  byResult.set(entry.resultRef, entry);
}

function pendingOf(result: { exitCode: number; stdout: string; stderr: string }) {
  expect({ exitCode: result.exitCode, stderr: result.exitCode === 8 ? "" : result.stderr }).toEqual({ exitCode: 8, stderr: "" });
  const { pending } = JSON.parse(result.stdout) as { pending: { step: number; of: number; approvalUrl: string; expiresAt: string } };
  expect(pending).toMatchObject({ step: 1, of: 1 });
  expect(pending.approvalUrl.startsWith(`${server.url.origin}/a/`)).toBe(true);
  return pending;
}

beforeAll(async () => {
  root = await mkdtemp("/var/tmp/TC2433-login-init-timeout-");
  await chmod(root, 0o700);
  for (const directory of ["tmp", "cache"]) await mkdir(join(root, directory), { mode: 0o700 });
  certificatePath = join(root, "cert.pem");
  const keyPath = join(root, "key.pem");
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certificatePath], { stdout: "pipe", stderr: "pipe" });
  if (await openssl.exited !== 0) throw new Error(`Fixture TLS setup failed: ${await new Response(openssl.stderr).text()}`);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(keyPath), cert: Bun.file(certificatePath) }, fetch: fixture });
  guardPath = join(root, "loopback-fetch.ts");
  await writeFile(guardPath, `const allowed = process.env.TC_ALLOWED_ORIGIN;
const actualFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== allowed) throw new Error("Fixture refused an off-loopback fetch to " + url.origin);
  return actualFetch(input, init);
}) as typeof fetch;
`, { mode: 0o600 });
});

afterAll(async () => {
  server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("auth login --method openkey --timeout", () => {
  test("a new link exits 8 at once; a rerun resumes the same link and exits 8 at the deadline; an approval after it is collected", async () => {
    const started = Date.now();
    const first = pendingOf(await cli("login", ["auth", "login", "--method", "openkey", "--no-popup", "--timeout", "30s"]));
    // A new link is handed over at once, not after the 30 s wait.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(entries.size).toBe(1);
    // The profile this login created stays while the approval is pending: the rerun signs with the same key.
    expect(await profileExists("login")).toBe(true);

    const resumeStarted = Date.now();
    const second = pendingOf(await cli("login", ["auth", "login", "--method", "openkey", "--no-popup", "--timeout", "2s"]));
    expect(second.approvalUrl).toBe(first.approvalUrl);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(Date.now() - resumeStarted).toBeGreaterThanOrEqual(2_000);
    expect(entries.size).toBe(1);
    const [entry] = [...entries.values()];
    expect(entry!.discovers).toBeGreaterThan(0);

    await approve("login", "default");
    const done = await cli("login", ["auth", "login", "--method", "openkey", "--no-popup", "--timeout", "2s"]);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ authenticated: true, profile: "default", authMethod: "openkey",
      ownerDid: `did:pkh:eip155:1:${await owner.getAddress()}` });
    expect(entries.size).toBe(1);
    expect(entry!.acks).toBe(1);
  });

  test.each([
    ["--device", ["--device", "--manifest", "x.json"]],
    ["--paste", ["--paste"]],
    ["--method local", ["--method", "local"]],
    ["--keys", ["--keys", "qa"]],
    ["--replication-prefix", ["--method", "openkey", "--replication-prefix", "notes/"]],
  ])("--timeout with %s is a usage error before anything is created or contacted", async (_name, extra) => {
    const before = entries.size;
    const result = await cli("refused", ["auth", "login", ...extra, "--timeout", "60s"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain("pending");
    expect(result.stdout + result.stderr).toContain("--timeout");
    expect(entries.size).toBe(before);
    expect(await profileExists("refused")).toBe(false);
  });

  test("an invalid --timeout is refused with exit 2", async () => {
    const result = await cli("refused", ["auth", "login", "--method", "openkey", "--timeout", "10m"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain("INVALID_TIMEOUT");
  });
});

describe("init --timeout", () => {
  test("a new link exits 8 at once; a rerun of init resumes the same link instead of PROFILE_EXISTS", async () => {
    const first = pendingOf(await cli("init", ["init", "--no-popup", "--timeout", "30s"]));
    const linksBefore = entries.size;
    const second = pendingOf(await cli("init", ["init", "--no-popup", "--timeout", "2s"]));
    expect(second.approvalUrl).toBe(first.approvalUrl);
    expect(entries.size).toBe(linksBefore);

    await approve("init", "default");
    const done = await cli("init", ["init", "--no-popup", "--timeout", "2s"]);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ profile: "default", authenticated: true });
    // Signed in now: a further init is refused as before.
    const again = await cli("init", ["init", "--no-popup", "--timeout", "2s"]);
    expect(again.exitCode).toBe(1);
    expect(again.stdout + again.stderr).toContain("PROFILE_EXISTS");
    expect(entries.size).toBe(linksBefore);
  });

  test("an existing profile with no waiting sign-in is still refused with PROFILE_EXISTS", async () => {
    expect((await cli("keyonly", ["init", "--key-only"])).exitCode).toBe(0);
    const before = entries.size;
    const result = await cli("keyonly", ["init", "--no-popup", "--timeout", "2s"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("PROFILE_EXISTS");
    expect(entries.size).toBe(before);
  });

  test.each([["--paste", ["--paste"]], ["--key-only", ["--key-only"]]])("--timeout with %s is a usage error and creates no profile", async (_name, extra) => {
    const result = await cli("init-refused", ["init", ...extra, "--timeout", "60s"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain("--timeout");
    expect(await profileExists("init-refused")).toBe(false);
  });
});

describe.each([
  ["auth login", ["auth", "login", "--help"], "OpenKey sign-in only (not --device, --paste, --keys or replication)."],
  ["init", ["init", "--help"], "OpenKey sign-in only (not --paste or --key-only)."],
])("%s --help", (_name, args, prefix) => {
  test("documents --timeout with the sign-in text, not the onboard text", async () => {
    const result = await cli("help", args);
    expect(result.exitCode).toBe(0);
    // Help wraps long lines; compare the text with its whitespace collapsed.
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain(`--timeout <duration> ${prefix} Wait at most this long for the owner's OpenKey approval`);
    expect(help).toContain('Exits 8 with {"pending":{"step","of","approvalUrl","expiresAt"}} on stdout');
    expect(help).toContain("That isn't a failure: the same command resumes the saved request.");
    expect(help).toContain("it also waits for OpenKey to host the space");
    expect(help).not.toMatch(/onboard|step 2/);
  });
});
