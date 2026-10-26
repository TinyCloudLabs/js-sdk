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
  RemoteTenantStore,
  type RemoteStoreConfig,
} from "./remote-store.js";
import { MCP_SERVER_NAME } from "./server.js";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

const REQUIRED_SCOPE = "tinycloud:mcp";

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
  const resourceUrl = canonicalResourceUrl(config.publicUrl);
  const pluginUrl = new URL("./chatgpt/mcp", resourceUrl);
  const statusFor = (resource: URL): TokenStatusChecker | undefined =>
    config.introspection === undefined
      ? undefined
      : createTokenStatusChecker({ ...config.introspection, resourceUrl: resource.toString() });
  const hosted = createHostedSurface(config, resourceUrl, "hosted", statusFor(resourceUrl));
  const plugin = createHostedSurface({
    ...config,
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
    const identity = oauthIdentity(authInfo);
    const { subject, ownerDids } = identity;
    const stateRoot = await store.initializeTenant(subject);
    const validator = createJsonSchemaValidator();
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_VERSION },
      {
        jsonSchemaValidator: validator,
        instructions: surface === "public"
          ? "Use TinyCloud only for the user's requested task. Call tinycloud_connect first. If an operation returns authority_required, present approval.url and wait for the user's approval before retrying. If approval is declined, stop that operation. For personal records, call tinycloud_apps_context first. Never request or store passwords, API keys, authentication codes, government identifiers, payment-card data, or protected health information."
          : "Call tinycloud_connect first. If an operation returns authority_required, open approval.url, then retry that operation unchanged. For personal records such as weight, workouts, goals or todos, call tinycloud_apps_context first.",
      },
    );
    registerTinyCloudTools(server, {
      surface,
      profile: "agent",
      explicitProfile: true,
      allowOwnerProfile: false,
      stateRoot,
      beforeOperation: () => store.validateTenant(subject, ownerDids),
      transformOperationResult: (result, invocation) =>
        store.decorateAuthorityResult(subject, ownerDids, result, invocation),
    }, validator);
    registerConnectTool(server, validator, store, identity, surface);
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
      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata !== undefined) return metadata;
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return request.method === "GET"
          ? json({ ok: true })
          : methodNotAllowed("GET");
      }
      const hostFailure = hostHeaderValidationResponse(request, allowedHosts);
      if (hostFailure !== undefined) return hostFailure;

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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow } });
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`[tinycloud-mcp-http] ${message}\n`);
}
