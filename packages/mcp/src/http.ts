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

import { createOpenKeyTokenVerifier } from "./oauth.js";
import { RemoteTenantStore, type RemoteStoreConfig } from "./remote-store.js";
import { MCP_SERVER_NAME } from "./server.js";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

const REQUIRED_SCOPE = "tinycloud:mcp";

export interface HostedMcpConfig extends RemoteStoreConfig {
  readonly oauthMetadata: OAuthMetadata;
  readonly allowedOrigins?: readonly string[];
}

export interface HostedMcpApp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

export function createHostedMcpApp(config: HostedMcpConfig): HostedMcpApp {
  const resourceUrl = canonicalResourceUrl(config.publicUrl);
  const issuer = String(config.oauthMetadata.issuer);
  const jwksUri = String(config.oauthMetadata.jwks_uri);
  const verifier = createOpenKeyTokenVerifier({
    issuer,
    audience: resourceUrl.toString(),
    jwksUri,
    requiredScope: REQUIRED_SCOPE,
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
    const stateRoot = store.tenantStateRoot(subject);
    const validator = createJsonSchemaValidator();
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_VERSION },
      {
        jsonSchemaValidator: validator,
        instructions: "Call tinycloud_connect first. If an operation returns authority_required, open approval.url, then retry that operation unchanged.",
      },
    );
    registerTinyCloudTools(server, {
      profile: "agent",
      explicitProfile: true,
      allowOwnerProfile: false,
      stateRoot,
      transformOperationResult: (result) => store.decorateAuthorityResult(subject, ownerDids, result),
    }, validator);
    registerConnectTool(server, validator, store, identity);
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
    resourceName: "TinyCloud hosted MCP",
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

      if (url.pathname === "/connect") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        try {
          const destination = await store.approvalRedirect(requiredState(url));
          return Response.redirect(destination, 302);
        } catch {
          return json({ error: "The approval link is invalid or expired." }, 400);
        }
      }
      if (url.pathname === "/connect/callback") {
        if (request.method === "OPTIONS") return callbackCors(new Response(null, { status: 204 }), config.openkeyHost);
        if (request.method !== "POST") return methodNotAllowed("POST");
        const originFailure = validateCallbackOrigin(request, config.openkeyHost);
        if (originFailure !== undefined) return callbackCors(originFailure, config.openkeyHost);
        try {
          await store.completeApproval(requiredState(url), request);
          return callbackCors(json({ success: true }), config.openkeyHost);
        } catch {
          return callbackCors(json({ error: "TinyCloud could not accept this delegation." }, 400), config.openkeyHost);
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
): void {
  const inputSchema = fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator);
  const outputSchema = fromJsonSchema({
    type: "object",
    properties: {
      connected: { type: "boolean" },
      sessionDid: { type: "string" },
      approvalUrl: { type: "string", format: "uri" },
      expiresAt: { type: "string", format: "date-time" },
    },
    required: ["connected", "sessionDid"],
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
        openWorldHint: true,
      },
    },
    async () => {
      const status = await store.connectStatus(identity.subject, identity.ownerDids);
      return {
        content: [{
          type: "text" as const,
          text: status.connected
            ? "TinyCloud is connected."
            : "TinyCloud approval is required; open approvalUrl, then call this tool again.",
        }],
        structuredContent: status,
      };
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
  if (state === null || state.length > 512) throw new Error("Missing approval state.");
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
