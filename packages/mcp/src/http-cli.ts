import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createHostedMcpApp } from "./http.js";
import { loadOAuthMetadata } from "./oauth.js";

export async function main(): Promise<void> {
  process.umask(0o077);
  const publicUrl = requiredUrl("TC_MCP_PUBLIC_URL");
  const stateDir = requiredAbsolutePath("TC_MCP_STATE_DIR");
  const stateSecret = requiredString("TC_MCP_STATE_SECRET");
  if (Buffer.byteLength(stateSecret) < 32) throw new Error("TC_MCP_STATE_SECRET must contain at least 32 bytes.");
  const openkeyHost = process.env.TC_OPENKEY_HOST ?? "https://openkey.so";
  const oauthMetadataUrl = new URL(
    process.env.TC_MCP_OAUTH_METADATA_URL ??
      "https://api.openkey.so/.well-known/oauth-authorization-server/api/auth",
  );
  const oauthMetadata = await loadOAuthMetadata(oauthMetadataUrl);
  const app = createHostedMcpApp({
    publicUrl,
    stateDir,
    stateSecret,
    nodeHost: process.env.TC_HOST ?? "https://node.tinycloud.xyz",
    openkeyHost,
    approvalTtlSeconds: positiveInteger(process.env.TC_MCP_APPROVAL_TTL_SECONDS, 300),
    delegationExpiry: process.env.TC_MCP_DELEGATION_EXPIRY ?? "1h",
    allowedOrigins: commaList(process.env.TC_MCP_ALLOWED_ORIGINS),
    oauthMetadata,
  });
  const nodeHandler = toNodeHandler(app);
  const server = createServer(nodeHandler);
  const host = process.env.HOST ?? "0.0.0.0";
  const port = positiveInteger(process.env.PORT, 3000);
  server.listen(port, host, () => {
    process.stderr.write(`[tinycloud-mcp-http] listening on ${host}:${port}\n`);
  });
  const shutdown = () => {
    server.close(() => void app.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function requiredString(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name: string): URL {
  const url = new URL(requiredString(name));
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS outside localhost.`);
  }
  return url;
}

function requiredAbsolutePath(name: string): string {
  const value = requiredString(name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer environment value.");
  return parsed;
}

function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

void main().catch(() => {
  process.stderr.write("[tinycloud-mcp-http] Startup failed.\n");
  process.exitCode = 1;
});
