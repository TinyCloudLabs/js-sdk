import type { ProfileConfig } from "../config/types.js";
import { delegationCidOf, REVOKE_URL } from "./refusal.js";
import { sessionStateIsUsable, storedSessionState } from "./scoped-login.js";

/**
 * The one plain notice after a SUCCESSFUL `auth rotate` that replaced a live OpenKey login: the previous sign-in's delegation
 * stays live on the node, because this CLI cannot revoke it (a login's approved set carries no `tinycloud.delegation/revoke`,
 * TC-2308). Only values the stored session holds are printed: the CID when it is one (`delegationCidOf`), the date from the
 * session's own signed expiry (`until it expires` when none is readable). Undefined when there was no session, it holds no
 * delegation, it had already ended, or its owner was never verified: nothing is then known to stay live.
 */
export function previousSignInNotice(session: Record<string, unknown> | null, profile: ProfileConfig): string | undefined {
  if (session === null) return undefined;
  const header = session.delegationHeader;
  if (typeof session.delegationCid !== "string" && (typeof header !== "object" || header === null)) return undefined;
  const { state, expiresAt } = storedSessionState(session, profile);
  if (!sessionStateIsUsable(state)) return undefined;
  const cid = delegationCidOf(session);
  return `The previous sign-in${cid === undefined ? "" : ` (${cid})`} stays live until ${expiresAt ?? "it expires"} because this CLI cannot revoke it; revoke it at ${REVOKE_URL}.`;
}
