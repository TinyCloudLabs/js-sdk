import type { PermissionEntry } from "@tinycloud/node-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isInteractive } from "../output/formatter.js";
import { createInterface } from "node:readline";
import { DEFAULT_OPENKEY_HOST } from "../config/constants.js";

interface DelegationData {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  [key: string]: unknown;
}

interface AuthFlowOptions {
  paste?: boolean;
  noPopup?: boolean;
  jwk?: object;
  host?: string;
  permissions?: PermissionEntry[];
  /**
   * OpenKey base URL. Resolution order in callers: TC_OPENKEY_HOST env →
   * profile.openkeyHost → DEFAULT_OPENKEY_HOST. Threaded explicitly so this
   * module stays free of profile lookups.
   */
  openkeyHost?: string;
  /**
   * Lifetime hint for the resulting delegation. Encoded into the
   * `/delegate?expiry=<value>` URL parameter so OpenKey can sign for the
   * requested window instead of its hardcoded default. Forwarded as-is —
   * OpenKey does the parsing and clamping server-side.
   */
  expiry?: string | number;
}

const PRIVATE_JWK_FIELDS = new Set([
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k",
]);

export function publicJwkForDelegation(jwk: object): object {
  const publicJwk: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(jwk)) {
    if (!PRIVATE_JWK_FIELDS.has(key)) {
      publicJwk[key] = value;
    }
  }

  return publicJwk;
}

/**
 * Start the browser auth flow.
 * Mode 1 (default): local HTTP callback server
 * Mode 2 (--paste): manual code paste
 */
export async function startAuthFlow(
  did: string,
  options: AuthFlowOptions = {}
): Promise<DelegationData> {
  if (options.paste) {
    return pasteFlow(did, options);
  }

  try {
    return await callbackFlow(did, options);
  } catch {
    // Fallback to paste if browser can't open
    if (isInteractive()) {
      console.error("Could not open browser. Falling back to manual paste mode.");
      return pasteFlow(did, options);
    }
    throw new Error("Cannot open browser in non-interactive mode. Use --paste flag.");
  }
}

export function buildAuthUrl(did: string, options: AuthFlowOptions & { callback?: string } = {}): string {
  const params = new URLSearchParams();
  params.set("did", did);
  if (options.callback) {
    params.set("callback", options.callback);
  }
  if (options.jwk) {
    // base64url-encode the JWK
    const jwkB64 = Buffer.from(
      JSON.stringify(publicJwkForDelegation(options.jwk)),
    ).toString("base64url");
    params.set("jwk", jwkB64);
  }
  if (options.host) {
    params.set("host", options.host);
  }
  if (options.permissions?.length) {
    params.set(
      "permissions",
      Buffer.from(JSON.stringify({ permissions: options.permissions })).toString("base64url"),
    );
  }
  if (options.expiry !== undefined) {
    params.set("expiry", String(options.expiry));
  }
  const base = options.openkeyHost ?? DEFAULT_OPENKEY_HOST;
  return `${base}/delegate?${params.toString()}`;
}

function shouldOpenBrowser(options: AuthFlowOptions): boolean {
  if (options.noPopup) return false;
  const env = process.env.TC_AUTH_NO_POPUP ?? process.env.TC_NO_POPUP;
  return env !== "1" && env !== "true";
}

async function callbackFlow(did: string, options: AuthFlowOptions = {}): Promise<DelegationData> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    let settled = false;
    let rl: ReturnType<typeof createInterface> | undefined;

    function settle(result: { data?: DelegationData; error?: Error }) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (rl) {
        rl.close();
      }
      if (result.data) {
        resolve(result.data);
      } else {
        reject(result.error);
      }
    }

    function parsePasteInput(input: string): DelegationData {
      const trimmed = input.trim();
      // Try parsing as JSON directly
      try {
        return JSON.parse(trimmed) as DelegationData;
      } catch {
        // Try base64 decoding first
        const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
        return JSON.parse(decoded) as DelegationData;
      }
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const data = JSON.parse(body) as DelegationData;
            // Send CORS headers and success response
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ success: true }));
            settle({ data });
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            settle({ error: new Error("Invalid delegation data received") });
          }
        });
      } else if (req.method === "OPTIONS") {
        // CORS preflight
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        settle({ error: new Error("Failed to start callback server") });
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const authUrl = buildAuthUrl(did, { ...options, callback: callbackUrl });
      const openBrowser = shouldOpenBrowser(options);

      if (openBrowser && isInteractive()) {
        console.error(`Opening browser for authentication...`);
        console.error(`If the browser doesn't open, visit: ${authUrl}`);
      } else if (!openBrowser || isInteractive()) {
        console.error(`Open this URL in a browser to authenticate: ${authUrl}`);
      }

      if (openBrowser) {
        try {
          const open = (await import("open")).default;
          await open(authUrl);
        } catch {
          server.close();
          throw new Error("Failed to open browser");
        }
      }

      // In interactive mode, also accept paste input while waiting for callback
      if (isInteractive()) {
        console.error(`\nIf the browser can't connect back, paste the delegation code here:`);
        rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        rl.on("line", (input) => {
          if (settled) return;
          try {
            const data = parsePasteInput(input);
            settle({ data });
          } catch {
            console.error("Invalid delegation code. Expected JSON or base64-encoded JSON. Try again:");
          }
        });
      }
    });

    // Timeout after 5 minutes
    timeout = setTimeout(() => {
      settle({ error: new Error("Authentication timed out after 5 minutes") });
    }, 5 * 60 * 1000);
  });
}

async function pasteFlow(did: string, options: AuthFlowOptions = {}): Promise<DelegationData> {
  const authUrl = buildAuthUrl(did, options);

  console.error(`\nOpen this URL in a browser to authenticate:\n`);
  console.error(`  ${authUrl}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve, reject) => {
    rl.question("Paste delegation code: ", (input) => {
      rl.close();
      try {
        // Try parsing as JSON directly
        const data = JSON.parse(input.trim()) as DelegationData;
        resolve(data);
      } catch {
        // Try base64 decoding first
        try {
          const decoded = Buffer.from(input.trim(), "base64").toString("utf-8");
          const data = JSON.parse(decoded) as DelegationData;
          resolve(data);
        } catch {
          reject(new Error("Invalid delegation code. Expected JSON or base64-encoded JSON."));
        }
      }
    });
  });
}
