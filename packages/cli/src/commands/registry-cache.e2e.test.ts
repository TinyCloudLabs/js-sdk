import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { grantAuthRequest, NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import type { AuthRequestArtifact } from "@tinycloud/node-sdk";
import { signLocationRecordV2 } from "@tinycloud/sdk-core";
import type { PermissionEntry, RegistryCacheEntry } from "@tinycloud/sdk-core";

// Each run owns fresh TEST authority, profiles, grants and loopback services. This
// protocol fixture is not admission-enabled G and does not prove a G outage.
// URL loading keeps Node-only fixture sources outside the CLI's rootDir/DTS graph.
const { createHermeticEncryptedNode } = await import(new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href);

test("source CLI persists exact signed routing and reads after a client-only registry outage across processes", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-cache-owner-"));
  const root = resolve(import.meta.dir, "../../../..");
  const fixture = await createHermeticEncryptedNode({ secretPayloadValue: "tc2481-cache-TEST-value" });
  let box: Bun.Server<undefined> | undefined;
  let replacementBox: Bun.Server<undefined> | undefined;
  let enc: Bun.Server<undefined> | undefined;
  let registryFront: Bun.Server<undefined> | undefined;
  let registryBackend: Bun.Server<undefined> | undefined;
  try {
    fixture.provisionSecret();
    const { nodeId: encryptionDid } = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
    const boxDid = fixture.unrelatedAudience.split("#", 1)[0];
    let fallbackRequests = 0, wrongRole = 0, decryptRequests = 0, transient = false;
    const boxFetch = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/info") return Response.json({ ...await (await fetch(`${fixture.host}/info`)).json() as object, nodeId: boxDid });
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: boxDid, shareInvitationPublicKey: "A".repeat(43) });
      if (url.pathname.startsWith("/encryption/")) { wrongRole++; return new Response("wrong role", { status: 409 }); }
      return fetch(new Request(`${fixture.host}${url.pathname}${url.search}`, request));
    };
    box = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: boxFetch });
    replacementBox = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: boxFetch });
    const encryptionFetch = (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: encryptionDid, shareInvitationPublicKey: "A".repeat(43) });
      if (url.pathname === "/invoke") { wrongRole++; return new Response("wrong role", { status: 409 }); }
      if (request.method === "POST" && url.pathname.endsWith("/decrypt")) {
        decryptRequests++;
        if (transient) { transient = false; return new Response("TEST transient", { status: 503 }); }
      }
      return fetch(new Request(`${fixture.host}${url.pathname}${url.search}`, request));
    };
    enc = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: encryptionFetch });
    const encOrigin = enc.url.origin, encPort = enc.port;
    const fallback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { fallbackRequests++; return new Response("unlisted", { status: 500 }); } });
    try {
      const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
      const space = String(fixture.ownerRestorableSession.spaceId).toLowerCase();
      const record = await signLocationRecordV2({
        version: 2, subject: fixture.ownerDid, sequence: 41, updated_at: new Date().toISOString(),
        nodes: [{ did: boxDid, url: box.url.origin }, { did: encryptionDid, url: encOrigin }],
        spaces: [{ space, nodes: [{ did: boxDid, mode: "read-write" }] }], encryptionNode: encryptionDid,
      }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
      const exactBody = ` { "record" : ${JSON.stringify(record)} }\n`;
      let servedBody = exactBody;
      registryBackend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(servedBody) });
      const backendOrigin = registryBackend.url.origin;
      registryFront = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => fetch(backendOrigin) });
      const registryOrigin = registryFront.url.origin;
      const guard = join(home, "fixture-only.mjs");
      await writeFile(guard, `const raw=globalThis.fetch;const allowed=new Set(JSON.parse(process.env.TC_TEST_ORIGINS));globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed.has(u.origin))throw Error('Non-fixture origin refused');return raw(input,init)};`);
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, TC_HOME: home };
      for (const key of Object.keys(env)) if ((key.startsWith("TC_") && key !== "TC_HOME") || key.startsWith("COURIER_")) delete env[key];
      env.TC_TEST_ORIGINS = JSON.stringify([box.url.origin, replacementBox.url.origin, encOrigin, registryOrigin, fallback.url.origin]);
      const cli = async (args: string[], input?: unknown) => {
        const child = Bun.spawn([process.execPath, "--no-env-file", "run", "--preload", guard, join(root, "packages/cli/src/index.ts"), ...args], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        if (input !== undefined) child.stdin.write(JSON.stringify(input));
        child.stdin.end();
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, code, error: stderr.match(/"code"\s*:\s*"([A-Z_]+)"/)?.[1] };
      };
      const profile = "cache-test-delegate";
      const created = await cli(["profile", "create", profile, "--posture", "delegate-session", "--operator", "agent", "--host", fallback.url.origin, "--registry-url", registryOrigin]);
      expect(created.code).toBe(0);
      const permissions: PermissionEntry[] = [
        { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] },
        { ...fixture.permissions.find((entry: PermissionEntry) => entry.service === "tinycloud.kv")!, space },
        fixture.permissions.find((entry: PermissionEntry) => entry.service === "tinycloud.encryption")!,
      ];
      const permissionsPath = join(home, "TEST-permissions.json"), requestPath = join(home, "TEST-request.json");
      await writeFile(permissionsPath, JSON.stringify({ permissions }));
      expect((await cli(["--profile", profile, "auth", "request", "--permission", permissionsPath, "--expiry", "10m", "--emit", requestPath])).code).toBe(0);
      const request = JSON.parse(await readFile(requestPath, "utf8")) as AuthRequestArtifact;
      const owner = new TinyCloudNode({ signer, wasmBindings: new NodeWasmBindings(), host: encOrigin, tinycloudRegistryUrl: registryOrigin,
        autoCreateSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false, enablePublicSpace: false });
      await owner.restoreSession(fixture.ownerRestorableSession);
      await owner.grantRuntimePermissions(request.requested, { expiry: "10m" });
      const grant = await grantAuthRequest(owner, request);
      const imported = await cli(["--json", "--profile", profile, "auth", "import", "--stdin"], grant);
      expect({ code: imported.code, error: imported.error }).toEqual({ code: 0, error: undefined });
      const readSecret = () => cli(["--json", "--profile", profile, "secrets", "get", "HERMETIC_DELEGATION_CANARY", "--raw"]);
      const normal = await readSecret();
      expect({ code: normal.code, error: normal.error }).toEqual({ code: 0, error: undefined });
      expect(normal.stdout.trim()).toBe("tc2481-cache-TEST-value");
      const cachePath = join(home, ".tinycloud", "profiles", profile, "registry-cache.json");
      const entries = JSON.parse(await readFile(cachePath, "utf8")) as RegistryCacheEntry[];
      expect(entries.find((entry) => entry.sequence === 41)?.responseBody).toBe(exactBody);
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, ".tinycloud", "profiles", profile))).mode & 0o777).toBe(0o700);
      const higher = await signLocationRecordV2({
        version: 2, subject: fixture.ownerDid, sequence: 42, updated_at: new Date().toISOString(),
        nodes: [{ did: boxDid, url: replacementBox.url.origin }, { did: encryptionDid, url: encOrigin }],
        spaces: record.spaces, encryptionNode: encryptionDid,
      }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
      servedBody = ` { "record" : ${JSON.stringify(higher)} }\n`;
      expect((await readSecret()).code).toBe(0);
      const upgradedEntries = JSON.parse(await readFile(cachePath, "utf8")) as RegistryCacheEntry[];
      expect(upgradedEntries.find((entry) => entry.sequence === 42)?.responseBody).toBe(servedBody);
      await box.stop(true); // Sequence 41's removed origin must never be used again.
      await registryFront.stop(true); // Only the client's front dies; backend remains up.
      expect((await fetch(backendOrigin)).status).toBe(200);
      const cached = await readSecret();
      expect({ code: cached.code, error: cached.error }).toEqual({ code: 0, error: undefined });
      expect(cached.stdout.trim()).toBe("tc2481-cache-TEST-value");
      const shown = await cli(["--json", "--profile", profile, "registry", "show"]);
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({ owner: fixture.ownerDid, sequence: 42, nodes: higher.nodes, spaces: record.spaces, encryptionNode: encryptionDid });
      expect(await readFile(cachePath, "utf8")).toBe(`${JSON.stringify(upgradedEntries, null, 2)}\n`);
      const ciphertextReads = () => fixture.invocations().filter((entry: { action: string }) => entry.action === "tinycloud.kv/get").length;
      await enc.stop(true);
      const encDown = await readSecret();
      expect({ code: encDown.code, error: encDown.error, stdout: encDown.stdout }).toEqual({ code: 6, error: "DECRYPTION_DEPENDENCY_UNAVAILABLE", stdout: "" });
      expect(encDown.stderr).toMatch(/decryption service/i);
      enc = Bun.serve({ hostname: "127.0.0.1", port: encPort, fetch: encryptionFetch });
      transient = true;
      const before = decryptRequests, readsBefore = ciphertextReads();
      const mid503 = await readSecret();
      expect({ code: mid503.code, error: mid503.error, stdout: mid503.stdout }).toEqual({ code: 1, error: "SECRET_DECRYPT_FAILED", stdout: "" });
      expect(decryptRequests - before).toBe(1);
      expect(ciphertextReads()).toBeGreaterThan(readsBefore);
      await replacementBox.stop(true);
      const boxDown = await readSecret();
      expect({ code: boxDown.code, error: boxDown.error, stdout: boxDown.stdout }).toEqual({ code: 6, error: "NODE_NOT_RESPONDING", stdout: "" });
      expect(fallbackRequests).toBe(0);
      expect(wrongRole).toBe(0);
      await writeFile(cachePath, "{corrupt TEST cache");
      const corrupt = await cli(["--json", "--profile", profile, "registry", "show", fixture.ownerDid]);
      expect({ code: corrupt.code, error: corrupt.error, stdout: corrupt.stdout }).toEqual({ code: 1, error: "REGISTRY_UNAVAILABLE", stdout: "" });
    } finally { fallback.stop(true); }
  } finally {
    registryFront?.stop(true); registryBackend?.stop(true); box?.stop(true); replacementBox?.stop(true); enc?.stop(true); fixture.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
