import type { PermissionEntry } from "@tinycloud/node-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { DEFAULT_OPENKEY_HOST, DEFAULT_OPENKEY_DEVICE_API_HOST, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

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
   * User-facing context shown on the OpenKey approval page. Optional at the
   * OpenKey protocol boundary, but TinyCloud CLI permission-grant call sites
   * should always provide it.
   */
  reason?: string;
  /**
   * OpenKey base URL. Resolution order in callers: TC_OPENKEY_HOST env →
   * profile.openkeyHost → DEFAULT_OPENKEY_HOST. Threaded explicitly so this
   * module stays free of profile lookups.
   */
  openkeyHost?: string;
  /** API origin for short-code lookup when OpenKey uses a separate API host. */
  openkeyApiHost?: string;
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
    if (process.stdin.isTTY) {
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
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (options.permissions?.length) {
    params.set(
      "permissions",
      Buffer.from(JSON.stringify({
        permissions: options.permissions,
        ...(reason ? { reason } : {}),
      })).toString("base64url"),
    );
  }
  if (reason) {
    params.set("reason", reason);
  }
  if (options.expiry !== undefined) {
    params.set("expiry", String(options.expiry));
  }
  // Announce the negotiated authorization protocol so OpenKey can pick the
  // right widget copy. Older OpenKey builds ignore unknown params.
  params.set("protocolVersion", "1");
  const base = options.openkeyHost ?? DEFAULT_OPENKEY_HOST;
  return `${base}/delegate?${params.toString()}`;
}

/**
 * Runtime validator for a delegation callback payload. Returns null when
 * the payload looks well-formed; otherwise a human-readable reason. Called
 * before the delegation is persisted so a tampered response cannot install
 * a session with unexpected fields.
 *
 * The `permissions` field is optional (older OpenKey builds omit it). When
 * present it must be a strict `{ service, space, path, actions[] }` shape.
 * The stronger subset-vs-requested check lives in
 * `portableFromOpenKeyDelegation` (which has access to the original request);
 * this validator's job is only to refuse a structurally-malformed response
 * before any subset comparison can be made.
 */
export function validateDelegationCallbackPayload(value: unknown): string | null {
  if (!value || typeof value !== "object") return "expected an object";
  const v = value as Record<string, unknown>;
  if (!v.delegationHeader || typeof v.delegationHeader !== "object") {
    return "delegationHeader must be an object";
  }
  const auth = (v.delegationHeader as Record<string, unknown>).Authorization;
  if (typeof auth !== "string" || !auth) {
    return "delegationHeader.Authorization must be a non-empty string";
  }
  if (typeof v.delegationCid !== "string" || !v.delegationCid) {
    return "delegationCid must be a non-empty string";
  }
  if (typeof v.spaceId !== "string" || !v.spaceId) {
    return "spaceId must be a non-empty string";
  }
  if (v.permissions !== undefined) {
    if (!Array.isArray(v.permissions)) {
      return "permissions, when present, must be an array";
    }
    for (let i = 0; i < v.permissions.length; i++) {
      const entry = v.permissions[i];
      if (!entry || typeof entry !== "object") {
        return `permissions[${i}] must be an object`;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.service !== "string" || !e.service) {
        return `permissions[${i}].service must be a non-empty string`;
      }
      if (typeof e.space !== "string") {
        return `permissions[${i}].space must be a string`;
      }
      if (typeof e.path !== "string") {
        return `permissions[${i}].path must be a string`;
      }
      if (!Array.isArray(e.actions) || e.actions.some((a) => typeof a !== "string" || !a)) {
        return `permissions[${i}].actions must be a non-empty string[]`;
      }
    }
  }
  return null;
}

async function delegationFromInput(input: string, did: string, options: AuthFlowOptions): Promise<DelegationData> {
  const trimmed = input.trim();
  let parsed: unknown;
  if (/^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(trimmed)) {
    if (!options.jwk) throw new Error("A CLI session key is required to retrieve a delegation.");
    const apiHost = process.env.TC_OPENKEY_API_HOST ?? options.openkeyApiHost ??
      (options.openkeyHost && options.openkeyHost !== DEFAULT_OPENKEY_HOST
        ? options.openkeyHost : DEFAULT_OPENKEY_DEVICE_API_HOST);
    const response = await fetch(`${apiHost.replace(/\/$/, "")}/api/delegation-codes/${trimmed.toLowerCase()}`, {
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(response.status === 404
        ? "Delegation code not found or expired. Use the full code shown in OpenKey instead."
        : `Could not retrieve delegation code (HTTP ${response.status}).`);
    }
    const result = await response.json() as { delegation?: unknown };
    parsed = result.delegation;
    const delegation = parsed as Record<string, unknown> | null;
    const jwk = delegation?.jwk as Record<string, unknown> | undefined;
    const localJwk = publicJwkForDelegation(options.jwk) as Record<string, unknown>;
    if (
      typeof delegation?.verificationMethod !== "string" ||
      delegation.verificationMethod.split("#")[0] !== did.split("#")[0] ||
      !jwk || typeof jwk !== "object" || Array.isArray(jwk) ||
      jwk.kty !== "OKP" || jwk.crv !== "Ed25519" ||
      typeof jwk.x !== "string" || jwk.x !== localJwk.x ||
      [...PRIVATE_JWK_FIELDS].some((field) => field in jwk)
    ) {
      throw new Error("Delegation is bound to a different CLI key.");
    }
  } else {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(Buffer.from(trimmed, "base64").toString("utf-8"));
      } catch {
        throw new Error("Invalid delegation code. Expected JSON, base64-encoded JSON, or XXXX-XXXX.");
      }
    }
  }
  const invalid = validateDelegationCallbackPayload(parsed);
  if (invalid) throw new Error(`Invalid delegation code: ${invalid}`);
  return parsed as DelegationData;
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

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const data = JSON.parse(body) as DelegationData;
            const invalid = validateDelegationCallbackPayload(data);
            if (invalid) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: invalid }));
              settle({ error: new Error(`Invalid delegation payload: ${invalid}`) });
              return;
            }
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
      const hasTerminal = Boolean(process.stdin.isTTY || process.stderr.isTTY);

      if (openBrowser && hasTerminal) {
        console.error(`Opening browser for authentication...`);
        console.error(`If the browser doesn't open, visit: ${authUrl}`);
      } else if (!openBrowser || hasTerminal) {
        console.error(`Open this URL in a browser to authenticate: ${authUrl}`);
      }

      if (openBrowser) {
        try {
          const open = (await import("open")).default;
          await open(authUrl);
        } catch {
          settle({ error: new Error("Failed to open browser") });
          return;
        }
      }

      // In interactive mode, also accept paste input while waiting for callback
      if (process.stdin.isTTY) {
        console.error(`\nIf the browser can't connect back, enter the short code or paste the full delegation code here:`);
        rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        let resolving = false;
        rl.on("line", async (input) => {
          if (settled || resolving) return;
          resolving = true;
          try {
            settle({ data: await delegationFromInput(input, did, options) });
          } catch (error) {
            console.error(error instanceof Error ? error.message : "Invalid delegation code. Try again:");
          } finally {
            resolving = false;
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
    let answered = false;
    // `line` also fires for a final line without a newline when stdin ends;
    // `question` would drop it. Blank lines are not a code.
    rl.on("line", (input) => {
      if (answered || input.trim() === "") return;
      answered = true;
      rl.close();
      void delegationFromInput(input, did, options).then(resolve, reject);
    });
    rl.on("close", () => {
      if (answered) return;
      answered = true;
      reject(new CLIError(
        "PASTE_CODE_MISSING",
        `Stdin ended before a delegation code was pasted; no session was saved. Approve at ${authUrl} and pass the returned code on stdin.`,
        ExitCode.AUTH_REQUIRED,
        {
          approvalUrl: authUrl,
          hint: `Open ${authUrl}, approve, then pass the code on stdin followed by a newline.`,
        },
      ));
    });
    rl.setPrompt("Enter short code or paste full delegation code: ");
    rl.prompt();
  });
}
