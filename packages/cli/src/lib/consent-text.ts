import type { PermissionEntry } from "@tinycloud/node-sdk";

import { safeInline } from "../output/safe-text.js";
import { compactPermission } from "./permissions.js";

/**
 * Text the owner reads right before answering a y/N prompt. Request files
 * come from another party, so everything echoed from a permission goes
 * through the terminal-safe escaper.
 */

/** One permission as `service:space:path:actions`, with control characters, ANSI escapes and bidi overrides escaped. */
export function permissionConsentLine(permission: PermissionEntry): string {
  return safeInline(compactPermission(permission));
}

/** The question after the full list has been printed once; it repeats no request text. */
export function signExtrasQuestion(count: number): string {
  return `Sign the ${count} ${count === 1 ? "entry" : "entries"} marked ! above, and the rest of the request? [y/N] `;
}
