import { Agent, setGlobalDispatcher } from "undici";

/**
 * Idle time after which the hosted MCP closes a pooled connection to the
 * TinyCloud node. The node ingress closes an idle connection after 65 s, and a
 * 60 s status poll must find its connection still open, so the limit sits
 * between the two. The limit also caps any Keep-Alive hint a server sends.
 */
export const NODE_KEEP_ALIVE_TIMEOUT_MS = 62_000;

export function createNodeKeepAliveAgent(keepAliveTimeoutMs: number = NODE_KEEP_ALIVE_TIMEOUT_MS): Agent {
  return new Agent({ keepAliveTimeout: keepAliveTimeoutMs, keepAliveMaxTimeout: keepAliveTimeoutMs });
}

/** Routes every `fetch` of this process through one keep-alive pool. */
export function installNodeKeepAlive(): void {
  setGlobalDispatcher(createNodeKeepAliveAgent());
}

const CONNECTION_RESET_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/** True when the error chain names a connection the peer closed or reset. */
export function isConnectionReset(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_RESET_CODES.has(code)) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

type Attempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * Runs an idempotent read and repeats it once when a pooled connection was
 * closed under it. Any other failure, and a second reset, is returned as is.
 * Writes must never use this.
 */
export async function retryReadOnConnectionReset<T extends Attempt>(read: () => Promise<T>): Promise<T> {
  let first: T;
  try {
    first = await read();
  } catch (error) {
    if (!isConnectionReset(error)) throw error;
    return read();
  }
  return !first.ok && isConnectionReset(first.error) ? read() : first;
}
