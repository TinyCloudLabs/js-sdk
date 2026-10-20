import { authorizationVerdictOf } from "@tinycloud/sdk-services";
import { CLI_NAME } from "./cli-name.js";

/** Cause links read for the node's refusal text; the SDK wraps it, so it is rarely the outermost error. */
const MAX_CAUSE_DEPTH = 8;
const REVOKED_GRANT_BODY = /\b401 - delegation-(?:ancestor-)?revoked\b/;

export const REVOKED_GRANT_MESSAGE =
  `This grant was revoked. Ask the owner for a new grant (\`${CLI_NAME} auth request ...\`).`;

/**
 * Whether a node refusal says the presented grant (or one it was derived from) was revoked.
 * Status alone cannot tell this from a stale session, so it also needs the node's own
 * `delegation-revoked` / `delegation-ancestor-revoked` 401 body; any other 401 keeps its meaning.
 */
export function isRevokedGrantRefusal(error: unknown): boolean {
  if (authorizationVerdictOf(error) !== "unauthenticated") return false;
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof node === "object" && node !== null && !seen.has(node); depth += 1) {
    seen.add(node);
    const { message, cause } = node as { message?: unknown; cause?: unknown };
    if (typeof message === "string" && REVOKED_GRANT_BODY.test(message)) return true;
    node = cause;
  }
  return false;
}
