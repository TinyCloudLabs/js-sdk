import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { OAuthError, type AuthInfo } from "@modelcontextprotocol/server";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

import { createOpenKeyTokenVerifier } from "./oauth.js";

const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

test("owner claims reach the MCP only as canonical did:pkh DIDs", async () => {
  const { verify, sign } = await testVerifier();
  const info = await verify(await sign([OWNER.toLowerCase(), OWNER]));
  expect(info.extra).toMatchObject({ ownerDids: [OWNER] });
});

test("a token with any malformed owner claim is refused", async () => {
  const { verify, sign } = await testVerifier();
  const address = OWNER.slice("did:pkh:eip155:1:".length);
  for (const malformed of [
    "did:pkh:eip155:1:0x0",
    `did:pkh:eip155:abc:${address}`,
    `did:pkh:eip155:0:${address}`,
    `${OWNER} approve another account`,
    `${OWNER}#controller`,
    "did:web:contains spaces",
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    42,
  ]) {
    await expect(verify(await sign([OWNER, malformed]))).rejects.toBeInstanceOf(OAuthError);
  }
  await expect(verify(await sign([]))).rejects.toBeInstanceOf(OAuthError);
});

async function testVerifier(): Promise<{
  verify: (token: string) => Promise<AuthInfo>;
  sign: (ownerDids: unknown[]) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "EdDSA" };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  const verifier = createOpenKeyTokenVerifier({
    issuer: "https://openkey.test/api/auth",
    audience: "https://mcp.test/mcp",
    jwksUri: `http://127.0.0.1:${address.port}/jwks`,
    requiredScope: "tinycloud:mcp",
  });
  return {
    verify: (token) => verifier.verifyAccessToken(token),
    sign: (ownerDids) => signToken(privateKey, ownerDids),
  };
}

function signToken(privateKey: CryptoKey, ownerDids: unknown[]): Promise<string> {
  return new SignJWT({ scope: "tinycloud:mcp", "https://tinycloud.xyz/owner_dids": ownerDids })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject("openkey-user-1")
    .setAudience("https://mcp.test/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
