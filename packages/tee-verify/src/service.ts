import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { refuse } from "./errors.js";
import { openkeyIdentity } from "./openkey.js";
import type { ServiceName, Trust } from "./trust.js";
import { serviceBinding, verifyAttestation, type Verified } from "./verify.js";

export interface VerifyServiceOptions {
  service?: ServiceName;
  /**
   * The signer you expect. Without it, the node's `/info` `nodeId`, or for
   * OpenKey the identity computed from `<url>/api/auth/jwks`, is checked.
   */
  identity?: string;
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
 * verifies it with `verifyAttestation`.
 */
export async function verifyService(baseUrl: string, options: VerifyServiceOptions = {}): Promise<Verified> {
  const service = options.service ?? "tinycloud-node";
  const fetcher = options.fetch ?? fetch;
  serviceBinding(service);
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    refuse("response", "use an https:// URL");
  }
  let identity = options.identity;
  if (identity === undefined && service === "openkey") {
    const issuer = new URL("/api/auth", base).href;
    identity = openkeyIdentity(issuer, await getJson(fetcher, new URL(`${issuer}/jwks`)));
  } else if (identity === undefined) {
    const info = (await getJson(fetcher, new URL("/info", base))) as { nodeId?: unknown } | null;
    if (typeof info?.nodeId !== "string") refuse("response", "/info names no nodeId; pass the signer you expect");
    identity = info.nodeId;
  }
  const nonce = bytesToHex(randomBytes(32));
  const url = new URL("/attestation", base);
  url.searchParams.set("nonce", nonce);
  const response = await getJson(fetcher, url);
  return verifyAttestation(response, { service, nonce, identity, ...(options.trust ? { trust: options.trust } : {}) });
}
