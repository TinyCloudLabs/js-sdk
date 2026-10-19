import { basename, isAbsolute, resolve, sep } from "node:path";

import {
  type McpServer,
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
import { beginDiagnosticPhase } from "@tinycloud/operations/diagnostics";

import { createOpenKeyTokenVerifier } from "./oauth.js";
import { logToolCall } from "./logging.js";
import { DiagnosticMcpServer, diagnosticExecutor, diagnosticSchema, isAppsDiagnosticRequest } from "./diagnostics.js";
import { HostedDiagnostics, type HostedDiagnosticConfig } from "./hosted-diagnostics.js";
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
  readonly diagnostics?: HostedDiagnosticConfig;
}

export interface HostedMcpApp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly diagnostics?: HostedDiagnostics;
}

export function createHostedMcpApp(config: HostedMcpConfig): HostedMcpApp {
  const diagnosticRoot = config.diagnostics?.root;
  const stateRoot = resolve(config.stateDir);
  const diagnosticPath = diagnosticRoot === undefined ? undefined : resolve(diagnosticRoot);
  const separateRoot = diagnosticRoot !== undefined && isAbsolute(diagnosticRoot) && diagnosticPath !== stateRoot
    && !diagnosticPath!.startsWith(`${stateRoot}${sep}`)
    && !stateRoot.startsWith(diagnosticPath!.endsWith(sep) ? diagnosticPath! : `${diagnosticPath}${sep}`);
  // Invalid/overlapping capture configuration disables diagnostics, not the app.
  const diagnostics = separateRoot ? new HostedDiagnostics(config.diagnostics!, stateRoot) : undefined;
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
  const store = new RemoteTenantStore({ ...config, publicUrl: resourceUrl }, diagnostics);
  const handler = createMcpHandler(async ({ authInfo }) => {
    diagnostics?.factoryEntered();
    const identity = oauthIdentity(authInfo);
    const { subject, ownerDids } = identity;
    const finishTenant = beginDiagnosticPhase("tenant_init");
    let stateRoot: string;
    try {
      stateRoot = await store.initializeTenant(subject);
      finishTenant({ outcome: "complete" });
    } catch (error) {
      finishTenant({ outcome: "error" });
      throw error;
    }
    const validator = createJsonSchemaValidator();
    const server = new DiagnosticMcpServer(
      { name: MCP_SERVER_NAME, version: MCP_VERSION },
      {
        jsonSchemaValidator: validator,
        instructions: "Call tinycloud_connect first. If an operation returns authority_required, open approval.url, then retry that operation unchanged. For personal records such as weight, workouts, goals or todos, call tinycloud_apps_context first.",
      },
    );
    registerTinyCloudTools(server, {
      surface: "hosted",
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

  const fetch = async (request: Request): Promise<Response> => {
      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata !== undefined) return metadata;
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return request.method === "GET"
          ? json({ ok: true })
          : methodNotAllowed("GET");
      }
      const finishHost = beginDiagnosticPhase("host_validation");
      const hostFailure = hostHeaderValidationResponse(request, allowedHosts);
      finishHost({ outcome: hostFailure === undefined ? "pass" : "refused", status: hostFailure?.status });
      if (hostFailure !== undefined) return hostFailure;

      if (url.pathname === "/connect") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        try {
          const destination = await store.approvalRedirect(requiredState(url));
          return Response.redirect(destination, 302);
        } catch (error) {
          if (error instanceof ApprovalRequestError && error.detail !== "state_expired") {
            diagnostics?.emit({ type: "operation.step", phase: "approval_request", role: "approval", outcome: "refused" });
          }
          return json({ error: "The approval link is invalid or expired." }, 400);
        }
      }
      if (url.pathname === "/connect/callback") {
        if (request.method === "OPTIONS") return callbackCors(new Response(null, { status: 204 }), config.openkeyHost);
        if (request.method !== "POST") return methodNotAllowed("POST");
        const finishOrigin = beginDiagnosticPhase("origin_validation");
        const originFailure = validateCallbackOrigin(request, config.openkeyHost);
        finishOrigin({ outcome: originFailure === undefined ? "pass" : "refused", status: originFailure?.status });
        if (originFailure !== undefined) return callbackCors(originFailure, config.openkeyHost);
        try {
          await store.completeApproval(requiredState(url), request);
          return callbackCors(json({ success: true }), config.openkeyHost);
        } catch (error) {
          if (error instanceof ApprovalRequestError && error.detail !== "state_expired") {
            diagnostics?.emit({ type: "operation.step", phase: error.detail === "body_invalid" ? "input_validation" : "approval_request", role: "approval", outcome: "refused" });
          }
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
      const finishOrigin = beginDiagnosticPhase("origin_validation");
      const originFailure = validateOrigin(request, config.allowedOrigins);
      finishOrigin({ outcome: originFailure === undefined ? "pass" : "refused", status: originFailure?.status });
      if (originFailure !== undefined) return originFailure;
      const finishAuth = beginDiagnosticPhase("bearer_validation");
      let auth: AuthInfo | Response;
      try {
        auth = await authenticate(request);
      } catch (error) {
        finishAuth({ outcome: "error" });
        throw error;
      }
      finishAuth({ outcome: auth instanceof Response ? "refused" : "pass", status: auth instanceof Response ? auth.status : undefined });
      if (auth instanceof Response) return auth;
      if (diagnostics === undefined || typeof auth.extra?.subject !== "string") {
        return handler.fetch(request, { authInfo: auth });
      }
      // Inspect a clone only for diagnostic admission; the protocol handler owns
      // validation and consumes the original request exactly as without capture.
      const scoped = request.method === "POST"
        && await request.clone().json().then(isAppsDiagnosticRequest, () => false);
      // Only the verified OAuth subject is used by the existing HMAC tenant
      // mapping. Peer _meta, headers and diagnostic IDs never choose a partition.
      const tenantId = basename(store.tenantStateRoot(auth.extra.subject));
      return diagnostics.tenant(tenantId, () => handler.fetch(request, { authInfo: auth }), scoped);
  };
  return {
    diagnostics,
    fetch: (request) => diagnostics === undefined
      ? fetch(request)
      : diagnostics.exchange(() => diagnostics.response(() => fetch(request), new URL(request.url).pathname === resourceUrl.pathname)),
    close: async () => {
      try { await handler.close(); } finally { await diagnostics?.close(); }
    },
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
      inputSchema: diagnosticSchema(inputSchema, "input_validation"),
      outputSchema: diagnosticSchema(outputSchema, "output_validation"),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (_input, context) => diagnosticExecutor("connect", context, async () => {
      const startedAt = performance.now();
      let code = "INTERNAL_ERROR";
      try {
        const status = await store.connectStatus(identity.subject, identity.ownerDids);
        code = status.connected ? "ok" : "authority_required";
        return {
          content: [{
            type: "text" as const,
            text: status.connected
              ? "TinyCloud is connected."
              : `TinyCloud approval is required. Open ${status.approvalUrl}, then call this tool again. This link expires at ${status.expiresAt}.`,
          }],
          structuredContent: status,
        };
      } finally {
        logToolCall("tinycloud_connect", code, startedAt, 0);
      }
    }),
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
