import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TinyCloudNode } from "@tinycloud/node-sdk";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import {
  OTHER_OWNER_KEY,
  openKeyApprovalBody,
  openKeyCallbackBody,
  ownerSpace,
  siweDelegationFromCallback,
} from "./test-support/openkey-callback.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).reverse().map((dispose) => dispose()));
});

test("official Streamable HTTP client authenticates and starts delegated setup", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "EdDSA";
  const jwksServer = await serveJwks(publicJwk);
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-e2e-"));
  resources.push(() => rm(stateDir, { recursive: true, force: true }));

  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: jwksServer,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  resources.push(() => app.close());

  const token = await new SignJWT({
    scope: "openid tinycloud:mcp",
    azp: "claude-test",
    "https://tinycloud.xyz/owner_dids": [
      "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
    ],
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject("openkey-user-1")
    .setAudience("https://mcp.test/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
    authProvider: { token: async () => token },
    fetch: (input, init) => hostedFetch(app, input, init),
  });
  const client = new Client({ name: "hosted-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  resources.push(() => client.close());

  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(16);
  expect(tools.tools.map((tool) => tool.name)).toContain("tinycloud_connect");
  // TC-834 scopes secrets status to local/stdio; hosted lacks a persistent
  // reauthorization path for a server-revoked session (TC-896).
  expect(tools.tools.map((tool) => tool.name)).not.toContain("tinycloud_secrets_status");
  const unknownTool = await client.callTool({ name: "tinycloud_secrets_status", arguments: { names: ["MCP_TEST_SECRET"] } })
    .then((value) => JSON.stringify(value), (error: unknown) => String(error));
  expect(unknownTool).toMatch(/tinycloud_secrets_status not found|Unknown tool/i);
  expect(unknownTool).not.toContain("tinycloud.secrets.status");
  // Delegations reach hosted tenants only through the owner-bound callback.
  expect(tools.tools.map((tool) => tool.name)).not.toContain("tinycloud_auth_import");

  const result = await client.callTool({ name: "tinycloud_connect", arguments: {} });
  const structured = result.structuredContent;
  const approvalUrl = typeof structured === "object" && structured !== null && "approvalUrl" in structured
    ? String(structured.approvalUrl)
    : "";
  expect(result.structuredContent).toMatchObject({
    connected: false,
    sessionDid: expect.stringMatching(/^did:key:/),
    approvalUrl: expect.stringMatching(/^https:\/\/mcp\.test\/connect\?state=/),
  });

  // Another wallet approving this tenant's link gets a fixed refusal.
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const foreign = await openKeyCallbackBody({
    tenantStateRoot: join(stateDir, "tenants", tenantId!),
    privateKey: OTHER_OWNER_KEY,
    space: "account",
    abilities: { kv: { "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
  });
  const state = new URL(approvalUrl).searchParams.get("state")!;
  const callback = await hostedFetch(app, `https://mcp.test/connect/callback?state=${encodeURIComponent(state)}`, {
    method: "POST",
    headers: { origin: "https://openkey.test", "content-type": "application/json" },
    body: JSON.stringify({ ...foreign, note: "<script>untrusted</script>" }),
  });
  expect(callback.status).toBe(403);
  expect(callback.headers.get("access-control-allow-origin")).toBe("https://openkey.test");
  expect(await callback.json()).toEqual({
    error: "This approval link was requested by a different TinyCloud account, so the delegation was not stored.",
    code: "approval_owner_mismatch",
  });
}, 60_000);

test("a signed bootstrap and a signed delegation approval let a hosted tool use the stored authority", async () => {
  // The loopback node lives in node-sdk's test sources, outside this package's
  // build graph; stdio.test.ts loads the same fixtures the same way.
  const hermeticModule = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts",
    import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await hermeticModule.createHermeticEncryptedNode();
  resources.push(async () => hermetic.stop());
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: hermetic.host,
    ownerDids: [hermetic.ownerDid],
  });
  let stage = "connect";
  try {
    const connect = await client.callTool({ name: "tinycloud_connect", arguments: {} });
    expect(connect.structuredContent).toMatchObject({ connected: false });
    const [tenantId] = await readdir(join(stateDir, "tenants"));
    const tenantStateRoot = join(stateDir, "tenants", tenantId!);

    stage = "store the signed bootstrap";
    const bootstrapUrl = String(record(connect.structuredContent).approvalUrl);
    const bootstrap = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, bootstrapUrl),
      tenantStateRoot,
      privateKey: hermetic.ownerPrivateKey,
    });
    // OpenKey activates the session it signs before posting it back.
    await activateOnNode(hermetic.host, bootstrap);
    expect(await postCallback(app, bootstrapUrl, bootstrap)).toEqual({ status: 200, body: { success: true } });
    expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
      .toMatchObject({ connected: true });

    stage = "use the bootstrap";
    expect((await client.callTool({ name: "tinycloud_account_spaces_list", arguments: {} })).structuredContent)
      .toMatchObject({
        status: "ok",
        output: { spaces: [{ spaceId: hermetic.applicationsSpaceId, name: "applications" }] },
      });

    stage = "request KV authority";
    const kvGet = { space: "applications", key: "agents/demo/profile", representation: "json" };
    const required = record((await client.callTool({ name: "tinycloud_kv_get", arguments: kvGet })).structuredContent);
    expect(required).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
    const delegationUrl = String(record(required.approval).url);
    const redirect = await openKeyRedirect(app, delegationUrl);

    stage = "refuse a foreign approval";
    const foreign = await openKeyApprovalBody({ redirect, tenantStateRoot, privateKey: OTHER_OWNER_KEY });
    expect(await postCallback(app, delegationUrl, foreign)).toMatchObject({
      status: 403,
      body: { code: "approval_owner_mismatch" },
    });

    stage = "refuse a direct import of a foreign CACAO";
    // The foreign owner's own space, so the delegation would satisfy the
    // stored request: only the missing owner binding should stop it.
    const foreignSpace = await ownerSpace(OTHER_OWNER_KEY, "applications");
    const foreignRequired = record((await client.callTool({
      name: "tinycloud_kv_get",
      arguments: { ...kvGet, space: foreignSpace },
    })).structuredContent);
    expect(foreignRequired).toMatchObject({ status: "authority_required" });
    const foreignCacao = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, String(record(foreignRequired.approval).url)),
      tenantStateRoot,
      privateKey: OTHER_OWNER_KEY,
    });
    const foreignDelegation = await siweDelegationFromCallback(foreignCacao, tenantStateRoot, hermetic.host);
    const directImport = await client.callTool({
      name: "tinycloud_auth_import",
      arguments: {
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: String(record(foreignRequired.request).requestId),
        delegationCid: foreignDelegation.cid,
        delegation: JSON.parse(JSON.stringify(foreignDelegation)),
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(directImport).toBeInstanceOf(Error);
    expect(String(directImport)).toContain("Tool tinycloud_auth_import not found");
    expect(await exists(join(tenantStateRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);
    expect(record((await client.callTool({
      name: "tinycloud_kv_get",
      arguments: { ...kvGet, space: foreignSpace },
    })).structuredContent)).toMatchObject({ status: "authority_required" });

    stage = "store the signed delegation";
    const approval = await openKeyApprovalBody({ redirect, tenantStateRoot, privateKey: hermetic.ownerPrivateKey });
    expect(await postCallback(app, delegationUrl, approval)).toEqual({ status: 200, body: { success: true } });

    stage = "use the stored delegation";
    expect((await client.callTool({ name: "tinycloud_kv_get", arguments: kvGet })).structuredContent).toMatchObject({
      status: "ok",
      output: { value: { name: "Ada", role: "operator" }, encoding: "json" },
    });
    hermetic.assertDelegatedKvResources([
      `tinycloud.kv/get:${hermetic.applicationsSpaceId}/kv/agents/demo/profile`,
    ]);
    // The stored authority is exactly what was approved.
    expect((await client.callTool({
      name: "tinycloud_kv_get",
      arguments: { ...kvGet, key: "agents/demo/settings" },
    })).structuredContent).toMatchObject({ status: "authority_required" });
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 60_000);

test("a refused delegation approval names its stage, code and reason, and never echoes the approval", async () => {
  // The loopback node is outside this package's build graph, as above.
  const hermeticModule = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts",
    import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await hermeticModule.createHermeticEncryptedNode();
  resources.push(async () => hermetic.stop());
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: hermetic.host,
    ownerDids: [hermetic.ownerDid],
  });
  const connect = await client.callTool({ name: "tinycloud_connect", arguments: {} });
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const tenantStateRoot = join(stateDir, "tenants", tenantId!);
  const bootstrapUrl = String(record(connect.structuredContent).approvalUrl);
  const bootstrap = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, bootstrapUrl),
    tenantStateRoot,
    privateKey: hermetic.ownerPrivateKey,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await postCallback(app, bootstrapUrl, bootstrap)).toEqual({ status: 200, body: { success: true } });
  const kvGet = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const required = record((await client.callTool({ name: "tinycloud_kv_get", arguments: kvGet })).structuredContent);
  const delegationUrl = String(record(required.approval).url);
  const redirect = await openKeyRedirect(app, delegationUrl);
  const approval = await openKeyApprovalBody({ redirect, tenantStateRoot, privateKey: hermetic.ownerPrivateKey });
  const broader = await openKeyCallbackBody({
    tenantStateRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "applications",
    abilities: { kv: { "agents/": ["tinycloud.kv/get"] } },
  });

  const canary = "approval-secret-canary";
  const secrets = [
    canary,
    String(record(approval.delegationHeader).Authorization),
    String(approval.signature),
    String(approval.siwe),
    String(record(connect.structuredContent).sessionDid),
  ];
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  resources.push(async () => stderr.mockRestore());
  const refuse = async (body: Record<string, unknown>) => {
    const state = new URL(delegationUrl).searchParams.get("state")!;
    const response = await hostedFetch(app, `https://mcp.test/connect/callback?state=${encodeURIComponent(state)}`, {
      method: "POST",
      headers: { origin: "https://openkey.test", "content-type": "application/json" },
      body: JSON.stringify({ ...body, token: `eyJ.${canary}.jwt`, delegation: canary }),
    });
    const text = await response.text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    return { status: response.status, body: JSON.parse(text) as unknown };
  };
  const message = "TinyCloud could not accept this delegation.";

  // The wallet proof no longer verifies when the delegation is projected.
  const verify = spyOn(TinyCloudNode.prototype, "verifySessionGrant").mockImplementation(() => {
    throw new Error(`verifier said ${canary}`);
  });
  const siwe = await refuse(approval).finally(() => verify.mockRestore());
  expect(siwe).toEqual({
    status: 400,
    body: { error: "siwe_runtime_delegation", code: "DELEGATION_REJECTED", reason: "proof_invalid", message },
  });

  // The node's `/delegate` re-activation refuses it, quoting the request in its response.
  const activate = spyOn(TinyCloudNode.prototype, "useRuntimeDelegation").mockRejectedValue(Object.assign(
    new Error(`Failed to activate runtime permission delegation: 403 ${canary}`),
    { cause: { success: false, status: 403, error: canary } },
  ));
  const activation = await refuse(approval).finally(() => activate.mockRestore());
  expect(activation).toEqual({
    status: 400,
    body: { error: "activation", code: "DELEGATION_REJECTED", reason: "activation_rejected", message },
  });

  // Correctly signed, but broader than the stored request.
  expect(await refuse(broader)).toEqual({
    status: 400,
    body: { error: "auth_import", code: "DELEGATION_REJECTED", message },
  });

  expect(diagnostics.filter((line) => line.startsWith("[tinycloud-mcp-http]"))).toEqual([
    "[tinycloud-mcp-http] connect callback rejected: stage=siwe_runtime_delegation code=DELEGATION_REJECTED reason=proof_invalid detail=none\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=activation code=DELEGATION_REJECTED reason=activation_rejected detail=none\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=auth_import code=DELEGATION_REJECTED detail=none\n",
  ]);
  for (const secret of secrets) expect(diagnostics.join("")).not.toContain(secret);
  expect(await exists(join(tenantStateRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);

  // The same approval, unrefused, still succeeds.
  expect(await postCallback(app, delegationUrl, approval)).toEqual({ status: 200, body: { success: true } });
}, 60_000);

interface HermeticNode {
  readonly host: string;
  readonly ownerDid: string;
  readonly ownerPrivateKey: string;
  readonly applicationsSpaceId: string;
  assertDelegatedKvResources(resources: readonly string[]): void;
  stop(): void;
}

async function startHostedMcp(options: { nodeHost: string; ownerDids: string[] }): Promise<{
  app: HostedMcpApp;
  client: Client;
  stateDir: string;
}> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "EdDSA";
  const jwksServer = await serveJwks(publicJwk);
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-e2e-"));
  resources.push(() => rm(stateDir, { recursive: true, force: true }));
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: options.nodeHost,
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: jwksServer,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  resources.push(() => app.close());
  const token = await new SignJWT({
    scope: "openid tinycloud:mcp",
    azp: "claude-test",
    "https://tinycloud.xyz/owner_dids": options.ownerDids,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject("openkey-user-1")
    .setAudience("https://mcp.test/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const client = new Client({ name: "hosted-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
    authProvider: { token: async () => token },
    fetch: (input, init) => hostedFetch(app, input, init),
  }));
  resources.push(() => client.close());
  return { app, client, stateDir };
}

/** Follow the hosted approval link to the OpenKey `/delegate` redirect. */
async function openKeyRedirect(app: HostedMcpApp, approvalUrl: string): Promise<URL> {
  const response = await hostedFetch(app, approvalUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

async function activateOnNode(host: string, body: Record<string, unknown>): Promise<void> {
  const authorization = record(body.delegationHeader).Authorization;
  if (typeof authorization !== "string") throw new Error("OpenKey session has no authorization.");
  const response = await fetch(`${host}/delegate`, { method: "POST", headers: { Authorization: authorization } });
  expect(response.status).toBe(200);
}

async function postCallback(
  app: HostedMcpApp,
  approvalUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const state = new URL(approvalUrl).searchParams.get("state")!;
  const response = await hostedFetch(app, `https://mcp.test/connect/callback?state=${encodeURIComponent(state)}`, {
    method: "POST",
    headers: { origin: "https://openkey.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function hostedFetch(
  app: HostedMcpApp,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(input.toString(), init);
  const headers = new Headers(request.headers);
  headers.set("host", "mcp.test");
  return app.fetch(new Request(request, { headers }));
}

async function serveJwks(jwk: object): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  return `http://127.0.0.1:${address.port}/jwks`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
