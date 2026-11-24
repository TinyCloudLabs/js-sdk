/** Top-level ReCap / UCAN fact key carrying the delegation mode (`"terminal"` | `"attenuable"`). */
export const DELEGATION_MODE_KEY = "xyz.tinycloud.policy/delegationMode";

/** Explicit delegation mode carried on a wallet-signed ReCap or UCAN fact. */
export type DelegationMode = "terminal" | "attenuable";

/**
 * Reject duplicate JSON object member names (including `\uXXXX` escaped-name
 * equivalents) before trusting `JSON.parse`'s last-key-wins output.
 */
export function assertNoDuplicateJsonKeys(json: string): void {
  const objects: Array<Set<string> | null> = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g;
  const parts = [...json.matchAll(tokens)].map((match) => match[0]!);
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (token.startsWith('"') && parts[i + 1] === ":") {
      const keys = objects.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) throw new Error("ReCap duplicate member is ambiguous");
      keys?.add(key);
    }
  }
}

/**
 * Read and strictly validate the optional top-level
 * `xyz.tinycloud.policy/delegationMode` member on a parsed ReCap object.
 * Absent returns `undefined`; `null`, unknown strings, and non-strings throw.
 */
export function parseDelegationModeField(parsed: Record<string, unknown>): DelegationMode | undefined {
  if (!Object.prototype.hasOwnProperty.call(parsed, DELEGATION_MODE_KEY)) return undefined;
  const mode = parsed[DELEGATION_MODE_KEY];
  if (mode !== "terminal" && mode !== "attenuable") {
    throw new Error(`ReCap ${DELEGATION_MODE_KEY} must be "terminal" or "attenuable"`);
  }
  return mode;
}
