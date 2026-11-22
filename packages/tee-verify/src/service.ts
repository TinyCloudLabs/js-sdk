import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { refuse } from "./errors.js";
import { checkOpenkeyIdentity } from "./openkey.js";
import type { ServiceName, Trust } from "./trust.js";
import { serviceBinding, verifyAttestation, type Verified } from "./verify.js";

export interface VerifyServiceOptions {
  service?: ServiceName;
  /**
   * The signer you expect, matched exactly. Without it, the node's `/info`
   * `nodeId` is checked; OpenKey's attested identity is checked against
   * `<url>/api/auth/jwks` either way.
   */
  identity?: string;
  /**
   * OpenKey only: report served keys the quote does not cover instead of
   * refusing. For diagnosing a key rotation, never for trusting tokens.
   */
  allowUnattestedKeys?: boolean;
  trust?: Trust;
  fetch?: typeof fetch;
}

async function getJson(fetcher: typeof fetch, url: URL): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error" });
  } catch (error) {
    refuse("response", `${url.origin}${url.pathname} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status !== 200) refuse("response", `${url.origin}${url.pathname} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    refuse("response", `${url.origin}${url.pathname} did not return JSON`);
  }
}

/**
 * Asks the service at `baseUrl` for a quote over a fresh random nonce and
 * verifies it with `verifyAttestation`. For OpenKey, the attested identity must
 * also list only keys `<url>/api/auth/jwks` serves, and every served key, or
 * the result is refused (`checkOpenkeyIdentity`).
 */
export async function verifyService(
  baseUrl: string,
  options: VerifyServiceOptions = {},
): Promise<Verified & { unattestedKeys?: string[] }> {
  const service = options.service ?? "tinycloud-node";
  const fetcher = options.fetch ?? fetch;
  serviceBinding(service);
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    refuse("response", "use an https:// URL");
  }
  let identity = options.identity;
  let jwks: unknown;
  const issuer = new URL("/api/auth", base).href;
  if (service === "openkey") {
    jwks = await getJson(fetcher, new URL(`${issuer}/jwks`));
  } else if (identity === undefined) {
    const info = (await getJson(fetcher, new URL("/info", base))) as { nodeId?: unknown } | null;
    if (typeof info?.nodeId !== "string") refuse("response", "/info names no nodeId; pass the signer you expect");
    identity = info.nodeId;
  }
  const nonce = bytesToHex(randomBytes(32));
  const url = new URL("/attestation", base);
  url.searchParams.set("nonce", nonce);
  const response = await getJson(fetcher, url);
  const trust = options.trust ? { trust: options.trust } : {};
  if (service !== "openkey") return verifyAttestation(response, { service, nonce, identity: identity!, ...trust });
  // OpenKey: the binding is rebuilt from the identity it attests (or the one you
  // expect), which must cover exactly the keys it serves.
  const r = response as { identity?: unknown; excluded_keys?: unknown } | null;
  if (typeof r?.identity !== "string") refuse("response", "response has no identity");
  const { unattestedKeys } = checkOpenkeyIdentity(r.identity, issuer, jwks, {
    excludedKeys: r.excluded_keys,
    ...(options.allowUnattestedKeys ? { allowUnattestedKeys: true } : {}),
  });
  const verified = await verifyAttestation(response, { service, nonce, identity: identity ?? r.identity, ...trust });
  return unattestedKeys.length > 0 ? { ...verified, unattestedKeys } : verified;
}
