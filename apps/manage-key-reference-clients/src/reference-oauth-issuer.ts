import { privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  TINYCLOUD_CANONICAL_IDENTITY_CLAIM,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";
import { NOTES_CLIENT_ID } from "./notes-client";
import { TASKS_CLIENT_ID } from "./tasks-client";

const REFERENCE_CANONICAL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type OAuthClient = "notes" | "tasks";
type PendingAuthorization = {
  client: OAuthClient;
  clientId: string;
  redirectUri: string;
  scope: string;
};

export interface OAuthAuditEvent {
  client: OAuthClient;
  stage: "authorize" | "token";
  clientId: string;
}

export interface ReferenceOAuthIssuer {
  readonly baseUrl: string;
  readonly events: readonly OAuthAuditEvent[];
  stop(): void;
}

/** Hosts the canonical applications space with the owner key, out of band. */
export async function provisionReferenceApplicationsSpace(host: string): Promise<void> {
  const owner = new TinyCloudNode({
    host,
    privateKey: REFERENCE_CANONICAL_KEY,
    autoBootstrapAccount: false,
    autoCreateSpace: true,
  });
  await owner.signIn();
  await owner.hostOwnedSpace("applications");
}

/**
 * A local public OAuth handler for the examples. It is the authority that
 * derives the canonical identity; neither client imports or caches it.
 */
export function startReferenceOAuthIssuer(): ReferenceOAuthIssuer {
  const grants = new Map<string, PendingAuthorization>();
  const tokens = new Map<string, PendingAuthorization>();
  const events: OAuthAuditEvent[] = [];
  const account = privateKeyToAccount(REFERENCE_CANONICAL_KEY);
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const client = pathClient(url.pathname, "authorize");
      if (client && request.method === "GET") {
        const clientId = required(url.searchParams.get("client_id"), "client_id");
        const redirectUri = required(url.searchParams.get("redirect_uri"), "redirect_uri");
        const scope = required(url.searchParams.get("scope"), "scope");
        if (
          url.searchParams.get("response_type") !== "code" ||
          clientId !== expectedClientId(client) ||
          !scope.split(" ").includes("tinycloud:manage-key")
        ) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        const code = crypto.randomUUID();
        grants.set(code, { client, clientId, redirectUri, scope });
        events.push({ client, stage: "authorize", clientId });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", required(url.searchParams.get("state"), "state"));
        return Response.redirect(callback, 302);
      }

      const tokenClient = pathClient(url.pathname, "token");
      if (tokenClient && request.method === "POST") {
        const form = await request.formData();
        const code = required(form.get("code")?.toString() ?? null, "code");
        const clientId = required(form.get("client_id")?.toString() ?? null, "client_id");
        const redirectUri = required(form.get("redirect_uri")?.toString() ?? null, "redirect_uri");
        const grant = grants.get(code);
        if (
          form.get("grant_type") !== "authorization_code" ||
          !grant ||
          grant.client !== tokenClient ||
          grant.clientId !== clientId ||
          grant.redirectUri !== redirectUri
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        grants.delete(code);
        events.push({ client: tokenClient, stage: "token", clientId });
        const token = `${tokenClient}-${crypto.randomUUID()}`;
        tokens.set(token, grant);
        const identity = canonicalIdentity(account.address);
        const claims = { [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: identity };
        if (tokenClient === "notes") {
          return Response.json({
            client_id: clientId,
            access_token: token,
            scope: grant.scope,
            claims,
          });
        }
        return Response.json({
          audience: clientId,
          token,
          id_token_claims: claims,
        });
      }

      if (url.pathname === "/api/delegate/sign" && request.method === "POST") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
        const grant = token ? tokens.get(token) : undefined;
        if (!grant || !grant.scope.split(" ").includes("tinycloud:manage-key")) {
          return Response.json({ approved: false, code: "missing_scope" }, { status: 403 });
        }
        const body = await request.json() as { message?: unknown; type?: unknown };
        if (body.type !== "siwe" || typeof body.message !== "string") {
          return Response.json({ approved: false, code: "message_rejected" }, { status: 400 });
        }
        return Response.json({
          approved: true,
          signature: await account.signMessage({ message: body.message }),
          canonicalIdentity: canonicalIdentity(account.address),
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

function canonicalIdentity(address: CanonicalTinyCloudIdentity["address"]): CanonicalTinyCloudIdentity {
  return {
    version: "v1",
    keyId: "reference-oauth-canonical-key",
    address,
    chainId: 1,
    did: `did:pkh:eip155:1:${address}`,
    spaceId: `tinycloud:pkh:eip155:1:${address}:applications`,
  };
}

function pathClient(pathname: string, action: "authorize" | "token"): OAuthClient | undefined {
  if (pathname === `/notes/${action}`) return "notes";
  if (pathname === `/tasks/${action}`) return "tasks";
  return undefined;
}

function expectedClientId(client: OAuthClient): string {
  return client === "notes" ? NOTES_CLIENT_ID : TASKS_CLIENT_ID;
}

function required(value: string | null, field: string): string {
  if (!value) throw new Error(`OAuth request is missing ${field}`);
  return value;
}
