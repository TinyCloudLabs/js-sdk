import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grantAuthRequest, NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import type { AuthRequestArtifact } from "@tinycloud/node-sdk";
import { signLocationRecordV2 } from "@tinycloud/sdk-core";
import type { PermissionEntry } from "@tinycloud/sdk-core";

interface HermeticNode {
  host: string;
  ownerDid: string;
  ownerPrivateKey: string;
  ownerRestorableSession: Record<string, unknown>;
  permissions: PermissionEntry[];
  provisionSecret(): void;
  stop(): void;
}
// Runtime-only Node fixture is outside the CLI rootDir; a static import would
// pull Node SDK test sources into CLI compilation instead of the fixture boundary.
const { createHermeticEncryptedNode } = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: object): Promise<HermeticNode> };

test("fresh delegate profile imports the exact three-service grant, reads, and preserves identity refusal without authority rewrites", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-registry-fresh-import-"));
  const root = resolve(import.meta.dir, "../../../..");
  const fixture = await createHermeticEncryptedNode({ secretPayloadValue: "fresh-three-service-dummy" });
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let registry: ReturnType<typeof Bun.serve> | undefined;
  try {
    fixture.provisionSecret();
    const { nodeId } = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
    let mismatchedNodeKeys = false;
    let forwardedAuthorizationAfterMismatch = false;
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: mismatchedNodeKeys ? "did:key:wrong-fixture-node" : nodeId, shareInvitationPublicKey: "A".repeat(43) });
      if (mismatchedNodeKeys && request.headers.has("authorization")) forwardedAuthorizationAfterMismatch = true;
      return fetch(new Request(`${fixture.host}${url.pathname}${url.search}`, request));
    } });
    const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
    const space = String(fixture.ownerRestorableSession.spaceId).toLowerCase();
    const record = await signLocationRecordV2({
      version: 2, subject: fixture.ownerDid, nodes: [{ did: nodeId, url: proxy.url.origin }],
      spaces: [{ space, nodes: [{ did: nodeId, mode: "read-write" }] }], encryptionNode: nodeId,
      updated_at: new Date().toISOString(), sequence: 0,
    }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
    registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ record }) });
    const configPath = join(home, "source-runtime.json");
    await writeFile(configPath, JSON.stringify({ compilerOptions: { baseUrl: root, paths: {
      "@tinycloud/node-sdk": [join(root, "packages/node-sdk/src/index.ts")],
      "@tinycloud/node-sdk/core": [join(root, "packages/node-sdk/src/core.ts")],
      "@tinycloud/node-sdk/encryption-keys": [join(root, "packages/node-sdk/src/encryption-keys.ts")],
      "@tinycloud/node-sdk-wasm": [fileURLToPath(import.meta.resolve("@tinycloud/node-sdk-wasm"))],
    } } }));
    const guardPath = join(home, "network-guard.mjs");
    await writeFile(guardPath, `const raw=globalThis.fetch; const allowed=new Set(JSON.parse(process.env.TC_TEST_ORIGINS)); globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url); if(!allowed.has(url.origin)) throw new Error('Non-fixture origin refused'); return raw(input,init);};`);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, TC_HOME: home };
    for (const key of Object.keys(env)) if ((key.startsWith("TC_") && key !== "TC_HOME") || key.startsWith("COURIER_")) delete env[key];
    env.TC_TEST_ORIGINS = JSON.stringify([fixture.host, proxy.url.origin, registry.url.origin]);
    const cli = async (args: string[], input?: unknown) => {
      const child = Bun.spawn([process.execPath, "run", "--preload", guardPath, "--tsconfig-override", configPath,
        join(root, "packages/cli/src/index.ts"), ...args], { cwd: root, env,
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      if (input !== undefined) child.stdin.write(JSON.stringify(input));
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const errorCode = stderr.match(/"code"\s*:\s*"([A-Z_]+)"/)?.[1];
      return { stdout, code, errorCode };
    };
    const profile = "fresh";
    const created = await cli(["profile", "create", profile, "--posture", "delegate-session", "--operator", "agent", "--host", fixture.host, "--registry-url", registry.url.origin]);
    expect({ code: created.code, error: created.errorCode }).toEqual({ code: 0, error: undefined });
    const shown = await cli(["--json", "profile", "show", profile]);
    const initial = JSON.parse(shown.stdout) as Record<string, unknown>;
    expect(initial).not.toHaveProperty("spaceId");
    expect(initial).not.toHaveProperty("ownerDid");
    expect(initial).not.toHaveProperty("ownerAddress");
    const permissions: PermissionEntry[] = [
      { service: "tinycloud.kv", space, path: fixture.permissions.find((permission) => permission.service === "tinycloud.kv")!.path, actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.encryption", path: fixture.permissions.find((permission) => permission.service === "tinycloud.encryption")!.path, actions: ["tinycloud.encryption/decrypt"] },
      { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] },
    ];
    const permissionPath = join(home, "permissions.json"), requestPath = join(home, "request.json");
    await writeFile(permissionPath, JSON.stringify({ permissions }));
    const requested = await cli(["--profile", profile, "auth", "request", "--permission", permissionPath, "--expiry", "10m", "--emit", requestPath]);
    expect({ code: requested.code, error: requested.errorCode }).toEqual({ code: 0, error: undefined });
    const request = JSON.parse(await Bun.file(requestPath).text()) as AuthRequestArtifact & { sessionDid: string };
    expect(request.sessionDid).toBe(String(initial.sessionDid).split("#", 1)[0]);
    const owner = new TinyCloudNode({ signer, wasmBindings: new NodeWasmBindings(), host: fixture.host,
      tinycloudRegistryUrl: registry.url.origin, autoCreateSpace: false, autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false, enablePublicSpace: false });
    await owner.restoreSession(fixture.ownerRestorableSession as Parameters<TinyCloudNode["restoreSession"]>[0]);
    expect(owner.hasRuntimePermissions(request.requested)).toBe(false);
    await owner.grantRuntimePermissions(request.requested, { expiry: "10m" });
    expect(owner.hasRuntimePermissions(request.requested)).toBe(true);
    const grant = await grantAuthRequest(owner, request);
    const imported = await cli(["--profile", profile, "auth", "import", "--stdin"], grant);
    expect({ code: imported.code, error: imported.errorCode }).toEqual({ code: 0, error: undefined });
    const read = await cli(["--profile", profile, "secrets", "get", "HERMETIC_DELEGATION_CANARY", "--raw"]);
    expect({ code: read.code, error: read.errorCode }).toEqual({ code: 0, error: undefined });
    expect(read.stdout.trim()).toBe("fresh-three-service-dummy");
    mismatchedNodeKeys = true;
    const refused = await cli(["--profile", profile, "secrets", "get", "HERMETIC_DELEGATION_CANARY", "--raw"]);
    expect(refused.code).not.toBe(0);
    expect(refused.errorCode).toBe("NODE_IDENTITY_MISMATCH");
    expect(forwardedAuthorizationAfterMismatch).toBe(false);
    const after = JSON.parse((await cli(["--json", "profile", "show", profile])).stdout) as Record<string, unknown>;
    expect(after.sessionDid).toBe(initial.sessionDid);
    expect(after.host).toBe(initial.host);
  } finally {
    registry?.stop(true); proxy?.stop(true); fixture.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
