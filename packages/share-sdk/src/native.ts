/** Fragment-only adapter for TinyCloud's public SharingService. */
export const NATIVE_SHARE_FRAGMENT_PARAMETER = "tc1";

export interface NativeSharingService {
  generate(params: { readonly path: string; readonly actions: string[]; readonly expiry: Date }): Promise<unknown>;
  receive(token: string, options: { readonly autoSubdelegate: false; readonly useSessionKey: false }): Promise<unknown>;
  decodeLink(token: string): { readonly spaceId: string; readonly path: string };
}

function canonicalViewerUrl(viewerOrigin: string): URL {
  const url = new URL(viewerOrigin);
  if (url.protocol !== "https:" || url.origin !== viewerOrigin || url.pathname !== "/" || url.search || url.hash) throw new TypeError("viewer origin must be a canonical HTTPS origin");
  url.pathname = "/viewer";
  return url;
}

/** Generate exactly one read-only TinyCloud delegation and put its tc1 token in the fragment. */
export async function createNativeShare(sharing: NativeSharingService, input: { readonly path: string; readonly expiresAt: Date; readonly viewerOrigin: string }): Promise<{ readonly url: string; readonly delegationCid: string; readonly expiresAt: Date; readonly spaceId: string }> {
  if (!input.path || input.path.startsWith("/") || input.path.endsWith("/") || input.path.includes("..") || input.path.includes("//")) throw new TypeError("native share path must be one canonical TinyCloud KV key");
  const generated = await sharing.generate({ path: input.path, actions: ["tinycloud.kv/get"], expiry: input.expiresAt }) as { readonly ok?: unknown; readonly data?: { readonly token?: unknown; readonly delegation?: { readonly cid?: unknown }; readonly expiresAt?: unknown }; readonly error?: { readonly message?: unknown } };
  if (generated.ok !== true) throw new Error(typeof generated.error?.message === "string" ? generated.error.message : "TinyCloud sharing service rejected delegation generation");
  if (typeof generated.data?.token !== "string" || typeof generated.data.delegation?.cid !== "string" || !(generated.data.expiresAt instanceof Date)) throw new Error("TinyCloud sharing service returned incomplete delegation metadata");
  const delegation = sharing.decodeLink(generated.data.token);
  if (typeof delegation.spaceId !== "string" || delegation.spaceId.length === 0 || typeof delegation.path !== "string" || delegation.path.length === 0) throw new Error("TinyCloud sharing service returned a non-canonical delegation authority");
  const url = canonicalViewerUrl(input.viewerOrigin);
  url.hash = `${NATIVE_SHARE_FRAGMENT_PARAMETER}=${encodeURIComponent(generated.data.token)}`;
  return { url: url.toString(), delegationCid: generated.data.delegation.cid, expiresAt: generated.data.expiresAt, spaceId: delegation.spaceId };
}

/** Extract only a single tc1 fragment. Path/query/mixed legacy forms are refused. */
export function parseNativeShareUrl(value: string): string {
  const url = new URL(value);
  if (url.search || url.pathname !== "/viewer") throw new TypeError("native shares must carry tc1 only in the /viewer URL fragment");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get(NATIVE_SHARE_FRAGMENT_PARAMETER);
  // `token` is opaque output from SharingService.generate(). `tc1` names this
  // fragment format; the opaque token may itself begin with `tc1:`.
  if (!token || fragment.size !== 1) throw new TypeError("missing native share fragment");
  return token;
}

/** Receive through the public SDK without creating another transport protocol. */
export async function openNativeShare(sharing: NativeSharingService, link: string): Promise<unknown> {
  return sharing.receive(parseNativeShareUrl(link), { autoSubdelegate: false, useSessionKey: false });
}
