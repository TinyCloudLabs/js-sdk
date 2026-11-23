import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeDelegation } from "@tinycloud/node-sdk";
import { createHermeticEncryptedNode } from "./test-support/hermetic-node.mjs";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";
import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { ApprovalStageError, RemoteTenantStore, approvalRefusalDiagnostic } from "./remote-store.js";
import {
  LINKS_API_ORIGIN,
  OPENKEY_API_ORIGIN,
  REQUESTER_KEY,
  installFakeOpenKey,
  openKeyDelegation,
  ownerDid,
  type FakeOpenKey,
} from "./test-support/openkey-approval.js";
import { MCP_VERSION } from "./version.js";
import { MCP_SERVER_NAME } from "./server.js";

const CANARY = "callback-secret-canary";

const directories: string[] = [];
const apps: HostedMcpApp[] = [];
const openkeys: FakeOpenKey[] = [];

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const openkey of openkeys.splice(0)) openkey.restore();
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  } finally {
    resetMcpRegistryFixture();
  }
});

test("serves hosted landing in HTML and Markdown with discovery links", async () => {
  const app = await testApp();
  const landing = await app.fetch(request("/"));
  const markdown = await app.fetch(request("/", { headers: { accept: "text/markdown" } }));
  const health = await app.fetch(new Request("http://127.0.0.1:3000/healthz", {
    headers: { host: "127.0.0.1:3000" },
  }));

  expect(landing.status).toBe(200);
  expect(landing.headers.get("content-type")).toContain("text/html");
  const html = await landing.text();
  expect(html).toContain("https://mcp.tinycloud.xyz/mcp");
  expect(html).toContain('<link rel="ai-catalog" href="/.well-known/ai-catalog.json">');
  expect(landing.headers.get("link")).toContain('rel="describedby"');
  expect(landing.headers.get("link")).toContain('rel="service-doc"');
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("content-type")).toContain("text/markdown");
  const markdownText = await markdown.text();
  expect(markdownText).toContain("Local alternative:");
  expect(markdownText).toContain("`@tinycloud/cli`");
  expect(markdownText).toContain("`@tinycloud/mcp`");
  expect(html).toContain("<code>@tinycloud/cli</code>");
  expect(html).toContain("<code>@tinycloud/mcp</code>");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
});

test("serves plain text LLM guidance and AI discovery directives", async () => {
  const app = await testApp();
  const llms = await app.fetch(request("/llms.txt"));
  const robots = await app.fetch(request("/robots.txt"));
  const sitemap = await app.fetch(request("/sitemap.xml"));

  expect(llms.status).toBe(200);
  expect(llms.headers.get("content-type")).toContain("text/plain");
  const llmsText = await llms.text();
  expect(llmsText).toContain("https://mcp.tinycloud.xyz/mcp");
  expect(llmsText).toContain("Local alternative: install @tinycloud/cli and @tinycloud/mcp, then set up tinycloud-mcp as a stdio server in your MCP client.");
  expect(llmsText).not.toContain("/chatgpt/mcp");
  expect(llmsText).not.toContain("Details: TC-1362");
  const robotsText = await robots.text();
  expect(robotsText).toContain("Allow: /");
  expect(robotsText).toContain("Agentmap: https://mcp.test/.well-known/ai-catalog.json");
  expect(await sitemap.text()).toContain("<loc>https://mcp.test/</loc>");
});

test("root OAuth Protected Resource Metadata alias matches the path-specific document", async () => {
  const app = await testApp();
  const protectedResource = await app.fetch(request("/.well-known/oauth-protected-resource/mcp"));
  const alias = await app.fetch(request("/.well-known/oauth-protected-resource", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const metadataPreflight = await app.fetch(request("/.well-known/oauth-protected-resource", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type",
    },
  }));

  expect(alias.status).toBe(200);
  const metadata = await alias.json();
  expect(metadata).toEqual(await protectedResource.json());
  expect(metadata).toMatchObject({
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://openkey.test/api/auth"],
    scopes_supported: ["tinycloud:mcp"],
    bearer_methods_supported: ["header"],
  });
  expect(alias.headers.get("access-control-allow-origin")).toBe("*");
  expect(metadataPreflight.status).toBe(204);
  expect(metadataPreflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(metadataPreflight.headers.get("access-control-allow-headers")).toContain("content-type");
});

test("serves the current MCP Server Card with only supported CORS methods", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-card-"));
  const app = await testApp(stateDir);
  const card = await app.fetch(request("/mcp/server-card", { headers: { origin: "https://scanner.example" } }));
  const wellKnownCard = await app.fetch(request("/.well-known/mcp/server-card.json", {
    headers: { origin: "https://scanner.example" },
  }));
  const cardPreflight = await app.fetch(request("/.well-known/mcp/server-card.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(card.status).toBe(200);
  expect(card.headers.get("access-control-allow-origin")).toBe("*");
  expect(wellKnownCard.headers.get("access-control-allow-origin")).toBe("*");
  const cardDocument = await card.json();
  expect(await wellKnownCard.json()).toEqual(cardDocument);
  expect(cardDocument).toMatchObject({
    name: `xyz.tinycloud/${MCP_SERVER_NAME}`,
    version: MCP_VERSION,
    remotes: [{ type: "streamable-http", url: "https://mcp.test/mcp" }],
  });
  expect(cardDocument).not.toHaveProperty("serverInfo");
  expect(cardDocument).not.toHaveProperty("endpoint");
  expect(cardDocument).not.toHaveProperty("capabilities");
  expect(cardDocument).not.toHaveProperty("x-tinycloud-native-auth");
  await expect(readFile(join(stateDir, ".tinycloud", "native-service-key.json"), "utf8"))
    .rejects.toThrow();
  expect(cardPreflight.status).toBe(204);
  expect(cardPreflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(cardPreflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  expect(cardPreflight.headers.get("access-control-allow-headers")).toBe("accept");
});

test("omits native discovery and reports service unavailable when the identity key is corrupt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-native-corrupt-key-"));
  directories.push(stateDir);
  const keyPath = join(stateDir, ".tinycloud", "native-service-key.json");
  await mkdir(join(stateDir, ".tinycloud"), { recursive: true });
  await writeFile(keyPath, "{}\n", { mode: 0o600 });
  const serviceCredential = "native-corrupt-key-test-credential-with-entropy";
  const app = await testApp(stateDir, { nativeServiceCredential: serviceCredential });

  const cardResponse = await app.fetch(request("/.well-known/mcp/server-card.json"));
  const card = await cardResponse.json() as Record<string, unknown>;
  expect(cardResponse.status).toBe(200);
  expect(card).not.toHaveProperty("x-tinycloud-native-auth");

  const intake = await app.fetch(request("/native/grant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tinycloud-service-credential": serviceCredential,
    },
    body: JSON.stringify({ delegation: "serialized portable delegation" }),
  }));
  expect(intake.status).toBe(503);
  expect(await intake.json()).toEqual({ error: "native_service_unavailable" });
});
test("publishes native service identity and keeps native tools on the grant-gated /mcp path", async () => {

  const serviceCredential = "native-test-service-credential-with-enough-entropy";
  const app = await testApp(undefined, { nativeServiceCredential: serviceCredential });
  const cardResponse = await app.fetch(request("/.well-known/mcp/server-card.json"));
  const card = await cardResponse.json() as Record<string, unknown>;
  expect(cardResponse.status).toBe(200);
  expect(card["x-tinycloud-native-auth"]).toMatchObject({
    serviceDid: expect.stringMatching(/^did:key:/),
    serviceDidField: "x-tinycloud-native-auth.serviceDid",
    grantEndpoint: {
      method: "POST",
      path: "/native/grant",
      body: { delegation: "serialized PortableDelegation JSON string" },
    },
    serviceCredentialHeader: "X-TinyCloud-Service-Credential",
    serviceCredentialEnv: "TC_MCP_NATIVE_SERVICE_CREDENTIAL",
    ownerDidHeader: "X-TinyCloud-Owner-DID",
    maxGrantLifetimeSeconds: 30 * 24 * 60 * 60,
    acceptedCapabilities: [
      { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/connectors", actions: ["tinycloud.sql/read"] },
      { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tinychat/connectors/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
    ],
    tools: ["tinycloud_sql_query", "tinycloud_kv_get", "tinycloud_read"],
    errors: {
      required: "native_grant_required",
      expired: "native_grant_expired",
      rejected: "native_grant_rejected",
    },
  });

  const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
  const noGrant = await app.fetch(request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-tinycloud-service-credential": serviceCredential,
      "x-tinycloud-owner-did": ownerDid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tinycloud_kv_get", arguments: { space: "applications", key: "xyz.tinycloud.tinychat/connectors/test/transcript/1", representation: "text" } },
    }),
  }));
  expect(noGrant.status).toBe(401);
  expect(await noGrant.json()).toEqual({ error: "native_grant_required" });

  const missingOwner = await app.fetch(request("/mcp", {
    method: "POST",
    headers: {
      "x-tinycloud-service-credential": serviceCredential,
      "content-type": "application/json",
    },
    body: "{}",
  }));
  expect(missingOwner.status).toBe(401);
  expect(await missingOwner.json()).toEqual({ error: "native_grant_required" });

  const missingServiceCredential = await app.fetch(request("/native/grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delegation: "invalid" }),
  }));
  expect(missingServiceCredential.status).toBe(403);
  expect(await missingServiceCredential.json()).toEqual({ error: "native_service_unauthorized" });

  const invalidGrant = await app.fetch(request("/native/grant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tinycloud-service-credential": serviceCredential,
    },
    body: JSON.stringify({ delegation: "not-a-portable-delegation" }),
  }));
  expect(invalidGrant.status).toBe(401);
  expect(await invalidGrant.json()).toEqual({ error: "native_grant_rejected" });
});
test("retries native service identity after a transient state-directory failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tinycloud-native-retry-"));
  directories.push(parent);
  const stateDir = join(parent, "state");
  await writeFile(stateDir, "temporary blocker");
  const app = await testApp(stateDir, {
    nativeServiceCredential: "native-retry-test-credential-with-enough-entropy",
  });

  const unavailable = await app.fetch(request("/.well-known/mcp/server-card.json"));
  expect((await unavailable.json() as Record<string, unknown>)["x-tinycloud-native-auth"]).toBeUndefined();

  await rm(stateDir, { force: true });
  await mkdir(stateDir);
  const recovered = await app.fetch(request("/.well-known/mcp/server-card.json"));
  expect((await recovered.json() as Record<string, unknown>)["x-tinycloud-native-auth"])
    .toMatchObject({ serviceDidField: "x-tinycloud-native-auth.serviceDid" });
});


test("binds native tool calls to the owner in the activated grant", async () => {
  const fixture = await createHermeticEncryptedNode({ ownerConnectorCapabilities: true });
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-native-integration-"));
  directories.push(stateDir);
  try {
    const serviceCredential = "native-integration-test-credential-with-enough-entropy";
    const store = new RemoteTenantStore({
      stateDir,
      stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
      publicUrl: new URL("https://mcp.test/mcp"),
      nodeHost: fixture.host,
      openkeyHost: "https://openkey.test",
      approvalTtlSeconds: 300,
      delegationExpiry: "1h",
    });
    const serviceIdentity = await store.nativeServiceIdentity();
    const key = "xyz.tinycloud.tinychat/connectors/source/transcript/record-1";
    fixture.configureKv(fixture.applicationsSpaceId, { [key]: { value: "owner transcript" } });

    const permissions = [
      {
        service: "tinycloud.sql",
        space: fixture.applicationsSpaceId,
        path: "xyz.tinycloud.tinychat/connectors",
        actions: ["tinycloud.sql/read"],
      },
      {
        service: "tinycloud.kv",
        space: fixture.applicationsSpaceId,
        path: "xyz.tinycloud.tinychat/connectors/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      },
    ];
    const olderDelegation = await fixture.mintDelegationForAudienceWithPermissions(
      serviceIdentity.serviceDid,
      permissions,
      { expiry: "1h" },
    );
    const delegation = await fixture.mintDelegationForAudienceWithPermissions(
      serviceIdentity.serviceDid,
      permissions,
      { expiry: "2h" },
    );
    const app = await testApp(stateDir, {
      nativeServiceCredential: serviceCredential,
      nodeHost: fixture.host,
    });
    const serviceCardResponse = await app.fetch(request("/.well-known/mcp/server-card.json"));
    const serviceCard = await serviceCardResponse.json() as Record<string, unknown>;
    expect((serviceCard["x-tinycloud-native-auth"] as { serviceDid: string }).serviceDid)
      .toBe(serviceIdentity.serviceDid);
    const grantResponse = await app.fetch(request("/native/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tinycloud-service-credential": serviceCredential,
      },
      body: JSON.stringify({ delegation: serializeDelegation(delegation) }),
    }));
    expect(grantResponse.status).toBe(201);
    expect(await grantResponse.json()).toMatchObject({
      ownerDid: fixture.ownerDid.toLowerCase(),
      serviceDid: serviceIdentity.serviceDid,
    });
    const nativeGrantPath = join(store.nativeTenantStateRoot(fixture.ownerDid), ".tinycloud", "native-grant.json");
    await writeFile(nativeGrantPath, JSON.stringify({ version: 1, ownerDid: "invalid" }));
    const repairedGrant = await app.fetch(request("/native/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tinycloud-service-credential": serviceCredential,
      },
      body: JSON.stringify({ delegation: serializeDelegation(delegation) }),
    }));
    expect(repairedGrant.status).toBe(201);
    await writeFile(nativeGrantPath, "{malformed");
    const repairedCorruptJson = await app.fetch(request("/native/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tinycloud-service-credential": serviceCredential,
      },
      body: JSON.stringify({ delegation: serializeDelegation(delegation) }),
    }));
    expect(repairedCorruptJson.status).toBe(201);


    const staleGrant = await app.fetch(request("/native/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tinycloud-service-credential": serviceCredential,
      },
      body: JSON.stringify({ delegation: serializeDelegation(olderDelegation) }),
    }));
    expect(staleGrant.status).toBe(401);
    expect(await staleGrant.json()).toEqual({ error: "native_grant_rejected" });

    const nativeHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-tinycloud-service-credential": serviceCredential,
      "x-tinycloud-owner-did": fixture.ownerDid,
    };
    const tools = await app.fetch(request("/mcp", {
      method: "POST",
      headers: nativeHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(tools.status).toBe(200);
    const toolList = await readMcpJson(tools) as { result?: { tools?: { name: string }[] } };
    expect(toolList.result?.tools?.map(({ name }) => name).sort()).toEqual([
      "tinycloud_kv_get",
      "tinycloud_read",
      "tinycloud_sql_query",
    ]);

    const read = await app.fetch(request("/mcp", {
      method: "POST",
      headers: nativeHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tinycloud_kv_get", arguments: { space: "applications", key, representation: "text" } },
      }),
    }));
    const readResult = await readMcpJson(read) as { result?: { content?: { text?: string }[] } };
    expect(readResult.result?.content?.some(({ text }) => text?.includes("owner transcript"))).toBe(true);
    expect(fixture.invocations()).toContainEqual(expect.objectContaining({
      service: "kv",
      action: "tinycloud.kv/get",
      path: key,
    }));

    const pageResponse = await app.fetch(request("/mcp", {
      method: "POST",
      headers: nativeHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "tinycloud_read", arguments: {
          resource: { kind: "kv", space: "applications", key }, pageBytes: 8,
        } },
      }),
    }));
    expect(await readMcpJson(pageResponse)).toMatchObject({
      result: { structuredContent: {
        status: "ok", output: { value: '{"value"', range: { start: 0, end: 8 }, complete: false },
      } },
    });

    const otherOwner = await app.fetch(request("/mcp", {
      method: "POST",
      headers: { ...nativeHeaders, "x-tinycloud-owner-did": "did:pkh:eip155:1:0x2222222222222222222222222222222222222222" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    }));
    expect(otherOwner.status).toBe(401);
    expect(await otherOwner.json()).toEqual({ error: "native_grant_required" });
    const grantPath = join(store.nativeTenantStateRoot(fixture.ownerDid), ".tinycloud", "native-grant.json");
    const storedGrant = JSON.parse(await readFile(grantPath, "utf8")) as Record<string, unknown>;
    storedGrant.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(grantPath, JSON.stringify(storedGrant), { mode: 0o600 });
    const expiredGrant = await app.fetch(request("/mcp", {
      method: "POST",
      headers: nativeHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    }));
    expect(expiredGrant.status).toBe(401);
    expect(await expiredGrant.json()).toEqual({ error: "native_grant_expired" });
  } finally {
    fixture.stop();
  }
});
test("serves the checker-required AI Catalog manifest and discovery links", async () => {
  const app = await testApp();
  const catalog = await app.fetch(request("/.well-known/ai-catalog.json", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/.well-known/ai-catalog.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("content-type")).toContain("application/json");
  expect(catalog.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  expect(await catalog.json()).toEqual({
    specVersion: "1.0",
    host: {
      displayName: "TinyCloud, Inc.",
      identifier: "https://mcp.tinycloud.xyz",
      documentationUrl: "https://docs.tinycloud.xyz/cli/mcp",
    },
    entries: [{
      identifier: "urn:air:tinycloud.xyz:mcp:tinycloud-mcp",
      displayName: "TinyCloud MCP",
      type: "application/json",
      description: "Hosted Streamable HTTP MCP server for delegated TinyCloud operations.",
      url: "https://mcp.test/.well-known/mcp/server-card.json",
      representativeQueries: [
        "How do I connect to TinyCloud's hosted MCP server?",
        "Which endpoint provides TinyCloud's delegated MCP operations?",
        "How can I connect to TinyCloud MCP using local stdio?",
      ],
    }],
  });
});

test("serves a truthful website-only Personal Agent Protocol document", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/.well-known/poppy.json", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/.well-known/poppy.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
    },
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(await response.json()).toEqual({
    protocol_version: "0.1",
    organization: {
      name: "TinyCloud, Inc.",
      domain: "mcp.test",
    },
    web: {},
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
});

test("publishes truthful OAuth discovery in auth.md without an agent enrollment endpoint", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/auth.md", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/auth.md", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  const authDoc = await response.text();
  expect(authDoc).toContain("# TinyCloud MCP auth.md");
  expect(authDoc).toContain("https://mcp.test/.well-known/oauth-protected-resource");
  expect(authDoc).toContain("https://openkey.test/.well-known/oauth-authorization-server/api/auth");
  expect(authDoc).toContain("Authorization: Bearer");
  expect(authDoc).toContain("No `agent_auth` registration block is published");
  expect(authDoc).not.toContain("register_uri:");
  expect(authDoc).not.toContain("/chatgpt/mcp");
  expect(authDoc).not.toContain("Details: TC-1362");
});

test("challenges unauthenticated MCP requests with resource metadata", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/mcp", { method: "POST" }));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
  );
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

for (const prefix of ["chatgpt", "claude", "grok", "muse"]) {
  test(`/${prefix}/mcp discovery and challenges bind its own resource audience`, async () => {
    const app = await testApp();
    const metadata = await app.fetch(request(`/.well-known/oauth-protected-resource/${prefix}/mcp`));
    expect(metadata.status).toBe(200);
    const metadataDocument = await metadata.json() as Record<string, unknown>;
    expect(metadataDocument).toMatchObject({
      resource: `https://mcp.test/${prefix}/mcp`,
      authorization_servers: ["https://openkey.test/api/auth"],
      scopes_supported: ["tinycloud:mcp"],
    });
    expect(metadataDocument.bearer_methods_supported).toBeUndefined();
    const unauthenticated = await app.fetch(request(`/${prefix}/mcp`, { method: "POST" }));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/${prefix}/mcp"`,
    );
  });
}

test("an address no assistant was given is not a resource", async () => {
  const app = await testApp();
  for (const path of ["/gemini/mcp", "/.well-known/oauth-protected-resource/gemini/mcp", "/claude", "/claude/mcp/extra"]) {
    expect((await app.fetch(request(path, { method: path.endsWith("/mcp") ? "POST" : "GET" }))).status, path).toBe(404);
  }
  // Approval results are collected from OpenKey; no address receives them.
  for (const prefix of ["", "/chatgpt", "/claude", "/grok", "/muse"]) {
    const path = `${prefix}/connect/callback`;
    expect((await app.fetch(request(path, { method: "POST", body: "{}" }))).status, path).toBe(404);
  }
});

test("invalid browser approvals return an inert page without reflecting state", async () => {
  const app = await testApp();
  const response = await app.fetch(request(`/chatgpt/connect?state=${encodeURIComponent(`<script>${CANARY}</script>`)}`, {
    headers: { accept: "text/html" },
  }));
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).not.toContain(CANARY);
  const machine = await app.fetch(request("/chatgpt/connect", { headers: { accept: "application/json" } }));
  expect(machine.status).toBe(400);
  expect(machine.headers.get("content-type")).toContain("application/json");
});

test("approval GET refusals log reason codes and pathnames without approval state", async () => {
  fakeOpenKey();
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  const store = siblingStore(stateDir);
  const stateFor = async (subject: string, ttlStore = store) =>
    new URL((await ttlStore.connectStatus(subject, [await ownerDid(REQUESTER_KEY)])).approvalUrl!).searchParams.get("state")!;
  const valid = await stateFor("approval-get-valid");
  const expired = await stateFor("approval-get-expired", siblingStore(stateDir, 0));
  const used = await stateFor("approval-get-used");
  await rm(join(store.tenantStateRoot("approval-get-used"), ".tinycloud/profiles/agent/pending", `${used.split(".")[1]}.json`));
  const orphaned = await stateFor("approval-get-orphaned");
  await rm(join(store.tenantStateRoot("approval-get-orphaned"), ".tinycloud/profiles/agent/key.json"));
  const corrupt = await stateFor("approval-get-corrupt");
  await writeFile(
    join(store.tenantStateRoot("approval-get-corrupt"), ".tinycloud/profiles/agent/pending", `${corrupt.split(".")[1]}.json`),
    `{"untrusted":"${CANARY}"`,
  );
  const [tenantId, nonce] = valid.split(".");
  const cases = [
    { path: "/connect", state: undefined, reason: "state_missing" },
    { path: "/connect", state: CANARY, reason: "state_invalid" },
    { path: "/connect", state: `${tenantId}.${nonce}.${CANARY}`, reason: "state_invalid" },
    { path: "/connect", state: `${CANARY}.${"a".repeat(512)}`, reason: "state_invalid" },
    { path: "/connect", state: expired, reason: "state_expired" },
    { path: "/connect", state: used, reason: "state_not_pending" },
    { path: "/connect", state: orphaned, reason: "tenant_missing" },
    { path: "/connect", state: corrupt, reason: "unknown" },
    { path: "/chatgpt/connect", state: CANARY, reason: "state_invalid" },
  ];
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const responses: string[] = [];
  try {
    const accepted = await app.fetch(request(`/connect?state=${encodeURIComponent(valid)}`));
    expect(accepted.status).toBe(302);
    for (const { path, state } of cases) {
      const query = state === undefined ? "" : `?state=${encodeURIComponent(state)}&extra=${CANARY}`;
      const response = await app.fetch(request(`${path}${query}`, { headers: { accept: "text/html" } }));
      expect(response.status).toBe(400);
      responses.push(await response.text());
    }
    const machine = await app.fetch(request("/chatgpt/connect", { headers: { accept: "application/json" } }));
    expect(machine.status).toBe(400);
  } finally {
    stderr.mockRestore();
  }
  expect(diagnostics).toEqual([
    ...cases.map(({ path, reason }) => `[tinycloud-mcp-http] connect rejected: reason=${reason} path=${path}\n`),
    "[tinycloud-mcp-http] connect rejected: reason=state_missing path=/chatgpt/connect\n",
  ]);
  for (const response of responses) expect(response).toBe(responses[0]!);
  for (const text of [...responses, ...diagnostics]) {
    expect(text).not.toContain(CANARY);
    for (const state of [valid, expired, used, orphaned, corrupt]) {
      expect(text).not.toContain(state);
      for (const part of state.split(".")) expect(text).not.toContain(part);
    }
  }
});

test("a refused approval names its stage and code without echoing the approval", async () => {
  const openkey = fakeOpenKey();
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  const store = siblingStore(stateDir);
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = encodeURIComponent(new URL(status.approvalUrl!).searchParams.get("state")!);
  const signed = await openKeyDelegation({
    tenantStateRoot: store.tenantStateRoot("openkey-user-a"),
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: { kv: { "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
  });
  const header = signed.delegationHeader;
  const authorization = typeof header === "object" && header !== null && "Authorization" in header
    ? String(header.Authorization)
    : "";
  expect(authorization).not.toBe("");
  const signature = String(signed.signature);
  const tampered = {
    ...signed,
    signature: `${signature.slice(0, -2)}${signature.endsWith("00") ? "11" : "00"}`,
    token: `eyJ.${CANARY}.jwt`,
    note: CANARY,
  };
  const incomplete: Record<string, unknown> = { ...signed, token: CANARY };
  delete incomplete.signature;
  const secrets = [CANARY, authorization, signature, String(signed.siwe), status.sessionDid];

  const outcomes: unknown[] = [];
  // Each refusal leaves the same link usable: the next visit asks OpenKey again.
  for (const delegation of [tampered, incomplete, `{"token":"${CANARY}"`]) {
    const opened = await app.fetch(request(`/connect?state=${state}`));
    expect(opened.status).toBe(302);
    const { id } = await openkey.approve(opened.headers.get("location")!, delegation, { ownerDid: requester });
    outcomes.push(await openkey.delivery(id));
    await expect(access(join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/session.json")))
      .rejects.toThrow();
    expect(openkey.acknowledged(id)).toBe(false);
    expect(openkey.fetches(id)).toBe(1);
  }

  expect(outcomes).toEqual([
    { status: "rejected", stage: "restore_approval", code: "AUTH_EXPIRED", detail: "none" },
    { status: "rejected", stage: "restore_approval", code: "CALLBACK_INCOMPLETE", detail: "none" },
    { status: "rejected", stage: "collect", code: "RESULT_INVALID" },
  ]);
  expect(openkey.diagnostics.filter((line) => line.includes("approval result rejected:"))).toEqual([
    "[tinycloud-mcp-http] approval result rejected: stage=restore_approval code=AUTH_EXPIRED detail=none",
    "[tinycloud-mcp-http] approval result rejected: stage=restore_approval code=CALLBACK_INCOMPLETE detail=none",
    "[tinycloud-mcp-http] approval result rejected: stage=collect code=RESULT_INVALID",
  ]);
  const connected = JSON.stringify(await store.connectStatus("openkey-user-a", [requester]));
  for (const secret of secrets.slice(0, -1)) expect(connected).not.toContain(secret);
  for (const secret of secrets) expect(openkey.diagnostics.join("\n")).not.toContain(secret);
}, 20_000);

test("an approval link OpenKey cannot open says so and opens on a later visit", async () => {
  const openkey = fakeOpenKey();
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  const status = await siblingStore(stateDir).connectStatus("openkey-user-a", [await ownerDid(REQUESTER_KEY)]);
  const state = encodeURIComponent(new URL(status.approvalUrl!).searchParams.get("state")!);
  openkey.linksStatus = 503;
  const page = await app.fetch(request(`/connect?state=${state}`, { headers: { accept: "text/html" } }));
  expect(page.status).toBe(503);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(await page.text()).toContain("The approval page could not be opened");
  const machine = await app.fetch(request(`/connect?state=${state}`, { headers: { accept: "application/json" } }));
  expect(machine.status).toBe(503);
  expect(openkey.diagnostics).toContain("[tinycloud-mcp-http] connect rejected: reason=openkey_unavailable path=/connect");

  openkey.linksStatus = 201;
  const opened = await app.fetch(request(`/connect?state=${state}`));
  expect(opened.status).toBe(302);
  expect(new URL(opened.headers.get("location")!).origin).toBe("https://openkey.test");
});

test("pre-collection refusals log a distinct detail behind one uniform response", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  const store = siblingStore(stateDir);
  const stateFor = async (subject: string, ttlStore = store) =>
    new URL((await ttlStore.connectStatus(subject, [await ownerDid(REQUESTER_KEY)])).approvalUrl!).searchParams.get("state")!;
  const valid = await stateFor("openkey-user-a");
  const expired = await stateFor("openkey-user-expired", siblingStore(stateDir, 0));
  const used = await stateFor("openkey-user-used");
  await rm(join(store.tenantStateRoot("openkey-user-used"), ".tinycloud/profiles/agent/pending", `${used.split(".")[1]}.json`));
  const orphaned = await stateFor("openkey-user-orphaned");
  await rm(join(store.tenantStateRoot("openkey-user-orphaned"), ".tinycloud/profiles/agent/key.json"));
  // A reset state volume: the whole tenant directory, pending file included, is gone.
  const wiped = await stateFor("openkey-user-wiped");
  await rm(store.tenantStateRoot("openkey-user-wiped"), { recursive: true });
  const [tenantId, nonce] = valid.split(".");
  const cases: Array<{ state?: string; detail: string }> = [
    { detail: "state_missing" },
    { state: `${tenantId}.${nonce}.${CANARY}`, detail: "state_invalid" },
    { state: `${CANARY}.${"a".repeat(512)}`, detail: "state_invalid" },
    { state: expired, detail: "state_expired" },
    // The first attempt deleted the expired pending file, so a retry is not proof of replay.
    { state: expired, detail: "state_not_pending" },
    { state: used, detail: "state_not_pending" },
    { state: orphaned, detail: "tenant_missing" },
    { state: wiped, detail: "tenant_missing" },
  ];

  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const responses: string[] = [];
  try {
    for (const { state } of cases) {
      const query = state === undefined ? `?token=${CANARY}` : `?state=${encodeURIComponent(state)}&token=${CANARY}`;
      const response = await app.fetch(request(`/connect${query}`, { headers: { accept: "application/json" } }));
      expect(response.status).toBe(400);
      responses.push(await response.text());
    }
  } finally {
    stderr.mockRestore();
  }

  expect(responses).toEqual(cases.map(() => JSON.stringify({ error: "The approval link is invalid or expired." })));
  expect(diagnostics).toEqual(cases.map(({ detail }) =>
    `[tinycloud-mcp-http] connect rejected: reason=${detail} path=/connect\n`));
  for (const text of [...responses, ...diagnostics]) {
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(nonce!);
  }
});

test("a refused approval logs only allowlisted rejection reasons and well-formed codes", () => {
  const refusals = [
    new ApprovalStageError("activation", "DELEGATION_REJECTED", "activation_unauthenticated", new Error(CANARY)),
    new ApprovalStageError("activation", "DELEGATION_REJECTED", `node said ${CANARY}`),
    new ApprovalStageError("auth_import", `${CANARY} INTERNAL`),
  ];
  const diagnostics = refusals.map(approvalRefusalDiagnostic);

  expect(diagnostics).toEqual([
    "approval result rejected: stage=activation code=DELEGATION_REJECTED reason=activation_unauthenticated detail=none",
    "approval result rejected: stage=activation code=DELEGATION_REJECTED reason=unknown detail=none",
    "approval result rejected: stage=auth_import code=UNKNOWN detail=none",
  ]);
  expect(diagnostics.join("")).not.toContain(CANARY);
});

/** A fake OpenKey for this test, removed when it ends. */
function fakeOpenKey(): FakeOpenKey {
  const openkey = installFakeOpenKey();
  openkeys.push(openkey);
  return openkey;
}

/** A second store over the hosted app's state mints the approval links the app reads. */
function siblingStore(stateDir: string, approvalTtlSeconds = 300): RemoteTenantStore {
  return new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    openkeyApiHost: OPENKEY_API_ORIGIN,
    linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds,
    delegationExpiry: "1h",
  });
}

async function testApp(
  existingStateDir?: string,
  options: { nativeServiceCredential?: string; nodeHost?: string } = {},
): Promise<HostedMcpApp> {
  const stateDir = existingStateDir ?? await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  directories.push(stateDir);
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: options.nodeHost ?? "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    openkeyApiHost: OPENKEY_API_ORIGIN,
    linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    ...(options.nativeServiceCredential === undefined
      ? {}
      : { nativeServiceCredential: options.nativeServiceCredential }),
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: "https://openkey.test/api/auth/jwks",
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  apps.push(app);
  return app;
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("host", "mcp.test");
  return new Request(`https://mcp.test${path}`, { ...init, headers });
}
async function readMcpJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    if (data === undefined) throw new Error(`MCP response did not contain JSON data: ${text}`);
    return JSON.parse(data.slice("data:".length).trim());
  }
}
