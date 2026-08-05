import { afterAll, beforeAll, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "./setup";

// The public web bundle registers browser custom elements at module load. The
// smoke itself is HTTP-only, so give that registration the smallest DOM shell
// before importing the public package rather than importing source internals.
(globalThis as any).HTMLElement = class {
  shadowRoot: unknown;
  attachShadow() {
    this.shadowRoot = { innerHTML: "", querySelector: () => null };
    return this.shadowRoot;
  }
};
(globalThis as any).customElements = { define: () => undefined, get: () => undefined };
(globalThis as any).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  location: { hostname: "manage-key-http-smoke.local" },
};
(globalThis as any).document = {
  createElement: () => ({
    setAttribute: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    style: {},
  }),
  body: { appendChild: () => undefined, style: {} },
};

const {
  establishManageKeySession,
  parseCanonicalTinyCloudIdentityClaims,
  requestTinyCloudManageKeyScope,
} = await import("@tinycloud/web-sdk");

const account = privateKeyToAccount(`0x${TEST_KEY}` as `0x${string}`);
const canonicalIdentity = {
  version: "v1" as const,
  keyId: "local-openkey-canonical-key",
  address: account.address,
  chainId: 1,
  did: `did:pkh:eip155:1:${account.address}`,
  spaceId: `tinycloud:pkh:eip155:1:${account.address}:applications`,
};
const CLIENT_ID = "tc-490-public-http-smoke";
const REDIRECT_URI = "http://127.0.0.1/callback";
const SMOKE_KEY = "manage-key-http-smoke/round-trip.bin";
const SMOKE_BYTES = new Uint8Array([0, 255, 17, 128, 64]);

type OpenKeyServer = ReturnType<typeof Bun.serve>;

let signerRequests: Array<{
  authorization: string | null;
  cookie: string | null;
  message: string;
}> = [];
let oauthServer: OpenKeyServer;

function required(value: string | null, name: string): string {
  if (!value) throw new Error(`OpenKey smoke request is missing ${name}`);
  return value;
}

function startFaithfulOpenKeyHandler(): OpenKeyServer {
  const authorizationCodes = new Map<string, { clientId: string; scope: string }>();
  const tokens = new Map<string, { clientId: string; scope: string }>();
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
        const clientId = required(url.searchParams.get("client_id"), "client_id");
        const redirectUri = required(url.searchParams.get("redirect_uri"), "redirect_uri");
        const scope = required(url.searchParams.get("scope"), "scope");
        expect(clientId).toBe(CLIENT_ID);
        expect(redirectUri).toBe(REDIRECT_URI);
        expect(scope.split(" ")).toContain("tinycloud:manage-key");
        const code = `code-${crypto.randomUUID()}`;
        authorizationCodes.set(code, { clientId, scope });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        return Response.redirect(callback, 302);
      }

      if (url.pathname === "/oauth2/token" && request.method === "POST") {
        const body = await request.formData();
        const code = required(body.get("code")?.toString() ?? null, "authorization code");
        const clientId = required(body.get("client_id")?.toString() ?? null, "client_id");
        const grant = authorizationCodes.get(code);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(grant?.clientId).toBe(clientId);
        expect(clientId).toBe(CLIENT_ID);
        authorizationCodes.delete(code);
        const accessToken = `access-${crypto.randomUUID()}`;
        tokens.set(accessToken, { clientId, scope: grant!.scope });
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          scope: grant!.scope,
          claims: {
            "https://tinycloud.xyz/canonical_identity": canonicalIdentity,
          },
        });
      }

      if (url.pathname === "/api/delegate/sign" && request.method === "POST") {
        const authorization = request.headers.get("authorization");
        const token = authorization?.replace(/^Bearer /u, "");
        const grant = token ? tokens.get(token) : undefined;
        if (!grant || grant.clientId !== CLIENT_ID || !grant.scope.split(" ").includes("tinycloud:manage-key")) {
          return Response.json({ approved: false, code: "missing_scope", reason: "Manage-key consent is required." }, { status: 403 });
        }
        const body = await request.json() as {
          address?: unknown;
          chainId?: unknown;
          message?: unknown;
          type?: unknown;
        };
        expect(body.address).toBe(canonicalIdentity.address);
        expect(body.chainId).toBe(1);
        expect(body.type).toBe("siwe");
        expect(typeof body.message).toBe("string");
        signerRequests.push({
          authorization,
          cookie: request.headers.get("cookie"),
          message: body.message as string,
        });
        const signature = await account.signMessage({ message: body.message as string });
        return Response.json({ approved: true, signature, canonicalIdentity });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}

async function consentedOAuthGrant() {
  const scope = requestTinyCloudManageKeyScope("openid email");
  const authorize = new URL(`http://127.0.0.1:${oauthServer.port}/oauth2/authorize`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scope);
  const authorization = await fetch(authorize, { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const callback = new URL(required(authorization.headers.get("location"), "redirect location"));
  const exchange = await fetch(`http://127.0.0.1:${oauthServer.port}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code: required(callback.searchParams.get("code"), "authorization code"),
    }),
  });
  expect(exchange.ok).toBe(true);
  return await exchange.json() as {
    access_token: string;
    scope: string;
    claims: unknown;
  };
}

beforeAll(async () => {
  await checkServerHealth();
  // This is an explicit, independent provisioning step. The scoped OAuth
  // session below cannot silently bootstrap or host this owned space.
  const provisioner = new TinyCloudNode({
    host: SERVER_URL,
    privateKey: TEST_KEY,
    autoBootstrapAccount: false,
    autoCreateSpace: true,
  });
  await provisioner.signIn();
  await provisioner.hostOwnedSpace("applications");
  oauthServer = startFaithfulOpenKeyHandler();
});

afterAll(() => oauthServer.stop(true));

test("public web SDK completes OAuth consent, signs one SIWE, and round-trips KV through real HTTP", async () => {
  signerRequests = [];
  const grant = await consentedOAuthGrant();
  const identity = parseCanonicalTinyCloudIdentityClaims(grant.claims);
  const { client, session } = await establishManageKeySession({
    identity,
    signer: {
      endpoint: `http://127.0.0.1:${oauthServer.port}/api/delegate/sign`,
      token: grant.access_token,
      scopes: grant.scope,
    },
    tinycloud: {
      tinycloudHosts: [SERVER_URL],
      autoDiscoverLocalNode: false,
      autoCreateSpace: false,
      persistSession: false,
      includeAccountRegistryPermissions: false,
      spacePrefix: "applications",
      capabilityRequest: {
        resources: [{
          service: "tinycloud.kv",
          space: identity.spaceId,
          path: "manage-key-http-smoke/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        }],
      },
    },
  });

  expect(session.address).toBe(identity.address);
  expect(client.spaceId).toBe(identity.spaceId);
  expect(signerRequests).toHaveLength(1);
  expect(signerRequests[0]?.authorization).toBe(`Bearer ${grant.access_token}`);
  expect(signerRequests[0]?.cookie).toBeNull();
  expect(signerRequests[0]?.message.length).toBeGreaterThan(0);

  const put = await client.kv.put(SMOKE_KEY, SMOKE_BYTES, {
    contentType: "application/octet-stream",
  });
  expect(put.ok).toBe(true);
  const get = await client.kv.get<Uint8Array>(SMOKE_KEY, { binary: true });
  expect(get.ok).toBe(true);
  if (!get.ok) throw new Error("KV get unexpectedly failed");
  expect(Buffer.from(get.data.data).equals(Buffer.from(SMOKE_BYTES))).toBe(true);
}, 60_000);
