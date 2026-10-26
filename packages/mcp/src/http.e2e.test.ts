import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createPortServer } from "node:net";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeWasmBindings, TinyCloudNode, type TinyCloudSession } from "@tinycloud/node-sdk";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import {
  OTHER_OWNER_KEY,
  REQUESTER_KEY,
  openKeyApprovalBody,
  openKeyCallbackBody,
  ownerDid,
  ownerSpace,
  siweDelegationFromCallback,
} from "./test-support/openkey-callback.js";

const resources: Array<() => Promise<void>> = [];
const nodeBinary = process.env.TC_MCP_TEST_NODE;

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
  expect(tools.tools).toHaveLength(22);
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
  expect(JSON.stringify(result.content)).toContain(approvalUrl);
  expect(JSON.stringify(result.content)).toContain(String(record(structured).expiresAt));

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

test("public plugin enforces its tools, OAuth audience and separate approval state", async () => {
  const ownerDids = ["did:pkh:eip155:1:0x1111111111111111111111111111111111111111"];
  const { app, client, createClient } = await startHostedMcp({
    nodeHost: "https://node.tinycloud.test",
    ownerDids,
    resourcePath: "/chatgpt/mcp",
  });
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "tinycloud_apps_context", "tinycloud_apps_query", "tinycloud_apps_read",
    "tinycloud_apps_write", "tinycloud_connect",
  ]);
  for (const name of ["tinycloud_apps_context", "tinycloud_apps_query", "tinycloud_apps_write"]) {
    expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    });
  }
  expect(tools.find((tool) => tool.name === "tinycloud_apps_read")?.annotations)
    .toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  for (const name of [
    "tinycloud_secrets_get", "tinycloud_kv_get", "tinycloud_kv_put",
    "tinycloud_sql_query", "tinycloud_sql_execute", "tinycloud_auth_request",
    "tinycloud_auth_import", "tinycloud_account_spaces_list",
  ]) {
    const refusal = await client.callTool({ name, arguments: {} })
      .then((value) => JSON.stringify(value), (error: unknown) => String(error));
    expect(refusal).toMatch(/not found|Unknown tool/i);
  }
  const privateClient = await createClient("openkey-user-1", ownerDids, { path: "/mcp" });
  expect((await privateClient.listTools()).tools.map((tool) => tool.name))
    .toEqual(expect.arrayContaining(["tinycloud_secrets_get", "tinycloud_kv_get"]));
  for (const [path, audience] of [
    ["/chatgpt/mcp", "https://mcp.test/mcp"],
    ["/mcp", "https://mcp.test/chatgpt/mcp"],
  ]) {
    await expect(createClient("openkey-user-1", ownerDids, { path, audience })).rejects.toThrow();
  }
  const publicStatus = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const privateStatus = record((await privateClient.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  expect(publicStatus.connected).toBe(false);
  expect(publicStatus.sessionDid).toBeUndefined();
  const publicApproval = new URL(String(publicStatus.approvalUrl));
  const privateApproval = new URL(String(privateStatus.approvalUrl));
  expect(publicApproval.pathname).toBe("/chatgpt/connect");
  expect(privateApproval.pathname).toBe("/connect");
  const redirect = await openKeyRedirect(app, publicApproval.toString());
  expect(new URL(redirect.searchParams.get("callback")!).pathname).toBe("/chatgpt/connect/callback");
  publicApproval.pathname = "/connect";
  privateApproval.pathname = "/chatgpt/connect";
  expect((await hostedFetch(app, publicApproval)).status).toBe(400);
  expect((await hostedFetch(app, privateApproval)).status).toBe(400);
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

for (const marker of ["delegation-revoked", "delegation-ancestor-revoked"] as const) {
  test(`a definitive bootstrap ${marker} response renews one tenant once under concurrent connects`, async () => {
    const { hermetic, proxy, app, client, createClient, stateRoot, stateDir, bootstrap, approve } =
      await setupProxiedSession();
    const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
    const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
    const profilePath = join(stateRoot, ".tinycloud/profiles/agent/profile.json");
    const original = await readFile(sessionPath, "utf8");
    const authorization = String(record(bootstrap.delegationHeader).Authorization);
    const cid = String(bootstrap.delegationCid);
    const key = { space: "applications", key: "agents/demo/profile", representation: "json" };
    const required = record((await client.callTool({ name: "tinycloud_kv_get", arguments: key })).structuredContent);
    await approve(String(record(required.approval).url));
    const invokedRequest = record((await client.callTool({
      name: "tinycloud_kv_get", arguments: { ...key, key: "agents/demo/settings" },
    })).structuredContent);
    const invokedCid = String((await approve(String(record(invokedRequest.approval).url))).delegationCid);
    expect(invokedCid).not.toBe(cid);
    expect(await exists(additionalPath)).toBe(true);
    const other = await createClient("openkey-user-2");
    const otherConnect = record((await other.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
    const [otherId] = (await readdir(join(stateDir, "tenants")))
      .filter((entry) => stateRoot !== join(stateDir, "tenants", entry));
    const otherRoot = join(stateDir, "tenants", otherId!);
    const otherBody = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, String(otherConnect.approvalUrl)),
      tenantStateRoot: otherRoot, privateKey: hermetic.ownerPrivateKey,
    });
    await activateOnNode(proxy.host, otherBody);
    expect(await postCallback(app, String(otherConnect.approvalUrl), otherBody))
      .toEqual({ status: 200, body: { success: true } });
    const otherSessionPath = join(otherRoot, ".tinycloud/profiles/agent/session.json");
    const otherOriginal = await readFile(otherSessionPath, "utf8");
    const before = proxy.probes();
    const epochBefore = Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch ?? 0);
    const nodeText = marker === "delegation-revoked"
      ? `delegation-revoked: ${cid}`
      : `delegation-ancestor-revoked: ancestor=${cid} invoked=${invokedCid}`;
    proxy.onInvocation = async (actions) => {
      if (!respondsTo(actions, "tinycloud.kv/list", "spaces/")) return undefined;
      await Promise.resolve();
      return new Response(`Invalid invocation: ${nodeText}`, { status: 401 });
    };
    // No pending approval exists yet: this exercises the first pending write,
    // the probe, and the persistent cleanup under concurrent HTTP requests.
    const replies = await Promise.all(Array.from({ length: 6 }, () =>
      client.callTool({ name: "tinycloud_connect", arguments: {} })));
    const renewed = record(replies[0]!.structuredContent);
    const renewedUrl = String(renewed.approvalUrl);
    for (const reply of replies) {
      assertPublicReplyOmitsNodeData(reply, cid, authorization, nodeText, marker);
      expect(record(reply.structuredContent).approvalUrl === renewedUrl).toBe(true);
    }
    expect(renewed).toMatchObject({ connected: false, approvalUrl: expect.stringContaining("/connect?state=") });
    expect(proxy.probes() - before).toBe(1);
    expect(Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch)).toBe(epochBefore + 1);
    expect(await exists(sessionPath)).toBe(false);
    expect(await exists(additionalPath)).toBe(false);
    expect(await readFile(otherSessionPath, "utf8") === otherOriginal).toBe(true);
    proxy.onInvocation = undefined;
    expect((await other.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
      .toMatchObject({ connected: true });
    const stale = await postCallback(app, renewedUrl, bootstrap);
    assertPublicReplyOmitsNodeData(stale, cid, authorization, nodeText, marker);
    const fresh = await approve(renewedUrl);
    expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
      .toMatchObject({ connected: true });
    expect(await readFile(sessionPath, "utf8") === original).toBe(false);
  }, 90_000);
}

test("a cleared approval cannot be restored by a delayed pending-file writer", async () => {
  const { hermetic, proxy, app, client, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const request = record((await client.callTool({
    name: "tinycloud_kv_get",
    arguments: { space: "applications", key: "agents/demo/profile", representation: "json" },
  })).structuredContent);
  expect(request.status).toBe("authority_required");
  const oldUrl = String(record(request.approval).url);
  const oldRedirect = await openKeyRedirect(app, oldUrl);
  const nonce = new URL(oldUrl).searchParams.get("state")!.split(".")[1]!;
  const pendingPath = join(stateRoot, ".tinycloud/profiles/agent/pending", `${nonce}.json`);
  const pendingBytes = await readFile(pendingPath);
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const bootstrapCid = String(bootstrap.delegationCid);
  proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
    ? new Response(`delegation-revoked: ${bootstrapCid}`, { status: 401 })
    : undefined;
  const renewed = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const renewedUrl = String(renewed.approvalUrl);
  expect(renewed).toMatchObject({ connected: false, approvalUrl: expect.stringContaining("/connect?state=") });
  expect(await exists(sessionPath)).toBe(false);
  expect(await exists(additionalPath)).toBe(false);

  // A writer that started before cleanup may put the old file back afterwards.
  await mkdir(join(stateRoot, ".tinycloud/profiles/agent/pending"), { recursive: true });
  await writeFile(pendingPath, pendingBytes);
  const freshOldApproval = await openKeyApprovalBody({
    redirect: oldRedirect, tenantStateRoot: stateRoot, privateKey: hermetic.ownerPrivateKey,
  });
  expect((await hostedFetch(app, oldUrl, { redirect: "manual" })).status).toBe(400);
  expect(await postCallback(app, oldUrl, freshOldApproval)).toMatchObject({ status: 400 });
  expect(await exists(sessionPath)).toBe(false);
  expect(await exists(additionalPath)).toBe(false);
  proxy.onInvocation = undefined;
  await approve(renewedUrl);
  expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
    .toMatchObject({ connected: true });
}, 90_000);

test("distinct concurrent node checks share one tenant approval cleanup", async () => {
  const { hermetic, proxy, client, createClient, stateRoot, bootstrap } = await setupProxiedSession();
  const alternate = await createClient("openkey-user-1", [
    hermetic.ownerDid,
    await ownerDid(OTHER_OWNER_KEY),
  ]);
  const profilePath = join(stateRoot, ".tinycloud/profiles/agent/profile.json");
  const before = Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch ?? 0);
  const cid = String(bootstrap.delegationCid);
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => { release = resolve; });
  proxy.onInvocation = async (actions) => {
    if (!respondsTo(actions, "tinycloud.kv/list", "spaces/")) return undefined;
    if (++arrivals === 2) release();
    await bothArrived;
    return new Response(`delegation-revoked: ${cid}`, { status: 401 });
  };
  const replies = await Promise.all([client, alternate].map((caller) =>
    caller.callTool({ name: "tinycloud_connect", arguments: {} })));
  expect(arrivals).toBe(2);
  for (const reply of replies) {
    assertPublicReplyOmitsNodeData(reply, cid, String(record(bootstrap.delegationHeader).Authorization));
    expect(reply.structuredContent).toMatchObject({ connected: false });
  }
  expect(Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch)).toBe(before + 1);
  expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
}, 90_000);

test("a prior session file cannot be probed again while fresh approval is required", async () => {
  const { proxy, client, stateRoot, bootstrap } = await setupProxiedSession();
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const priorSession = await readFile(sessionPath, "utf8");
  const cid = String(bootstrap.delegationCid);
  proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
    ? new Response(`delegation-revoked: ${cid}`, { status: 401 })
    : undefined;
  const revoked = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  expect(revoked).toMatchObject({ connected: false, approvalUrl: expect.stringContaining("/connect?state=") });
  expect(await exists(sessionPath)).toBe(false);
  const probes = proxy.probes();
  // A delayed writer may restore older bytes after the cleanup has completed.
  await writeFile(sessionPath, priorSession);
  proxy.onInvocation = undefined;
  const renewed = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  expect(renewed).toMatchObject({ connected: false, approvalUrl: revoked.approvalUrl });
  expect(proxy.probes()).toBe(probes);
}, 90_000);

test("a node check already in flight cannot restore a withdrawn connection", async () => {
  const { hermetic, proxy, client, createClient, stateRoot, bootstrap } = await setupProxiedSession();
  const alternate = await createClient("openkey-user-1", [
    hermetic.ownerDid,
    await ownerDid(OTHER_OWNER_KEY),
  ]);
  const cid = String(bootstrap.delegationCid);
  let arrivals = 0;
  let enteredFirst!: () => void;
  const firstArrived = new Promise<void>((resolve) => { enteredFirst = resolve; });
  let admitFirst!: () => void;
  let admitSecond!: () => void;
  const secondArrived = new Promise<void>((resolve) => { admitFirst = resolve; });
  const releaseSecond = new Promise<void>((resolve) => { admitSecond = resolve; });
  proxy.onInvocation = async (actions) => {
    if (!respondsTo(actions, "tinycloud.kv/list", "spaces/")) return undefined;
    if (++arrivals === 1) {
      enteredFirst();
      await secondArrived;
      return new Response(`delegation-revoked: ${cid}`, { status: 401 });
    }
    admitFirst();
    await releaseSecond;
    return undefined;
  };
  const first = client.callTool({ name: "tinycloud_connect", arguments: {} });
  await firstArrived;
  const second = alternate.callTool({ name: "tinycloud_connect", arguments: {} });
  await secondArrived;
  expect((await first).structuredContent).toMatchObject({ connected: false });
  admitSecond();
  expect((await second).structuredContent).toMatchObject({ connected: false });
  expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  expect(arrivals).toBe(2);
}, 90_000);

test("a positive node check expires within thirty seconds and an unsuccessful probe is not cached", async () => {
  const { proxy, client, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const now = Date.now();
  const clock = spyOn(Date, "now");
  const call = () => client.callTool({ name: "tinycloud_auth_capabilities", arguments: {} });
  const baseline = proxy.probes();
  try {
    clock.mockReturnValue(now + 29_000);
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
      ? new Response("node unavailable", { status: 503 })
      : undefined;
    expect(record((await call()).structuredContent).status).toBe("ok");
    expect(proxy.probes()).toBe(baseline);
    clock.mockReturnValue(now + 31_000);
    expect(record((await call()).structuredContent).status).toBe("ok");
    expect(proxy.probes()).toBe(baseline + 1);
    const cid = String(bootstrap.delegationCid);
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
      ? new Response(`delegation-revoked: ${cid}`, { status: 401 })
      : undefined;
    const refusal = await call();
    assertPublicReplyOmitsNodeData(refusal, cid, String(record(bootstrap.delegationHeader).Authorization));
    expect(record(refusal.structuredContent)).toMatchObject({ status: "error" });
    expect(proxy.probes()).toBe(baseline + 2);
    expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
    proxy.onInvocation = undefined;
    const status = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
    const url = String(status.approvalUrl);
    expect(status.connected).toBe(false);
    await approve(url);
    expect(record((await call()).structuredContent).status).toBe("ok");
  } finally {
    clock.mockRestore();
    proxy.onInvocation = undefined;
  }
}, 90_000);

test("node errors without a definitive refusal preserve stored authority and discovery", async () => {
  const { proxy, client, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const key = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const required = record((await client.callTool({ name: "tinycloud_kv_get", arguments: key })).structuredContent);
  const grant = await approve(String(record(required.approval).url));
  const initial = await readFile(sessionPath, "utf8");
  const initialAdditional = await readFile(additionalPath, "utf8");
  const authorization = String(record(bootstrap.delegationHeader).Authorization);
  const cid = String(bootstrap.delegationCid);
  for (const [status, text] of [
    [401, "Invalid invocation: signature not yet valid; clock-skew"],
    [403, "database temporarily unavailable"],
    [429, "rate limited by node"],
    [503, "node unavailable"],
    [200, "{malformed-json"],
  ] as const) {
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
      ? new Response(text, { status, headers: { "content-type": "application/json" } })
      : undefined;
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "tinycloud_connect")).toBe(true);
    const reply = await client.callTool({ name: "tinycloud_connect", arguments: {} });
    assertPublicReplyOmitsNodeData(reply, cid, authorization, text);
    expect(reply.structuredContent).toMatchObject({ connected: false });
    expect(record(reply.structuredContent).approvalUrl).toBeUndefined();
    expect(await readFile(sessionPath, "utf8") === initial).toBe(true);
    expect(await readFile(additionalPath, "utf8") === initialAdditional).toBe(true);
    assertPublicReplyOmitsNodeData(reply, String(grant.delegationCid));
  }
}, 90_000);

test("node connection refusal does not break initialization, tools/list or a saved connection", async () => {
  const { proxy, client, createClient, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const required = record((await client.callTool({
    name: "tinycloud_kv_get",
    arguments: { space: "applications", key: "agents/demo/profile", representation: "json" },
  })).structuredContent);
  await approve(String(record(required.approval).url));
  const initial = await readFile(sessionPath, "utf8");
  const initialAdditional = await readFile(additionalPath, "utf8");
  await proxy.stop();
  const resumed = await createClient("openkey-user-1");
  expect((await resumed.listTools()).tools.length).toBeGreaterThan(0);
  expect((await client.listTools()).tools.some((tool) => tool.name === "tinycloud_connect")).toBe(true);
  const status = await resumed.callTool({ name: "tinycloud_connect", arguments: {} });
  assertPublicReplyOmitsNodeData(
    status, String(bootstrap.delegationCid), String(record(bootstrap.delegationHeader).Authorization),
  );
  expect(status.structuredContent).toMatchObject({ connected: false });
  expect(record(status.structuredContent).approvalUrl).toBeUndefined();
  expect(await readFile(sessionPath, "utf8") === initial).toBe(true);
  expect(await readFile(additionalPath, "utf8") === initialAdditional).toBe(true);
  const freshClient = await createClient("openkey-user-new");
  expect((await freshClient.listTools()).tools.length).toBeGreaterThan(0);
  expect((await freshClient.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
    .toMatchObject({ connected: false, approvalUrl: expect.stringContaining("/connect?state=") });
}, 90_000);

for (const marker of ["delegation-revoked", "delegation-ancestor-revoked"] as const) {
  test(`a scoped ${marker} refusal removes only its exact grant under concurrent operations`, async () => {
    const { hermetic, proxy, app, client, createClient, stateDir, stateRoot, bootstrap, approve } =
      await setupProxiedSession();
    const primary = { space: "applications", key: "agents/demo/profile", representation: "json" };
    const secondary = { ...primary, key: "agents/demo/settings" };
    const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
    const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
    const profilePath = join(stateRoot, ".tinycloud/profiles/agent/profile.json");
    const initialSession = await readFile(sessionPath, "utf8");
    const primaryRequest = record((await client.callTool({
      name: "tinycloud_kv_get", arguments: primary,
    })).structuredContent);
    expect(primaryRequest.status).toBe("authority_required");
    const primaryBody = await approve(String(record(primaryRequest.approval).url));
    const primaryCid = String(primaryBody.delegationCid);
    expect((await client.callTool({ name: "tinycloud_kv_get", arguments: primary })).structuredContent)
      .toMatchObject({ status: "ok", output: { value: { name: "Ada" } } });
    const secondaryRequest = record((await client.callTool({
      name: "tinycloud_kv_get", arguments: secondary,
    })).structuredContent);
    expect(secondaryRequest.status).toBe("authority_required");
    const secondaryBody = await approve(String(record(secondaryRequest.approval).url));
    const secondaryCid = String(secondaryBody.delegationCid);
    const initialAdditional = await readFile(additionalPath, "utf8");
    expect((JSON.parse(initialAdditional) as unknown[]).length).toBe(2);
    const bootstrapCid = String(bootstrap.delegationCid);
    const authorization = String(record(bootstrap.delegationHeader).Authorization);
    const epochBefore = Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch ?? 0);
    const other = await createClient("openkey-user-scoped-other");
    const otherLink = record((await other.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
    const [otherId] = (await readdir(join(stateDir, "tenants")))
      .filter((entry) => stateRoot !== join(stateDir, "tenants", entry));
    const otherRoot = join(stateDir, "tenants", otherId!);
    const otherBody = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, String(otherLink.approvalUrl)),
      tenantStateRoot: otherRoot, privateKey: hermetic.ownerPrivateKey,
    });
    await activateOnNode(proxy.host, otherBody);
    expect(await postCallback(app, String(otherLink.approvalUrl), otherBody))
      .toEqual({ status: 200, body: { success: true } });
    const otherSessionPath = join(otherRoot, ".tinycloud/profiles/agent/session.json");
    const otherInitial = await readFile(otherSessionPath, "utf8");

    const clockSkew = "Invalid invocation: signature not yet valid";
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/get", primary.key)
      ? new Response(clockSkew, { status: 401 })
      : undefined;
    const temporary = await client.callTool({ name: "tinycloud_kv_get", arguments: primary });
    assertPublicReplyOmitsNodeData(temporary, clockSkew, primaryCid, secondaryCid, authorization);
    expect(record(temporary.structuredContent)).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED" } });
    expect(await readFile(additionalPath, "utf8") === initialAdditional).toBe(true);
    expect(Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch ?? 0)).toBe(epochBefore);

    const nodeText = marker === "delegation-revoked"
      ? `delegation-revoked: ${primaryCid}`
      : `delegation-ancestor-revoked: ancestor=${primaryCid} invoked=${String(otherBody.delegationCid)}`;
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/get", primary.key)
      ? new Response(nodeText, { status: 401 })
      : undefined;
    const refusals = await Promise.all(Array.from({ length: 4 }, () =>
      client.callTool({ name: "tinycloud_kv_get", arguments: primary })));
    for (const reply of refusals) {
      assertPublicReplyOmitsNodeData(
        reply, nodeText, primaryCid, secondaryCid, bootstrapCid, authorization, marker,
      );
    }
    const renewed = record(refusals[0]!.structuredContent);
    expect(renewed).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
    expect(record(renewed.retry).inputDigest).toBe(record(primaryRequest.retry).inputDigest);
    const renewedUrl = String(record(renewed.approval).url);
    for (const reply of refusals) {
      const result = record(reply.structuredContent);
      expect(result.status).toBe("authority_required");
      expect(String(record(result.approval).url) === renewedUrl).toBe(true);
    }
    const requested = record(renewed.request).requested as unknown[];
    expect(requested.some((entry) => record(entry).path === primary.key)).toBe(true);
    expect(Number(record(JSON.parse(await readFile(profilePath, "utf8"))).approvalEpoch)).toBe(epochBefore + 1);
    const retained = await readFile(additionalPath, "utf8");
    expect(retained.includes(secondaryCid)).toBe(true);
    expect(retained.includes(primaryCid)).toBe(false);
    expect(await readFile(sessionPath, "utf8") === initialSession).toBe(true);
    expect(await readFile(otherSessionPath, "utf8") === otherInitial).toBe(true);
    proxy.onInvocation = undefined;
    expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
      .toMatchObject({ connected: true });
    expect((await other.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
      .toMatchObject({ connected: true });
    const secondaryResult = record((await client.callTool({
      name: "tinycloud_kv_get", arguments: secondary,
    })).structuredContent);
    expect(secondaryResult.status).not.toBe("authority_required");
    const again = record((await client.callTool({ name: "tinycloud_kv_get", arguments: primary })).structuredContent);
    expect(again).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
    expect(String(record(again.approval).url) === String(record(primaryRequest.approval).url)).toBe(false);
  }, 90_000);
}

test("a concurrent scoped refusal still includes approval after another call removes the grant", async () => {
  const { proxy, client, stateRoot, approve } = await setupProxiedSession();
  const primary = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const secondary = { ...primary, key: "agents/demo/settings" };
  const requiredPrimary = record((await client.callTool({ name: "tinycloud_kv_get", arguments: primary })).structuredContent);
  const primaryBody = await approve(String(record(requiredPrimary.approval).url));
  const requiredSecondary = record((await client.callTool({ name: "tinycloud_kv_get", arguments: secondary })).structuredContent);
  await approve(String(record(requiredSecondary.approval).url));
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const originalRename = fileSystem.rename;
  const originalRead = fileSystem.readFile;
  let enteredWrite!: () => void;
  const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let enteredRead!: () => void;
  const readEntered = new Promise<void>((resolve) => { enteredRead = resolve; });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  let heldWrite = false;
  let heldRead = false;
  let primaryRefusals = 0;
  const renameSpy = spyOn(fileSystem, "rename").mockImplementation(async (from, to) => {
    if (to === additionalPath && !heldWrite) {
      heldWrite = true;
      enteredWrite();
      await writeReleased;
    }
    return originalRename(from, to);
  });
  const readSpy = spyOn(fileSystem, "readFile").mockImplementation((async (path, options) => {
    if (path === additionalPath && heldWrite && primaryRefusals === 2 && !heldRead) {
      heldRead = true;
      enteredRead();
      await readReleased;
    }
    return originalRead(path, options);
  }) as typeof fileSystem.readFile);
  try {
    proxy.onInvocation = (actions) => {
      if (!respondsTo(actions, "tinycloud.kv/get", primary.key)) return undefined;
      primaryRefusals++;
      return new Response(`delegation-revoked: ${String(primaryBody.delegationCid)}`, { status: 401 });
    };
    const first = client.callTool({ name: "tinycloud_kv_get", arguments: primary });
    await writeEntered;
    const second = client.callTool({ name: "tinycloud_kv_get", arguments: primary });
    await readEntered;
    expect(primaryRefusals).toBe(2);
    releaseWrite();
    const firstReply = await first;
    releaseRead();
    const secondReply = await second;
    const firstResult = record(firstReply.structuredContent);
    const secondResult = record(secondReply.structuredContent);
    expect(firstResult).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
    expect(secondResult).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
    expect(String(record(secondResult.approval).url)).toBe(String(record(firstResult.approval).url));
    assertPublicReplyOmitsNodeData(secondReply, String(primaryBody.delegationCid));
  } finally {
    releaseRead();
    releaseWrite();
    readSpy.mockRestore();
    renameSpy.mockRestore();
  }
}, 90_000);

test("an in-flight approval finishes before bootstrap renewal clears saved authority", async () => {
  const { hermetic, proxy, app, client, stateRoot, bootstrap } = await setupProxiedSession();
  const first = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const second = { ...first, key: "agents/demo/settings" };
  const firstRequest = record((await client.callTool({ name: "tinycloud_kv_get", arguments: first })).structuredContent);
  const firstUrl = String(record(firstRequest.approval).url);
  const secondRequest = record((await client.callTool({ name: "tinycloud_kv_get", arguments: second })).structuredContent);
  const secondUrl = String(record(secondRequest.approval).url);
  const firstBody = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, firstUrl),
    tenantStateRoot: stateRoot,
    privateKey: hermetic.ownerPrivateKey,
  });
  await activateOnNode(proxy.host, firstBody);
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  let entered!: () => void;
  const approvalReachedNode = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const nodeMayAnswer = new Promise<void>((resolve) => { release = resolve; });
  proxy.onDelegation = async () => {
    entered();
    await nodeMayAnswer;
  };
  try {
    const callback = postCallback(app, firstUrl, firstBody);
    await approvalReachedNode;
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
      ? new Response(`delegation-revoked: ${String(bootstrap.delegationCid)}`, { status: 401 })
      : undefined;
    const reconnect = client.callTool({ name: "tinycloud_connect", arguments: {} });
    let redirectStatus = 302;
    for (let attempt = 0; attempt < 100 && redirectStatus !== 400; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      redirectStatus = (await hostedFetch(app, secondUrl, { redirect: "manual" })).status;
    }
    expect(redirectStatus).toBe(400);
    expect(await exists(sessionPath)).toBe(true);
    release();
    expect(await callback).toEqual({ status: 200, body: { success: true } });
    expect((await reconnect).structuredContent).toMatchObject({ connected: false });
    expect(await exists(sessionPath)).toBe(false);
    expect(await exists(additionalPath)).toBe(false);
  } finally {
    release();
    proxy.onDelegation = undefined;
  }
}, 90_000);

test("a full renewal leaves no scoped grants when a scoped write is in flight", async () => {
  const { proxy, app, client, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const primary = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const secondary = { ...primary, key: "agents/demo/settings" };
  const requiredPrimary = record((await client.callTool({ name: "tinycloud_kv_get", arguments: primary })).structuredContent);
  const primaryBody = await approve(String(record(requiredPrimary.approval).url));
  const requiredSecondary = record((await client.callTool({ name: "tinycloud_kv_get", arguments: secondary })).structuredContent);
  await approve(String(record(requiredSecondary.approval).url));
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const originalRename = fileSystem.rename;
  const originalRm = fileSystem.rm;
  let entered!: () => void;
  const scopedWriteEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const scopedWriteReleased = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let released = false;
  let removedBeforeScopedWrite = false;
  const renameSpy = spyOn(fileSystem, "rename").mockImplementation(async (from, to) => {
    if (to === additionalPath && !held) {
      held = true;
      entered();
      await scopedWriteReleased;
    }
    return originalRename(from, to);
  });
  const rmSpy = spyOn(fileSystem, "rm").mockImplementation(async (path, options) => {
    if (path === additionalPath && !released) {
      removedBeforeScopedWrite = true;
    }
    return originalRm(path, options);
  });
  try {
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/get", primary.key)
      ? new Response(`delegation-revoked: ${String(primaryBody.delegationCid)}`, { status: 401 })
      : undefined;
    const scoped = client.callTool({ name: "tinycloud_kv_get", arguments: primary });
    await scopedWriteEntered;
    const third = record((await client.callTool({
      name: "tinycloud_kv_get",
      arguments: { ...primary, key: "agents/demo/other" },
    })).structuredContent);
    expect(third.status).toBe("authority_required");
    const pendingUrl = String(record(third.approval).url);
    expect((await hostedFetch(app, pendingUrl, { redirect: "manual" })).status).toBe(302);
    proxy.onInvocation = (actions) => respondsTo(actions, "tinycloud.kv/list", "spaces/")
      ? new Response(`delegation-revoked: ${String(bootstrap.delegationCid)}`, { status: 401 })
      : undefined;
    const full = client.callTool({ name: "tinycloud_connect", arguments: {} });
    // The pending link changes as soon as full renewal begins, before disk cleanup.
    let redirectStatus = 302;
    for (let attempt = 0; attempt < 100 && redirectStatus !== 400; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      redirectStatus = (await hostedFetch(app, pendingUrl, { redirect: "manual" })).status;
    }
    expect(redirectStatus).toBe(400);
    const premature = await Promise.race([
      full.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 750)),
    ]);
    expect(premature).toBe("waiting");
    // The full clear cannot remove saved grants until the in-flight scoped write finishes.
    expect(removedBeforeScopedWrite).toBe(false);
    released = true;
    release();
    await scoped;
    expect((await full).structuredContent).toMatchObject({ connected: false });
    expect(await exists(additionalPath)).toBe(false);
    expect(await exists(sessionPath)).toBe(false);
  } finally {
    released = true;
    release();
    rmSpy.mockRestore();
    renameSpy.mockRestore();
  }
}, 90_000);

test("a node request timeout preserves saved grants and tool discovery", async () => {
  const { proxy, client, stateRoot, bootstrap, approve } = await setupProxiedSession();
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  const additionalPath = join(stateRoot, ".tinycloud/profiles/agent/additional-delegations.json");
  const required = record((await client.callTool({
    name: "tinycloud_kv_get",
    arguments: { space: "applications", key: "agents/demo/profile", representation: "json" },
  })).structuredContent);
  await approve(String(record(required.approval).url));
  const initial = await readFile(sessionPath, "utf8");
  const initialAdditional = await readFile(additionalPath, "utf8");
  // This package typechecks with ES2022, before Promise.withResolvers was typed.
  let unblock!: (response: Response) => void;
  const blocked = new Promise<Response>((resolve) => { unblock = resolve; });
  let signalArrival!: () => void;
  const arrived = new Promise<void>((resolve) => { signalArrival = resolve; });
  proxy.onInvocation = (actions) => {
    if (!respondsTo(actions, "tinycloud.kv/list", "spaces/")) return undefined;
    signalArrival();
    return blocked;
  };
  try {
    const started = performance.now();
    const pending = client.callTool({ name: "tinycloud_connect", arguments: {} });
    await arrived;
    const status = await pending;
    expect(performance.now() - started).toBeLessThan(4_000);
    assertPublicReplyOmitsNodeData(
      status, String(bootstrap.delegationCid), String(record(bootstrap.delegationHeader).Authorization),
    );
    expect(status.structuredContent).toMatchObject({ connected: false });
    expect(record(status.structuredContent).approvalUrl).toBeUndefined();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(await readFile(sessionPath, "utf8") === initial).toBe(true);
    expect(await readFile(additionalPath, "utf8") === initialAdditional).toBe(true);
  } finally {
    unblock(new Response("node unavailable", { status: 503 }));
  }
}, 90_000);

test("a partial or unreadable stored session offers new approval without breaking discovery", async () => {
  for (const contents of ['{"delegationCid":"incomplete"}', "{broken-json"]) {
    const { client, stateRoot } = await setupProxiedSession();
    const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
    await writeFile(sessionPath, contents);
    expect((await client.listTools()).tools.some((tool) => tool.name === "tinycloud_connect")).toBe(true);
    const status = await client.callTool({ name: "tinycloud_connect", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: false, approvalUrl: expect.stringContaining("/connect?state="),
    });
  }
}, 90_000);

test.skipIf(!nodeBinary)("a node revocation starts fresh hosted approval and restores tool access", async () => {
  const host = await startLocalNode(nodeBinary!);
  const owner = new TinyCloudNode({
    host,
    privateKey: REQUESTER_KEY,
    wasmBindings: new NodeWasmBindings(),
    domain: "mcp.test",
    autoCreateSpace: true,
    enablePublicSpace: false,
  });
  await owner.signIn();
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: host, ownerDids: [await ownerDid(REQUESTER_KEY)],
  });
  const first = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const root = join(stateDir, "tenants", tenantId!);
  const approve = openKeyApprover(app, host, root);
  const firstApproval = await approve(String(first.approvalUrl));
  const activeCapabilities = () => client.callTool({
    name: "tinycloud_auth_capabilities",
    arguments: {},
  });
  const before = record((await activeCapabilities()).structuredContent);
  expect(before.status).toBe("ok");
  const previousSession = JSON.parse(await readFile(
    join(root, ".tinycloud/profiles/agent/session.json"), "utf8",
  )) as TinyCloudSession;
  const receipt = await owner.revokeDelegation(String(firstApproval.delegationCid));
  expect(receipt.ok).toBe(true);
  const delegate = new TinyCloudNode({ host, wasmBindings: new NodeWasmBindings() });
  await delegate.restoreSession(previousSession);
  const refused = await delegate.kvForSpace(String(firstApproval.spaceId)).list({ prefix: "spaces/" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error.code).toBe("AUTH_UNAUTHORIZED");
  const status = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const url = String(status.approvalUrl);
  expect(status).toMatchObject({ connected: false, approvalUrl: expect.stringContaining("/connect?state=") });
  await approve(url);
  expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
    .toMatchObject({ connected: true });
  expect(record((await activeCapabilities()).structuredContent).status).toBe("ok");
}, 120_000);

test.skipIf(!nodeBinary)("a local node revocation sequence refuses each stored grant until fresh approval", async () => {
  const host = await startLocalNode(nodeBinary!);
  const owner = new TinyCloudNode({
    host,
    privateKey: REQUESTER_KEY,
    wasmBindings: new NodeWasmBindings(),
    domain: "mcp.test",
    autoCreateSpace: true,
    enablePublicSpace: false,
    // The seed write below is declared in the sign-in manifest.
    manifest: {
      app_id: "xyz.tinycloud.mcp-e2e-owner",
      name: "MCP e2e owner",
      defaults: false,
      includePublicSpace: false,
      prefix: "",
      space: "applications",
      permissions: [{
        service: "tinycloud.kv",
        space: "applications",
        path: "agents/demo/",
        actions: ["put"],
        skipPrefix: true,
      }],
    },
  });
  await owner.signIn();
  const applicationsSpace = await owner.hostOwnedSpace("applications");
  expect((await owner.kvForSpace(applicationsSpace).put("agents/demo/profile", { name: "Ada" })).ok).toBe(true);
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: host, ownerDids: [await ownerDid(REQUESTER_KEY)],
  });
  const first = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const approve = openKeyApprover(app, host, join(stateDir, "tenants", tenantId!));
  const bootstrapCid = String((await approve(String(first.approvalUrl))).delegationCid);
  const scoped = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const connect = async () =>
    record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const account = async () =>
    record((await client.callTool({ name: "tinycloud_auth_capabilities", arguments: {} })).structuredContent);
  const knowledge = async () =>
    record((await client.callTool({ name: "tinycloud_knowledge_list", arguments: {} })).structuredContent);
  const readScoped = async () =>
    record((await client.callTool({ name: "tinycloud_kv_get", arguments: scoped })).structuredContent);
  const grantScoped = async () => {
    const required = await readScoped();
    expect(required).toMatchObject({ status: "authority_required" });
    return approve(String(record(required.approval).url));
  };

  expect(await connect()).toMatchObject({ connected: true });
  expect(await account()).toMatchObject({ status: "ok" });
  const scopedCid = String((await grantScoped()).delegationCid);
  expect(await readScoped()).toMatchObject({ status: "ok" });

  // Revoking only the scoped grant leaves the bootstrap session valid.
  expect((await owner.revokeDelegation(scopedCid)).ok).toBe(true);
  expect(await readScoped()).toMatchObject({ status: "authority_required" });
  expect(await account()).toMatchObject({ status: "ok" });
  expect(await connect()).toMatchObject({ connected: true });
  const regrantedCid = String((await grantScoped()).delegationCid);
  expect(await readScoped()).toMatchObject({ status: "ok" });

  // Revoking the bootstrap session and the grant it replays refuses account, scoped and connect calls alike.
  const stored = JSON.parse(await readFile(join(stateDir, "tenants", tenantId!, ".tinycloud/profiles/agent/session.json"), "utf8")) as { delegationCid: string };
  expect(stored.delegationCid).toBe(bootstrapCid);
  expect((await owner.revokeDelegation(bootstrapCid)).ok).toBe(true);
  expect((await owner.revokeDelegation(regrantedCid)).ok).toBe(true);
  expect(await readScoped()).not.toMatchObject({ status: "ok" });
  const pending = await connect();
  expect(pending.connected).toBe(false);
  expect(String(pending.approvalUrl)).toContain("/connect?state=");
  // A refused knowledge call under the same session offers the same bootstrap link as connect.
  const knowledgeBootstrap = await knowledge();
  expect(knowledgeBootstrap).toMatchObject({ status: "error", error: { code: "SESSION_NOT_FOUND" } });
  expect(String(record(record(knowledgeBootstrap.error).details).approvalUrl)).toBe(String(pending.approvalUrl));

  await approve(String(pending.approvalUrl));
  expect(await connect()).toMatchObject({ connected: true });
  expect(await account()).toMatchObject({ status: "ok" });
  // After the bootstrap approval, knowledge_list needs its own approval and then succeeds.
  const knowledgeScoped = await knowledge();
  expect(knowledgeScoped).toMatchObject({ status: "authority_required" });
  await approve(String(record(knowledgeScoped.approval).url));
  expect(await knowledge()).toMatchObject({ status: "ok" });
  await grantScoped();
  expect(await readScoped()).toMatchObject({ status: "ok" });
}, 180_000);

function openKeyApprover(app: HostedApp, host: string, root: string) {
  return async (url: string) => {
    const body = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, url),
      tenantStateRoot: root,
      privateKey: REQUESTER_KEY,
    });
    const authorization = record(body.delegationHeader).Authorization;
    const activation = await fetch(`${host}/delegate`, {
      method: "POST",
      headers: { Authorization: String(authorization) },
    });
    expect(activation.status).toBe(200);
    expect(await postCallback(app, url, body)).toEqual({ status: 200, body: { success: true } });
    return body;
  };
}

type HostedApp = Awaited<ReturnType<typeof startHostedMcp>>["app"];

for (const resourcePath of ["/mcp", "/chatgpt/mcp"]) {
test(`${resourcePath} apps approvals persist records and recover an expired session without losing grants`, async () => {
  // This loopback fixture is outside MCP's package build graph.
  const hermeticModule = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await hermeticModule.createHermeticEncryptedNode();
  resources.push(async () => hermetic.stop());
  hermetic.provisionKvSpace(await ownerSpace(hermetic.ownerPrivateKey, "default"));
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: hermetic.host, ownerDids: [hermetic.ownerDid], resourcePath,
  });
  const first = record((await client.callTool({ name: "tinycloud_apps_context", arguments: {} })).structuredContent);
  expect(first).toMatchObject({ status: "error", error: { code: "SESSION_NOT_FOUND" } });
  const bootstrapUrl = String(record(record(first.error).details).approvalUrl);
  const tenantsDir = join(stateDir, ...(resourcePath === "/chatgpt/mcp" ? ["chatgpt"] : []), "tenants");
  const [tenantId] = await readdir(tenantsDir);
  const tenantStateRoot = join(tenantsDir, tenantId!);
  const bootstrap = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, bootstrapUrl), tenantStateRoot, privateKey: hermetic.ownerPrivateKey,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await postCallback(app, bootstrapUrl, bootstrap)).toEqual({ status: 200, body: { success: true } });

  const required = record((await client.callTool({ name: "tinycloud_apps_context", arguments: {} })).structuredContent);
  expect(required).toMatchObject({ status: "authority_required" });
  const recordsUrl = String(record(required.approval).url);
  const approval = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, recordsUrl), tenantStateRoot, privateKey: hermetic.ownerPrivateKey,
  });
  expect(await postCallback(app, recordsUrl, approval)).toEqual({ status: 200, body: { success: true } });
  expect((await client.callTool({
    name: "tinycloud_apps_context", arguments: { timezone: "Europe/Berlin" },
  })).structuredContent).toMatchObject({ status: "ok", output: { timezone: "Europe/Berlin", catalog: { keys: [] } } });

  const root = "xyz.tinycloud.agent-data/";
  const key = `${root}fitness/weight/2026-10/2026-10-14`;
  const written = record((await client.callTool({
    name: "tinycloud_apps_write",
    arguments: { ops: [
      { op: "put", key: `${root}catalog/fitness`, value: {
        app: "fitness", title: "Fitness", about: "Body measurements", created: "2026-10-14",
      } },
      { op: "put", key: `${root}catalog/fitness/weight`, value: {
        app: "fitness", kind: "weight", about: "Daily weight", shape: "log", per: "day", v: 1,
        fields: { kg: "number: weight in kilograms" }, created: "2026-10-14",
      } },
      { op: "put", key, value: { at: "2026-10-14T09:00", data: { kg: 80.5 } } },
    ] },
  })).structuredContent);
  expect(written).toMatchObject({
    status: "ok", output: { ops: [
      { outcome: "ok" }, { outcome: "ok" },
      { outcome: "ok", key, value: { v: 1, by: "tinycloud-mcp", at: "2026-10-14T09:00+02:00", data: { kg: 80.5 } } },
    ] },
  });
  // Two keys exercise the SDK batch response rather than its one-key get fallback.
  const read = await client.callTool({
    name: "tinycloud_apps_read", arguments: { keys: [key, `${root}catalog/fitness/weight`] },
  });
  expect(read.structuredContent).toMatchObject({ status: "ok", output: { records: [
    { key, value: { data: { kg: 80.5 }, by: "tinycloud-mcp" }, etag: expect.any(String) },
    { key: `${root}catalog/fitness/weight`, value: { kind: "weight" } },
  ] } });
  expect(JSON.stringify(read.content)).toContain("80.5");

  const outsideRecords = await client.callTool({
    name: "tinycloud_apps_read", arguments: { keys: ["xyz.tinycloud.secrets/private-key"] },
  });
  expect(outsideRecords.structuredContent).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });

  const sessionPath = join(tenantStateRoot, ".tinycloud/profiles/agent/session.json");
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  const expired = await openKeyCallbackBody({
    tenantStateRoot, privateKey: hermetic.ownerPrivateKey, space: "account",
    abilities: { kv: {
      "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
      "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
    } },
    issuedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
  });
  await writeFile(sessionPath, JSON.stringify({ ...stored, ...expired }));
  const relogin = record((await client.callTool({ name: "tinycloud_apps_read", arguments: { keys: [key] } })).structuredContent);
  expect(relogin).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED", retryable: false } });
  const reloginUrl = String(record(record(relogin.error).details).approvalUrl);
  const renewed = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, reloginUrl), tenantStateRoot, privateKey: hermetic.ownerPrivateKey,
  });
  await activateOnNode(hermetic.host, renewed);
  expect(await postCallback(app, reloginUrl, renewed)).toEqual({ status: 200, body: { success: true } });
  expect((await client.callTool({ name: "tinycloud_apps_read", arguments: { keys: [key] } })).structuredContent)
    .toMatchObject({ status: "ok", output: { records: [{ key, value: { data: { kg: 80.5 } } }] } });
}, 60_000);
}

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

test("a tenant created on the retired default node host is moved to TC_HOST, so its authority approval imports", async () => {
  const outcome = await approveWithStoredHost("https://node.tinycloud.xyz");
  expect(outcome.callback).toEqual({ status: 200, body: { success: true } });
  expect(outcome.storedHost).toBe(outcome.nodeHost);
  expect(outcome.diagnostics).toEqual([
    `[tinycloud-mcp-http] tenant node host migrated: from=https://node.tinycloud.xyz to=${new URL(outcome.nodeHost).origin}\n`,
  ]);
  expect((await outcome.client.callTool({ name: "tinycloud_kv_get", arguments: outcome.kvGet })).structuredContent)
    .toMatchObject({ status: "ok", output: { value: { name: "Ada", role: "operator" } } });
}, 60_000);

test("a tenant pinned to another node host still refuses its authority approval with DELEGATION_HOST_MISMATCH", async () => {
  const outcome = await approveWithStoredHost("https://node.example.com");
  expect(outcome.callback).toEqual({
    status: 400,
    body: {
      error: "auth_import",
      code: "DELEGATION_HOST_MISMATCH",
      message: "TinyCloud could not accept this delegation.",
    },
  });
  expect(outcome.storedHost).toBe("https://node.example.com");
  expect(outcome.diagnostics).toEqual([
    "[tinycloud-mcp-http] connect callback rejected: stage=auth_import code=DELEGATION_HOST_MISMATCH detail=none\n",
  ]);
}, 60_000);

/**
 * The production shape: TC_HOST names the MCP's node, while the tenant
 * profile on the state volume was created with `storedHost`. Runs bootstrap,
 * a KV authority request and its signed approval callback.
 */
async function approveWithStoredHost(storedHost: string): Promise<{
  nodeHost: string;
  client: Client;
  kvGet: Record<string, string>;
  callback: { status: number; body: unknown };
  storedHost: unknown;
  diagnostics: string[];
}> {
  // The loopback node is outside this package's build graph, as above.
  const hermeticModule = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts",
    import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await hermeticModule.createHermeticEncryptedNode();
  resources.push(async () => hermetic.stop());
  const previousHost = process.env.TC_HOST;
  process.env.TC_HOST = hermetic.host;
  resources.push(async () => {
    if (previousHost === undefined) delete process.env.TC_HOST;
    else process.env.TC_HOST = previousHost;
  });
  const { app, client, stateDir } = await startHostedMcp({
    nodeHost: hermetic.host,
    ownerDids: [hermetic.ownerDid],
  });
  const connect = await client.callTool({ name: "tinycloud_connect", arguments: {} });
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const tenantStateRoot = join(stateDir, "tenants", tenantId!);
  const profilePath = join(tenantStateRoot, ".tinycloud/profiles/agent/profile.json");
  const created = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  await writeFile(profilePath, JSON.stringify({ ...created, host: storedHost }));

  const bootstrapUrl = String(record(connect.structuredContent).approvalUrl);
  const bootstrap = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, bootstrapUrl),
    tenantStateRoot,
    privateKey: hermetic.ownerPrivateKey,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await postCallback(app, bootstrapUrl, bootstrap)).toEqual({ status: 200, body: { success: true } });

  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  resources.push(async () => stderr.mockRestore());
  const kvGet = { space: "applications", key: "agents/demo/profile", representation: "json" };
  const required = record((await client.callTool({ name: "tinycloud_kv_get", arguments: kvGet })).structuredContent);
  expect(required).toMatchObject({ status: "authority_required", approval: { kind: "openkey" } });
  const delegationUrl = String(record(required.approval).url);
  const approval = await openKeyApprovalBody({
    redirect: await openKeyRedirect(app, delegationUrl),
    tenantStateRoot,
    privateKey: hermetic.ownerPrivateKey,
  });
  const callback = await postCallback(app, delegationUrl, approval);
  stderr.mockRestore();
  return {
    nodeHost: hermetic.host,
    client,
    kvGet,
    callback,
    storedHost: (JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>).host,
    diagnostics: diagnostics.filter((line) => line.startsWith("[tinycloud-mcp-http]")),
  };
}

interface HermeticNode {
  readonly host: string;
  readonly ownerDid: string;
  readonly ownerPrivateKey: string;
  readonly applicationsSpaceId: string;
  assertDelegatedKvResources(resources: readonly string[]): void;
  provisionKvSpace(spaceId: string): void;
  stop(): void;
}

async function startHostedMcp(options: { nodeHost: string; ownerDids: string[]; resourcePath?: string }): Promise<{
  app: HostedMcpApp;
  client: Client;
  stateDir: string;
  createClient: (subject: string, ownerDids?: string[], connection?: { path: string; audience?: string }) => Promise<Client>;
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
  const createClient = async (
    subject: string,
    ownerDids = options.ownerDids,
    connection: { path: string; audience?: string } = { path: options.resourcePath ?? "/mcp" },
  ): Promise<Client> => {
    const resourceUrl = new URL(connection.path, "https://mcp.test");
    const token = await new SignJWT({
      scope: "openid tinycloud:mcp",
      azp: "claude-test",
      "https://tinycloud.xyz/owner_dids": ownerDids,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
      .setIssuer("https://openkey.test/api/auth")
      .setSubject(subject)
      .setAudience(connection.audience ?? resourceUrl.toString())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const connected = new Client({ name: "hosted-mcp-test", version: "1.0.0" });
    await connected.connect(new StreamableHTTPClientTransport(resourceUrl, {
      authProvider: { token: async () => token },
      fetch: (input, init) => hostedFetch(app, input, init),
    }));
    resources.push(() => connected.close());
    return connected;
  };
  const client = await createClient("openkey-user-1");
  return { app, client, stateDir, createClient };
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
  const receipt: unknown = await response.json();
  const activated = record(receipt).activated;
  expect(activated).toBeArray();
  expect(
    (activated as unknown[]).includes(body.spaceId) || (activated as unknown[]).includes(body.delegationCid),
  ).toBe(true);
}

async function postCallback(
  app: HostedMcpApp,
  approvalUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const callbackUrl = new URL(approvalUrl);
  callbackUrl.pathname += "/callback";
  const response = await hostedFetch(app, callbackUrl, {
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

type NodeInvocation = { resource: string; action: string };

interface NodeProxy {
  host: string;
  readonly probes: () => number;
  onInvocation: ((actions: readonly NodeInvocation[]) => Promise<Response | undefined> | Response | undefined) | undefined;
  onDelegation: (() => Promise<void>) | undefined;
  stop(): Promise<void>;
}

/** Forward signed SDK traffic; replace only selected node replies. */
async function serveNodeProxy(upstream: string): Promise<NodeProxy> {
  let probes = 0;
  let closed = false;
  const proxy: NodeProxy = {
    host: "",
    probes: () => probes,
    onDelegation: undefined,
    onInvocation: undefined,
    stop: async () => {
      if (!closed) {
        closed = true;
        const stopping = closeServer(server);
        server.closeAllConnections();
        await stopping;
      }
    },
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", upstream);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      let replacement: Response | undefined;
      if (url.pathname === "/invoke" && typeof incoming.headers.authorization === "string") {
        const compact = incoming.headers.authorization.replace(/^Bearer /i, "").split(".");
        const payload = JSON.parse(Buffer.from(compact[1]!, "base64url").toString("utf8")) as {
          att?: Record<string, Record<string, unknown>>;
        };
        const actions = Object.entries(payload.att ?? {}).flatMap(([resource, capabilities]) =>
          Object.keys(capabilities).map((action) => ({ resource, action })));
        if (actions.some(({ resource, action }) =>
          action === "tinycloud.kv/list" && resource.includes("/kv/spaces/"))) probes++;
        replacement = await proxy.onInvocation?.(actions);
      }
      if (url.pathname === "/delegate") await proxy.onDelegation?.();
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (name === "host" || name === "connection" || name === "content-length" || name === "transfer-encoding") continue;
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const response = replacement ?? await fetch(new URL(incoming.url ?? "/", upstream), {
        method: incoming.method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "transfer-encoding" && name !== "connection") {
          outgoing.setHeader(name, value);
        }
      });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 502;
      outgoing.end("node unavailable");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => proxy.stop());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Node proxy did not start.");
  proxy.host = `http://127.0.0.1:${address.port}`;
  return proxy;
}

function respondsTo(actions: readonly NodeInvocation[], action: string, path: string): boolean {
  return actions.some((entry) => entry.action === action && entry.resource.endsWith(`/kv/${path}`));
}

async function setupProxiedSession(): Promise<{
  hermetic: HermeticNode;
  proxy: NodeProxy;
  app: HostedMcpApp;
  client: Client;
  createClient: (subject: string, ownerDids?: string[]) => Promise<Client>;
  stateRoot: string;
  stateDir: string;
  bootstrap: Record<string, unknown>;
  approve: (url: string) => Promise<Record<string, unknown>>;
}> {
  // Fixture source is outside MCP's package build graph; load only in the test.
  const hermeticModule = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await hermeticModule.createHermeticEncryptedNode();
  resources.push(async () => hermetic.stop());
  const proxy = await serveNodeProxy(hermetic.host);
  const { app, client, stateDir, createClient } = await startHostedMcp({
    nodeHost: proxy.host, ownerDids: [hermetic.ownerDid],
  });
  const first = record((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent);
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const stateRoot = join(stateDir, "tenants", tenantId!);
  const approve = async (url: string) => {
    const body = await openKeyApprovalBody({
      redirect: await openKeyRedirect(app, url), tenantStateRoot: stateRoot,
      privateKey: hermetic.ownerPrivateKey,
    });
    await activateOnNode(proxy.host, body);
    expect(await postCallback(app, url, body)).toEqual({ status: 200, body: { success: true } });
    return body;
  };
  const bootstrap = await approve(String(first.approvalUrl));
  expect((await client.callTool({ name: "tinycloud_connect", arguments: {} })).structuredContent)
    .toMatchObject({ connected: true });
  return { hermetic, proxy, app, client, createClient, stateRoot, stateDir, bootstrap, approve };
}

function assertPublicReplyOmitsNodeData(reply: unknown, ...privateValues: string[]): void {
  const output = JSON.stringify(reply);
  for (const value of privateValues) expect(output.includes(value)).toBe(false);
}

async function startLocalNode(binary: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tc1627-mcp-node-"));
  const portServer = createPortServer();
  const port = await new Promise<number>((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", () => {
      const address = portServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not allocate a local node port."));
        return;
      }
      portServer.close(() => resolve(address.port));
    });
  });
  const child: ChildProcess = spawn(binary, [], {
    cwd: directory,
    env: {
      ...process.env,
      TINYCLOUD_STORAGE__DATADIR: join(directory, "data"),
      TINYCLOUD_PORT: String(port),
      TINYCLOUD_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
      ROCKET_ADDRESS: "127.0.0.1",
      TINYCLOUD_KEYS__TYPE: "Static",
      TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  resources.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let output = "";
  const onData = (chunk: Buffer) => {
    const text = output + chunk.toString();
    if (text.includes("Rocket has launched")) resolveReady();
    // Keep only enough tail to match a marker split across chunks.
    output = text.slice(-"Rocket has launched".length);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.once("error", () => rejectReady(new Error("Local node could not start.")));
  child.once("exit", () => rejectReady(new Error("Local node exited before readiness.")));
  // Real process startup needs a bounded readiness failure, not a fixed sleep.
  const timer = setTimeout(() => rejectReady(new Error("Local node readiness timed out.")), 30_000);
  await ready.finally(() => clearTimeout(timer));
  return `http://127.0.0.1:${port}`;
}
