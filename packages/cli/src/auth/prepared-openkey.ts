import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import open from "open";
import type { ISigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { DEFAULT_OPENKEY_DEVICE_API_HOST, DEFAULT_OPENKEY_HOST, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { publicJwkForDelegation } from "./browser-auth.js";
import { canonicalOwnerDid } from "../lib/owner-did.js";

type Authorize = Parameters<TinyCloudNode["signInWithOpenKey"]>[0];
type SignedResult = Awaited<ReturnType<Authorize>>;
type Prepared = Parameters<Authorize>[0] & { verificationMethod: string };

export interface PreparedOpenKeyHandoff {
  readonly result: Promise<SignedResult>;
  readonly url: string;
  /** Called only after the SDK verifies the result and CLI commits its session. */
  complete(accepted: boolean): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const RESULT_FIELDS = ["address", "permissions", "protocolVersion", "selectedActionKeys", "signature", "signedMessage"];

function invalid(code: string, message: string): CLIError {
  return new CLIError(code, message, ExitCode.AUTH_REQUIRED);
}

/** An OpenKey owner identity is not a wallet signer; only OpenKey can sign its SIWE. */
export function ownerIdentitySigner(ownerDid: string): ISigner {
  const canonical = canonicalOwnerDid(ownerDid);
  const parts = canonical.split(":");
  const chainId = Number(parts[3]);
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw invalid("INVALID_ARGUMENT", "The OpenKey owner chain ID must be a positive safe integer.");
  }
  const address = parts[4]!;
  return {
    async getAddress() { return address; },
    async getChainId() { return chainId; },
    async signMessage() {
      throw invalid("REVOCATION_AUTHORITY_UNAVAILABLE",
        "OpenKey owner identity cannot sign wallet revocations; obtain verified signed authority from OpenKey instead.");
    },
  };
}

function signedEnvelope(value: unknown, state: Buffer, requestedKeyId?: string): SignedResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.transportVersion !== 2 || typeof envelope.state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.state) ||
      Buffer.from(envelope.state, "base64url").toString("base64url") !== envelope.state) return null;
  const supplied = Buffer.from(envelope.state, "base64url");
  if (supplied.length !== state.length || !timingSafeEqual(supplied, state)) return null;
  if (envelope.selectedKeyId !== undefined && typeof envelope.selectedKeyId !== "string") return null;
  // The server binds the requested key to prepare/finalize; this echo is only a consistency check.
  if (requestedKeyId && envelope.selectedKeyId !== undefined && envelope.selectedKeyId !== requestedKeyId) return null;
  const result = envelope.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const fields = Object.keys(result).sort();
  if (fields.length !== RESULT_FIELDS.length || fields.some((field, index) => field !== RESULT_FIELDS[index])) return null;
  const signed = result as Record<string, unknown>;
  if (signed.protocolVersion !== 1 || typeof signed.address !== "string" ||
      typeof signed.signature !== "string" || typeof signed.signedMessage !== "string" ||
      !Array.isArray(signed.selectedActionKeys) || !signed.selectedActionKeys.every((key) => typeof key === "string") ||
      !Array.isArray(signed.permissions)) return null;
  return signed as SignedResult;
}

function apiOrigin(openKeyHost: string): string {
  return process.env.TC_OPENKEY_API_HOST ??
    (openKeyHost === DEFAULT_OPENKEY_HOST ? DEFAULT_OPENKEY_DEVICE_API_HOST : openKeyHost);
}

export async function startPreparedOpenKeyHandoff(options: {
  prepared: Prepared;
  openKeyHost: string;
  apiHost?: string;
  noPopup?: boolean;
  paste?: boolean;
}): Promise<PreparedOpenKeyHandoff> {
  const origin = new URL(options.openKeyHost).origin;
  const state = randomBytes(32);
  const cancelSecret = randomBytes(32).toString("base64url");
  const handoffId = randomBytes(32).toString("base64url");
  const path = `/callback/${randomBytes(16).toString("base64url")}`;
  let acceptResponse: ServerResponse | undefined;
  let resolveResult!: (result: SignedResult) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<SignedResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let delivered = false;
  let completed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  const reply = (response: ServerResponse, status: number, data: object): void => {
    response.writeHead(status, { ...cors, "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  const server = options.paste ? undefined : createServer({ connectionsCheckingInterval: 1000 }, (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.origin !== origin) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.url !== path) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST" ||
          request.headers["access-control-request-headers"]?.toLowerCase() !== "content-type") {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(204, {
        ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type",
        ...(request.headers["access-control-request-private-network"] === "true"
          ? { "Access-Control-Allow-Private-Network": "true" } : {}),
      });
      response.end();
      return;
    }
    if (request.method !== "POST" || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      reply(response, 415, { accepted: false });
      return;
    }
    if (delivered || completed) {
      reply(response, 409, { accepted: false });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(response, 413, { accepted: false });
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES || delivered || completed) return;
      let envelope: unknown;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply(response, 400, { accepted: false }); return; }
      const signed = signedEnvelope(envelope, state, options.prepared.keyId);
      if (!signed) { reply(response, 403, { accepted: false }); return; }
      delivered = true;
      acceptResponse = response;
      resolveResult(signed);
    });
  });
  if (server) {
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }
  const address = server?.address();
  const callback = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}${path}` : undefined;
  const api = (options.apiHost ?? apiOrigin(options.openKeyHost)).replace(/\/$/, "");
  const cancel = async (): Promise<void> => {
    try {
      await fetch(`${api}/api/delegate/handoffs/cancel`, {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: handoffId, cancelSecret }), signal: AbortSignal.timeout(2_000),
      });
    } catch { /* The ticket expires server-side; local authority never depends on cancellation. */ }
  };
  const close = (): void => {
    clearTimeout(timeout);
    rl?.close();
    server?.close();
    state.fill(0);
  };
  try {
    const publicJwk = publicJwkForDelegation(options.prepared.jwk) as Record<string, unknown>;
    const payload = {
      transportVersion: 2,
      request: {
        protocolVersion: 1, siwe: options.prepared.siwe, jwk: publicJwk,
        host: options.prepared.host,
        sessionDid: options.prepared.verificationMethod,
        ...(options.prepared.keyId ? { keyId: options.prepared.keyId } : {}),
        ...(options.prepared.presentation ? { presentation: options.prepared.presentation } : {}),
      },
      delivery: { handoffId, ...(callback ? { callback } : {}), state: state.toString("base64url"), cancelSecret },
    };
    const url = `${origin}/delegate#tv2=${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
    if (Buffer.byteLength(url, "utf8") > 8192) {
      throw invalid("V2_URL_TOO_LONG", "The prepared OpenKey URL exceeds 8 KiB; reduce the requested scope and retry with a fresh session. Legacy approval cannot grant replica authority.");
    }
    console.error(`Open this URL in a browser to authenticate: ${url}`);
    if (!options.noPopup && !options.paste) {
      try { await open(url); }
      catch { console.error("Could not open browser. Use the printed URL or paste the signed code."); }
    }
    if (options.paste || process.stdin.isTTY) {
      console.error("Waiting up to 5 minutes for OpenKey. Paste its one-line signed code here and press Enter if the callback is blocked (Safari may require this).");
      rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.on("line", (input) => {
        if (delivered || completed || !input.trim()) return;
        let envelope: unknown;
        try {
          const code = input.trim();
          if (code.length > MAX_BODY_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(code) ||
              Buffer.from(code, "base64url").toString("base64url") !== code) throw new Error("Invalid code");
          envelope = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
        } catch { console.error("Invalid prepared OpenKey paste code. Try again."); return; }
        const signed = signedEnvelope(envelope, state, options.prepared.keyId);
        if (!signed) { console.error("Prepared OpenKey code does not match this sign-in. Try again."); return; }
        delivered = true;
        resolveResult(signed);
      });
      rl.on("close", () => {
        if (options.paste && !delivered && !completed) rejectResult(invalid("PASTE_CODE_MISSING", "Stdin ended before a prepared OpenKey code was pasted; no session was saved."));
      });
      rl.on("SIGINT", () => {
        if (!delivered && !completed) rejectResult(invalid("CANCELLED", "Prepared OpenKey sign-in cancelled; no session was saved."));
      });
    }
    if (!options.paste && !process.stdin.isTTY) {
      console.error("This CLI cannot read a paste from non-interactive stdin. If the callback fails, re-run with --paste (Safari may require it).");
    }
    timeout = setTimeout(() => {
      if (!delivered && !completed) {
        rejectResult(invalid("V2_EXPIRED",
          !options.paste && !process.stdin.isTTY
            ? "The browser could not reach the CLI. Re-run with --paste (Safari may require it). No session or key was saved."
            : "Prepared OpenKey handoff expired; restart login for a fresh SIWE. No session or key was saved."));
        close();
        void cancel();
      }
    }, 300_000);
    return {
      url,
      result,
      async complete(accepted) {
        if (completed) return;
        completed = true;
        if (acceptResponse) reply(acceptResponse, accepted ? 200 : 422, { accepted });
        close();
        if (!accepted) await cancel();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
