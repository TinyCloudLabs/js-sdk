import { err, ErrorCodes, serviceError } from "../../types";
import { kvPrefixCovers } from "./scope";
import type { KVListPage } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function utf8Compare(a: string, b: string): number {
  const x = encoder.encode(a), y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function encodeTcr1(space: string, path: string, last: string): string {
  const bytes = encoder.encode(JSON.stringify({ v: 1, space, path, last }));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const payload = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `tcr1.${payload}`;
}
export function decodeTcr1(cursor: string): { v: 1; space: string; path: string; last: string } | null {
  try {
    const encoded = cursor.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const x = JSON.parse(decoder.decode(bytes));
    return x?.v === 1 && typeof x.space === "string" && typeof x.path === "string" && typeof x.last === "string" ? x : null;
  } catch { return null; }
}
export function cursorRestart() {
  return err(serviceError(ErrorCodes.INVALID_INPUT, "Local list cursor cannot be served; restart without the cursor", "kv", { meta: { replication: "cursor_restart" } }));
}
export function localList(handle: { list(o: { prefix: string; after?: string; limit?: number }): Promise<{ keys: string[] }> }, space: string, path: string, limit: number | undefined, cursor: string | undefined): Promise<KVListPage> {
  const after = cursor ? decodeTcr1(cursor)?.last : undefined;
  const exact = !path.endsWith("/") && (after === undefined || utf8Compare(path, after) > 0)
    ? (awaitExact(handle, path, after)) : Promise.resolve(false);
  return exact.then(async (hasExact) => {
    const child = path.endsWith("/") ? path : `${path}/`;
    const want = limit === undefined ? undefined : limit + 1 - (hasExact ? 1 : 0);
    const children = await handle.list({ prefix: child, after, limit: want });
    let keys = (hasExact ? [path] : []).concat(children.keys);
    const truncated = limit !== undefined && keys.length > limit;
    if (truncated) keys = keys.slice(0, limit);
    return { keys, truncated: truncated, ...(truncated ? { nextCursor: encodeTcr1(space, path, keys[keys.length - 1]!) } : {}) };
  });
}
async function awaitExact(handle: { list(o: { prefix: string; after?: string; limit?: number }): Promise<{ keys: string[] }> }, path: string, after: string | undefined): Promise<boolean> {
  if (after !== undefined && utf8Compare(path, after) <= 0) return false;
  return (await handle.list({ prefix: path, limit: 1 })).keys[0] === path;
}
export function listPathCovered(prefixes: readonly string[], path: string): string | undefined {
  const covering = prefixes.filter((p) => kvPrefixCovers(p, path));
  return covering.length === 1 ? covering[0] : undefined;
}
