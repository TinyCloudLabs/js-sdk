import { join } from "node:path";

import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { RUNTIME_DELEGATION_REJECTIONS } from "@tinycloud/node-sdk";

import { createOpenKeyTokenVerifier } from "./oauth.js";
import { createTokenStatusChecker, type TokenStatusChecker, type TokenStatusConfig } from "./token-status.js";
import { logToolCall } from "./logging.js";
import {
  ApprovalOwnerMismatchError,
  ApprovalRequestError,
  ApprovalStageError,
  NativeGrantValidationError,
  RemoteTenantStore,
  type RemoteStoreConfig,
} from "./remote-store.js";
import {
  MAX_NATIVE_GRANT_BODY_BYTES,
  NATIVE_GRANT_EXPIRED,
  NATIVE_GRANT_MAX_LIFETIME_SECONDS,
  NATIVE_GRANT_REJECTED,
  NATIVE_GRANT_REQUIRED,
  NATIVE_GRANT_VALIDATION_UNAVAILABLE,
  NATIVE_OWNER_DID_HEADER,
  NATIVE_SERVICE_UNAUTHORIZED,
  NATIVE_SERVICE_UNAVAILABLE,
  NATIVE_SERVICE_CREDENTIAL_HEADER,
  serviceCredentialMatches,
} from "./native-auth.js";
import { MCP_SERVER_NAME } from "./server.js";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";
import type { McpOperationInvocation } from "./tools.js";
import { MCP_VERSION } from "./version.js";

const REQUIRED_SCOPE = "tinycloud:mcp";
const LOCAL_CLI_PACKAGE = ["@tinycloud", "cli"].join("/");
const LOCAL_MCP_PACKAGE = ["@tinycloud", "mcp"].join("/");

export interface HostedMcpConfig extends RemoteStoreConfig {
  readonly oauthMetadata: OAuthMetadata;
  readonly allowedOrigins?: readonly string[];
  /**
   * OpenKey token introspection client (`TC_MCP_INTROSPECTION_URL` and client
   * credentials). The hosted server always sets this; without it only the
   * signed token claims are checked.
   */
  readonly introspection?: Omit<TokenStatusConfig, "resourceUrl">;
}

export interface HostedMcpApp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

export function createHostedMcpApp(config: HostedMcpConfig): HostedMcpApp {
  if (config.nativeServiceCredential !== undefined &&
    Buffer.byteLength(config.nativeServiceCredential, "utf8") < 32) {
    throw new Error("TC_MCP_NATIVE_SERVICE_CREDENTIAL must contain at least 32 bytes.");
  }
  const resourceUrl = canonicalResourceUrl(config.publicUrl);
  const pluginUrl = new URL("./chatgpt/mcp", resourceUrl);
  const statusFor = (resource: URL): TokenStatusChecker | undefined =>
    config.introspection === undefined
      ? undefined
      : createTokenStatusChecker({ ...config.introspection, resourceUrl: resource.toString() });
  const hosted = createHostedSurface(config, resourceUrl, "hosted", statusFor(resourceUrl));
  const plugin = createHostedSurface({
    ...config,
    nativeServiceCredential: undefined,
    stateDir: join(config.stateDir, "chatgpt"),
    approvalPath: new URL("./connect", pluginUrl).pathname,
  }, pluginUrl, "public", statusFor(pluginUrl));
  const pluginPaths: Record<string, true> = {
    [pluginUrl.pathname]: true,
    [new URL("./connect", pluginUrl).pathname]: true,
    [new URL("./connect/callback", pluginUrl).pathname]: true,
    [new URL(getOAuthProtectedResourceMetadataUrl(pluginUrl)).pathname]: true,
  };
  return {
    fetch: (request) => (pluginPaths[new URL(request.url).pathname] === true ? plugin : hosted).fetch(request),
    close: async () => {
      await Promise.all([hosted.close(), plugin.close()]);
    },
  };
}

function createHostedSurface(
  config: HostedMcpConfig,
  resourceUrl: URL,
  surface: "hosted" | "public",
  tokenStatus: TokenStatusChecker | undefined,
): HostedMcpApp {
  const connectPath = config.approvalPath ?? "/connect";
  const callbackPath = `${connectPath}/callback`;
  const issuer = String(config.oauthMetadata.issuer);
  const jwksUri = String(config.oauthMetadata.jwks_uri);
  const verifier = createOpenKeyTokenVerifier({
    issuer,
    audience: resourceUrl.toString(),
    jwksUri,
    requiredScope: REQUIRED_SCOPE,
    ...(tokenStatus === undefined ? {} : { tokenStatus }),
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const authenticate = requireBearerAuth({
    verifier,
    requiredScopes: [REQUIRED_SCOPE],
    resourceMetadataUrl,
  });
  const store = new RemoteTenantStore({ ...config, publicUrl: resourceUrl });
  const handler = createMcpHandler(async ({ authInfo }) => {
    const nativeOwner = typeof authInfo?.extra?.nativeOwnerDid === "string"
      ? authInfo.extra.nativeOwnerDid
      : undefined;
    const identity = nativeOwner === undefined
      ? oauthIdentity(authInfo)
      : { subject: `native:${nativeOwner}`, ownerDids: [nativeOwner] };
    const { subject, ownerDids } = identity;
    const stateRoot = nativeOwner === undefined
      ? await store.initializeTenant(subject)
      : store.nativeTenantStateRoot(nativeOwner);
    const validator = createJsonSchemaValidator();
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_VERSION },
      {
        jsonSchemaValidator: validator,
        instructions: nativeOwner === undefined
          ? surface === "public"
            ? "Use TinyCloud only for the user's requested task. Call tinycloud_connect first. If an operation returns authority_required, present approval.url and wait for the user's approval before retrying. If approval is declined, stop that operation. For personal records, call tinycloud_apps_context first. Never request or store passwords, API keys, authentication codes, government identifiers, payment-card data, or protected health information."
            : "Call tinycloud_connect first. If an operation returns authority_required, open approval.url, then retry that operation unchanged. For personal records such as weight, workouts, goals or todos, call tinycloud_apps_context first."
          : "Use only the user's requested connector-transcript data. The signed TinyCloud grant authorizes read-only SQL and transcript KV reads.",
      },
    );
    registerTinyCloudTools(server, {
      surface,
      profile: "agent",
      explicitProfile: true,
      allowOwnerProfile: false,
      stateRoot,
      ...(nativeOwner === undefined ? {} : {
        allowedTools: ["tinycloud_sql_query", "tinycloud_kv_get"] as const,
      }),
      beforeOperation: nativeOwner === undefined
        ? () => store.validateTenant(subject, ownerDids)
        : () => store.assertNativeGrantActive(nativeOwner),
      ...(nativeOwner === undefined ? {
        transformOperationResult: (result: unknown, invocation: McpOperationInvocation) =>
          store.decorateAuthorityResult(subject, ownerDids, result, invocation),
      } : {}),
    }, validator);
    if (nativeOwner === undefined) registerConnectTool(server, validator, store, identity, surface);
    return server;
  }, {
    legacy: "stateless",
    onerror: () => writeDiagnostic("MCP request failed"),
  });

  const metadataOptions = {
    oauthMetadata: config.oauthMetadata,
    resourceServerUrl: resourceUrl,
    serviceDocumentationUrl: new URL("https://docs.tinycloud.xyz/cli/mcp"),
    scopesSupported: [REQUIRED_SCOPE],
    resourceName: surface === "public" ? "TinyCloud personal records" : "TinyCloud hosted MCP",
  };
  const allowedHosts = [resourceUrl.hostname];

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/healthz") {
        const hostFailure = hostHeaderValidationResponse(request, allowedHosts);
        if (hostFailure !== undefined) return hostFailure;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource" && surface === "hosted") {
        const metadataUrl = new URL(getOAuthProtectedResourceMetadataUrl(resourceUrl));
        const metadataRequest = new Request(metadataUrl.toString(), {
          method: request.method,
          headers: request.headers,
        });
        const response = oauthMetadataResponse(metadataRequest, metadataOptions);
        if (response !== undefined) return withBearerMethodsSupported(response);
      }
      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata !== undefined) {
        return surface === "hosted" ? withBearerMethodsSupported(metadata) : metadata;
      }
      if (url.pathname === "/.well-known/ai-catalog.json" && surface === "hosted") {
        if (request.method === "OPTIONS") {
          return publicMetadataCors(new Response(null, { status: 204 }), request);
        }
        if (request.method !== "GET") return methodNotAllowed("GET");
        return publicMetadataCors(Response.json({
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
            url: new URL("/.well-known/mcp/server-card.json", resourceUrl).toString(),
            representativeQueries: [
              "How do I connect to TinyCloud's hosted MCP server?",
              "Which endpoint provides TinyCloud's delegated MCP operations?",
              "How can I connect to TinyCloud MCP using local stdio?",
            ],
          }],
        }, {
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "application/json; charset=utf-8",
          },
        }), request);
      }

      if (url.pathname === "/.well-known/poppy.json" && surface === "hosted") {
        if (request.method === "OPTIONS") {
          return publicMetadataCors(new Response(null, { status: 204 }), request);
        }
        if (request.method !== "GET") return methodNotAllowed("GET");
        return publicMetadataCors(Response.json({
          protocol_version: "0.1",
          organization: {
            name: "TinyCloud, Inc.",
            domain: resourceUrl.hostname,
          },
          web: {},
        }, {
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "application/json; charset=utf-8",
          },
        }), request);
      }
      if (url.pathname === "/auth.md" && surface === "hosted") {
        if (request.method === "OPTIONS") {
          return publicMetadataCors(new Response(null, { status: 204 }), request);
        }
        if (request.method !== "GET") return methodNotAllowed("GET");
        const issuerUrl = new URL(issuer);
        const authorizationServerMetadataUrl = new URL(
          `/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
          issuerUrl.origin,
        );
        const registrationEndpoint = config.oauthMetadata.registration_endpoint;
        const registrationNote = typeof registrationEndpoint === "string"
          ? `OpenKey's OAuth \`registration_endpoint\` is ${registrationEndpoint}; it registers OAuth clients, not TinyCloud users or agents.`
          : "The authorization server does not advertise an OAuth client registration endpoint.";
        const authDoc = [
          "# TinyCloud MCP auth.md",
          "",
          `Protected resource: ${resourceUrl}.`,
          "",
          "Send an OAuth access token in the `Authorization: Bearer` header.",
          "",
          `Protected Resource Metadata: ${new URL("/.well-known/oauth-protected-resource", resourceUrl)}.`,
          `Authorization server issuer: ${issuer}.`,
          `Authorization server metadata: ${authorizationServerMetadataUrl}.`,
          `Scope: \`${REQUIRED_SCOPE}\`.`,
          "",
          "Hosted access uses OpenKey OAuth.",
          registrationNote,
          "TinyCloud does not host an Auth.md agent-enrollment or user-registration endpoint for this service.",
          "No `agent_auth` registration block is published because no agent-registration endpoint is available.",
          "",
          `Local stdio is a separate option configured with \`${LOCAL_CLI_PACKAGE}\` and \`${LOCAL_MCP_PACKAGE}\`.`,
          "",
          "Connection steps: https://docs.tinycloud.xyz/cli/mcp",
        ].join("\n") + "\n";
        return publicMetadataCors(publicText(authDoc, "text/markdown; charset=utf-8"), request);
      }
      if (url.pathname === "/robots.txt" && surface === "hosted") {
        return request.method === "GET"
          ? publicText(`User-agent: *\nAllow: /\nSitemap: ${new URL("/sitemap.xml", resourceUrl)}\nAgentmap: ${new URL("/.well-known/ai-catalog.json", resourceUrl)}\n`, "text/plain; charset=utf-8")
          : methodNotAllowed("GET");
      }
      if ((url.pathname === "/mcp/server-card" || url.pathname === "/.well-known/mcp/server-card.json") && surface === "hosted") {
        if (request.method === "OPTIONS") {
          return publicMetadataCors(new Response(null, { status: 204 }), request);
        }
        if (request.method !== "GET") return methodNotAllowed("GET");
        const identity = await store.nativeServiceIdentity();
        return publicMetadataCors(Response.json({
          $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
          name: `xyz.tinycloud/${MCP_SERVER_NAME}`,
          title: "TinyCloud MCP",
          version: MCP_VERSION,
          description: "MCP server for delegated TinyCloud operations.",
          websiteUrl: "https://docs.tinycloud.xyz/cli/mcp",
          repository: { source: "github", url: "https://github.com/TinyCloudLabs/js-sdk", subfolder: "packages/mcp" },
          remotes: [{ type: "streamable-http", url: resourceUrl.toString() }],
          "x-tinycloud-native-auth": {
            serviceDid: identity.serviceDid,
            serviceDidField: "x-tinycloud-native-auth.serviceDid",
            serviceIdentityStorage: "TC_MCP_STATE_DIR/.tinycloud/native-service-key.json",
            grantEndpoint: {
              method: "POST",
              path: "/native/grant",
              body: { delegation: "serialized PortableDelegation JSON string" },
            },
            serviceCredentialHeader: NATIVE_SERVICE_CREDENTIAL_HEADER,
            serviceCredentialEnv: "TC_MCP_NATIVE_SERVICE_CREDENTIAL",
            ownerDidHeader: NATIVE_OWNER_DID_HEADER,
            maxGrantLifetimeSeconds: NATIVE_GRANT_MAX_LIFETIME_SECONDS,
            acceptedCapabilities: [
              { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/connectors", actions: ["tinycloud.sql/read"] },
              { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tinychat/connectors/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
            ],
            tools: ["tinycloud_sql_query", "tinycloud_kv_get"],
            errors: {
              required: NATIVE_GRANT_REQUIRED,
              expired: NATIVE_GRANT_EXPIRED,
              rejected: NATIVE_GRANT_REJECTED,
              serviceUnauthorized: NATIVE_SERVICE_UNAUTHORIZED,
              serviceUnavailable: NATIVE_SERVICE_UNAVAILABLE,
              validationUnavailable: NATIVE_GRANT_VALIDATION_UNAVAILABLE,
            },
          },
        }, { headers: { "cache-control": "public, max-age=300" } }), request);
      }
      if (url.pathname === "/llms.txt" && surface === "hosted") {
        return request.method === "GET"
          ? publicText(`# TinyCloud MCP\n\nHosted Streamable HTTP endpoint: https://mcp.tinycloud.xyz/mcp (OpenKey OAuth).\n\nConnection documentation: https://docs.tinycloud.xyz/cli/mcp\n\nLocal alternative: install ${LOCAL_CLI_PACKAGE} and ${LOCAL_MCP_PACKAGE}, then set up tinycloud-mcp as a stdio server in your MCP client.\n`, "text/plain; charset=utf-8")
          : methodNotAllowed("GET");
      }
      if (url.pathname === "/sitemap.xml" && surface === "hosted") {
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${new URL("/", resourceUrl)}</loc></url></urlset>`;
        return request.method === "GET"
          ? publicText(sitemap, "application/xml; charset=utf-8")
          : methodNotAllowed("GET");
      }
      if (url.pathname === "/" && surface === "hosted") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
        const markdown = request.headers.get("accept")?.includes("text/markdown") ?? false;
        const content = markdown
          ? `# TinyCloud MCP\n\nHosted endpoint: <https://mcp.tinycloud.xyz/mcp> (Streamable HTTP, OpenKey OAuth).\n\n[Connection documentation](https://docs.tinycloud.xyz/cli/mcp).\n\nLocal alternative: install \`${LOCAL_CLI_PACKAGE}\` and \`${LOCAL_MCP_PACKAGE}\` and connect the \`tinycloud-mcp\` stdio server.\n`
          : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="ai-catalog" href="/.well-known/ai-catalog.json"><title>TinyCloud MCP</title></head><main><h1>TinyCloud MCP</h1><p>Hosted MCP endpoint: <code>https://mcp.tinycloud.xyz/mcp</code> (Streamable HTTP, OpenKey OAuth).</p><p><a href="https://docs.tinycloud.xyz/cli/mcp">Connection documentation</a></p><p>Local alternative: install <code>${LOCAL_CLI_PACKAGE}</code> and <code>${LOCAL_MCP_PACKAGE}</code> and connect the <code>tinycloud-mcp</code> stdio server.</p></main></html>`;
        const headers = new Headers({
          "content-type": markdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          vary: "Accept",
        });
        headers.set(
          "link",
          `<${new URL("/mcp/server-card", resourceUrl)}>; rel="describedby"; type="application/json", <https://docs.tinycloud.xyz/cli/mcp>; rel="service-doc"`,
        );
        return new Response(request.method === "HEAD" ? null : content, { headers });
      }
      if (url.pathname === "/healthz") {
        return request.method === "GET"
          ? json({ ok: true })
          : methodNotAllowed("GET");
      }
      if (url.pathname === connectPath) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        try {
          const destination = await store.approvalRedirect(requiredState(url));
          return Response.redirect(destination, 302);
        } catch {
          if (request.headers.get("accept")?.includes("text/html")) {
            return new Response(
              "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>TinyCloud approval unavailable</title><main><h1>This approval link is unavailable</h1><p>It may have expired or already been used. No new approval was accepted through this link.</p><p>Return to the conversation that requested access. In ChatGPT, select @TinyCloud and ask it to continue your original request. If access is still needed, it can provide a fresh approval link.</p><p>If you declined access, no further approval is required. Never paste passwords, codes or approval links into support messages.</p></main></html>",
              {
                status: 400,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-store",
                  "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                  "referrer-policy": "no-referrer",
                  "x-content-type-options": "nosniff",
                  vary: "Accept",
                },
              },
            );
          }
          return json({ error: "The approval link is invalid or expired." }, 400);
        }
      }
      if (url.pathname === callbackPath) {
        if (request.method === "OPTIONS") return callbackCors(new Response(null, { status: 204 }), config.openkeyHost);
        if (request.method !== "POST") return methodNotAllowed("POST");
        const originFailure = validateCallbackOrigin(request, config.openkeyHost);
        if (originFailure !== undefined) return callbackCors(originFailure, config.openkeyHost);
        try {
          await store.completeApproval(requiredState(url), request);
          return callbackCors(json({ success: true }), config.openkeyHost);
        } catch (error) {
          // Only fixed server-authored text reaches OpenKey; callback input is never echoed.
          if (error instanceof ApprovalOwnerMismatchError) {
            return callbackCors(json({ error: error.message, code: "approval_owner_mismatch" }, 403), config.openkeyHost);
          }
          // Stage, code, reason and detail are identifiers, never callback, delegation or node text.
          const stage = error instanceof ApprovalStageError ? error.stage : "unknown";
          const code = error instanceof ApprovalStageError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? error.code
            : "UNKNOWN";
          const reason = !(error instanceof ApprovalStageError) || error.reason === undefined
            ? undefined
            : RUNTIME_DELEGATION_REJECTIONS.find((known) => known === error.reason) ?? "unknown";
          // Only the server log says which state, tenant or body check failed;
          // the response stays uniform so a caller cannot probe a state.
          const detail = error instanceof ApprovalRequestError ? error.detail : "none";
          writeDiagnostic(
            `connect callback rejected: stage=${stage} code=${code}${reason === undefined ? "" : ` reason=${reason}`} detail=${detail}`,
          );
          return callbackCors(
            json({
              error: stage,
              code,
              ...(reason === undefined ? {} : { reason }),
              message: "TinyCloud could not accept this delegation.",
            }, 400),
            config.openkeyHost,
          );
        }
      }
      if (url.pathname === "/native/grant" && surface === "hosted") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        if (request.headers.has("origin")) return json({ error: NATIVE_SERVICE_UNAUTHORIZED }, 403);
        if (config.nativeServiceCredential === undefined) {
          return json({ error: NATIVE_SERVICE_UNAVAILABLE }, 503);
        }
        if (!serviceCredentialMatches(
          request.headers.get(NATIVE_SERVICE_CREDENTIAL_HEADER),
          config.nativeServiceCredential,
        )) return json({ error: NATIVE_SERVICE_UNAUTHORIZED }, 403);
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          return json({ error: NATIVE_GRANT_REJECTED }, 401);
        }
        const bodyText = await readBoundedBodyText(request, MAX_NATIVE_GRANT_BODY_BYTES);
        if (bodyText === undefined) return json({ error: NATIVE_GRANT_REJECTED }, 401);
        let body: unknown;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return json({ error: NATIVE_GRANT_REJECTED }, 401);
        }
        if (typeof body !== "object" || body === null || Array.isArray(body) || !("delegation" in body)) {
          return json({ error: NATIVE_GRANT_REJECTED }, 401);
        }
        const grantBody = body as { delegation?: unknown };
        if (Object.keys(body).length !== 1 || typeof grantBody.delegation !== "string") {
          return json({ error: NATIVE_GRANT_REJECTED }, 401);
        }
        try {
          const accepted = await store.acceptNativeGrant(grantBody.delegation);
          return json({
            ownerDid: accepted.ownerDid,
            serviceDid: accepted.serviceDid,
            expiresAt: accepted.expiresAt,
          }, 201);
        } catch (error) {
          return nativeGrantErrorResponse(error);
        }
      }
      if (url.pathname === resourceUrl.pathname && surface === "hosted" &&
        (request.headers.has(NATIVE_SERVICE_CREDENTIAL_HEADER) || request.headers.has(NATIVE_OWNER_DID_HEADER))) {
        if (config.nativeServiceCredential === undefined) {
          return json({ error: NATIVE_SERVICE_UNAVAILABLE }, 503);
        }
        if (!serviceCredentialMatches(
          request.headers.get(NATIVE_SERVICE_CREDENTIAL_HEADER),
          config.nativeServiceCredential,
        )) return json({ error: NATIVE_SERVICE_UNAUTHORIZED }, 403);
        if (request.headers.has("origin")) return json({ error: NATIVE_SERVICE_UNAUTHORIZED }, 403);
        const ownerHeader = request.headers.get(NATIVE_OWNER_DID_HEADER);
        if (ownerHeader === null || ownerHeader.length === 0) {
          return json({ error: NATIVE_GRANT_REQUIRED }, 401);
        }
        const grant = await store.nativeGrantForOwner(ownerHeader);
        if (grant.status !== "ok") {
          const status = grant.status === "unavailable" ? 503 : 401;
          const code = grant.status === "required"
            ? NATIVE_GRANT_REQUIRED
            : grant.status === "expired"
              ? NATIVE_GRANT_EXPIRED
              : grant.status === "unavailable"
                ? NATIVE_GRANT_VALIDATION_UNAVAILABLE
                : NATIVE_GRANT_REJECTED;
          return json({ error: code }, status);
        }
        return handler.fetch(request, {
          authInfo: {
            token: "native-service",
            clientId: "tinycloud-native",
            scopes: [],
            extra: { nativeOwnerDid: grant.ownerDid },
          } as AuthInfo,
        });
      }
      if (url.pathname !== resourceUrl.pathname) return json({ error: "Not found" }, 404);
      const originFailure = validateOrigin(request, config.allowedOrigins);
      if (originFailure !== undefined) return originFailure;
      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      return handler.fetch(request, { authInfo: auth });
    },
    close: () => handler.close(),
  };
}

function registerConnectTool(
  server: McpServer,
  validator: ReturnType<typeof createJsonSchemaValidator>,
  store: RemoteTenantStore,
  identity: OAuthIdentity,
  surface: "hosted" | "public",
): void {
  const inputSchema = fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator);
  const outputSchema = fromJsonSchema({
    type: "object",
    properties: {
      connected: { type: "boolean" },
      ...(surface === "hosted" ? { sessionDid: { type: "string" } } : {}),
      approvalUrl: { type: "string", format: "uri" },
      expiresAt: { type: "string", format: "date-time" },
    },
    required: surface === "hosted" ? ["connected", "sessionDid"] : ["connected"],
    additionalProperties: false,
  }, validator);
  server.registerTool(
    "tinycloud_connect",
    {
      title: "Connect TinyCloud",
      description: "Check the hosted delegate connection and return a one-time OpenKey approval URL when setup is required.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const startedAt = performance.now();
      let code = "INTERNAL_ERROR";
      let text: string;
      try {
        const status = await store.connectStatus(identity.subject, identity.ownerDids);
        if (status.connected) {
          code = "ok";
          text = "TinyCloud is connected.";
        } else if (status.approvalUrl === undefined) {
          code = "unavailable";
          text = "TinyCloud is unavailable. Call this tool again shortly.";
        } else {
          code = "authority_required";
          text = `TinyCloud approval is required. Open ${status.approvalUrl}, then call this tool again. This link expires at ${status.expiresAt}.`;
        }
        const visibleStatus = surface === "hosted" ? status : {
          connected: status.connected,
          ...(status.approvalUrl === undefined ? {} : { approvalUrl: status.approvalUrl }),
          ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
        };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: visibleStatus,
        };
      } finally {
        logToolCall("tinycloud_connect", code, startedAt, 0);
      }
    },
  );
}

interface OAuthIdentity {
  readonly subject: string;
  readonly ownerDids: string[];
}

function oauthIdentity(authInfo: AuthInfo | undefined): OAuthIdentity {
  const subject = authInfo?.extra?.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("The authenticated MCP request has no OpenKey subject.");
  }
  const ownerDids = authInfo?.extra?.ownerDids;
  if (!Array.isArray(ownerDids) || ownerDids.length === 0 ||
    !ownerDids.every((did) => typeof did === "string")) {
    throw new Error("The authenticated MCP request has no OpenKey owner identity.");
  }
  return { subject, ownerDids };
}

function canonicalResourceUrl(url: URL): URL {
  const resource = new URL(url);
  resource.hash = "";
  resource.search = "";
  resource.pathname = resource.pathname.replace(/\/+$/, "") || "/mcp";
  if (resource.pathname === "/") resource.pathname = "/mcp";
  return resource;
}

function requiredState(url: URL): string {
  const state = url.searchParams.get("state");
  if (state === null) throw new ApprovalRequestError("state_missing", "Missing approval state.");
  if (state.length > 512) throw new ApprovalRequestError("state_invalid", "Approval state is invalid.");
  return state;
}

function validateOrigin(request: Request, allowed: readonly string[] | undefined): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin === null) return undefined;
  const allowlist = allowed ?? [];
  return allowlist.includes(origin) ? undefined : json({ error: "Origin is not allowed." }, 403);
}

function validateCallbackOrigin(request: Request, openkeyHost: string): Response | undefined {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(openkeyHost).origin
    ? undefined
    : json({ error: "Origin is not allowed." }, 403);
}

function callbackCors(response: Response, openkeyHost: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", new URL(openkeyHost).origin);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function readBoundedBodyText(request: Request, maxBytes: number): Promise<string | undefined> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) return undefined;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function nativeGrantErrorResponse(error: unknown): Response {
  if (!(error instanceof NativeGrantValidationError)) {
    return json({ error: NATIVE_GRANT_REJECTED }, 401);
  }
  return json(
    { error: error.code },
    error.code === NATIVE_GRANT_VALIDATION_UNAVAILABLE ? 503 : 401,
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}


async function withBearerMethodsSupported(response: Response): Promise<Response> {
  if (response.status === 204 || response.body === null) return response;
  const metadata = await response.json() as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify({ ...metadata, bearer_methods_supported: ["header"] }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function publicMetadataCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  const requestedHeaders = request.method === "OPTIONS"
    ? request.headers.get("access-control-request-headers")
    : null;
  if (requestedHeaders !== null) {
    headers.set("access-control-allow-headers", requestedHeaders);
  }
  headers.set(
    "vary",
    requestedHeaders === null ? "Origin" : "Origin, Access-Control-Request-Headers",
  );
  return new Response(response.body, { status: response.status, headers });
}

function publicText(text: string, contentType: string): Response {
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow } });
}


function writeDiagnostic(message: string): void {
  process.stderr.write(`[tinycloud-mcp-http] ${message}\n`);
}
