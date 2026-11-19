import { authorizationVerdictOf } from "@tinycloud/sdk-services";
import { CLI_NAME } from "./cli-name.js";

/** Cause links read for the node's refusal; the SDK wraps it, so it is rarely the outermost error. */
const MAX_CAUSE_DEPTH = 8;
/**
 * The node's whole 401 body for a revoked chain (`delegation-revoked: <cid>`, or
 * `delegation-ancestor-revoked: ancestor=<cid> invoked=<cid>`; older nodes prefix `Invalid invocation: `),
 * as it ends an SDK error message (`<what failed>: 401 - <body>`). The match starts at the `401 - ` separator
 * and runs to the end of the message, and only letters and digits may follow the error kind (the CIDs are not
 * checked beyond that), so a key or path in another 401 body (`Unauthorized Action: <space>/kv/…/delegation-revoked/ / …`)
 * or any other text that mentions "revoked" does not match.
 */
const REVOKED_GRANT_BODY =
  /\b401 - (?:Invalid invocation: )?delegation-(?:revoked: [A-Za-z0-9]+|ancestor-revoked: ancestor=[A-Za-z0-9]+ invoked=[A-Za-z0-9]+)\s*$/;
/** The KV service's own typed codes for the same two bodies. */
const REVOKED_GRANT_CODES: ReadonlySet<unknown> = new Set(["AUTH_DELEGATION_REVOKED", "AUTH_DELEGATION_ANCESTOR_REVOKED"]);
/** The codes a node puts beside the text of a revocation refusal since 1.25.17 (TC-2381). */
const NODE_REVOCATION_CODES: ReadonlySet<unknown> = new Set(["delegation_revoked", "parent_revoked", "ancestor_revoked"]);
const BODY_SEPARATOR = "401 - ";

/**
 * The refusal text of a node's 401 body. A node since 1.25.17 answers a revoked chain with
 * `{"code": "<revocation code>", "error": "<text>"}`; an older node answers the text alone. Only that exact
 * envelope is opened. Every other body, JSON or not, is returned unchanged and is matched as before.
 */
export function nodeRefusalText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return body;
  }
  return typeof parsed === "object" && parsed !== null &&
    "code" in parsed && NODE_REVOCATION_CODES.has(parsed.code) &&
    "error" in parsed && typeof parsed.error === "string"
    ? parsed.error
    : body;
}

export const REVOKED_GRANT_MESSAGE =
  `This grant was revoked. Ask the owner for a new grant (\`${CLI_NAME} auth request ...\`).`;

/**
 * Whether a node refusal says the presented grant (or one it was derived from) was revoked.
 * Status alone cannot tell this from a stale session, so it also needs the typed code or the node's own
 * `delegation-revoked` / `delegation-ancestor-revoked` 401 body; any other 401 keeps its meaning.
 */
export function isRevokedGrantRefusal(error: unknown): boolean {
  if (authorizationVerdictOf(error) !== "unauthenticated") return false;
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof node === "object" && node !== null && !seen.has(node); depth += 1) {
    seen.add(node);
    const { code, message, cause } = node as { code?: unknown; message?: unknown; cause?: unknown };
    if (REVOKED_GRANT_CODES.has(code)) return true;
    if (typeof message === "string") {
      // The node's body follows the SDK's first separator. A body that is not the revocation envelope stays as it is.
      const start = message.indexOf(BODY_SEPARATOR);
      const end = start + BODY_SEPARATOR.length;
      const readable = start < 0 ? message : message.slice(0, end) + nodeRefusalText(message.slice(end));
      if (REVOKED_GRANT_BODY.test(readable)) return true;
    }
    node = cause;
  }
  return false;
}
