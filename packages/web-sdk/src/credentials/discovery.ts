import {
  CredentialError,
  canonicalDigest,
  descriptorSatisfiesRequirement,
  validateCredentialFlowDescriptor,
  type CredentialFlowDescriptor,
  type CredentialRequirement,
} from "@tinycloud/sdk-core";

/**
 * Fetch an OpenCredentials catalog and return the first enabled, ready profile
 * whose descriptor satisfies the requirement and matches its catalog digest.
 * Shared by the browser service and the headless email-proof helper.
 */
export async function discoverCatalogDescriptor(
  requirement: CredentialRequirement,
  discoveryUrl: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<CredentialFlowDescriptor> {
  let url: URL; try { url = new URL(discoveryUrl); } catch { throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is invalid"); }
  if (url.protocol !== "https:" || !["/.well-known/opencredentials", "/v1/credential-types"].includes(url.pathname) || url.search || url.hash) throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is not an allowed catalog endpoint");
  let response: Response;
  try { response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal }); } catch (cause) { throw new CredentialError("OFFLINE", "Credential discovery is unavailable", { cause }); }
  if (!response.ok) throw new CredentialError(response.status === 503 ? "ISSUER_UNREADY" : "OFFLINE", "Credential discovery is unavailable");
  const catalog = await response.json() as Record<string, unknown>;
  if (catalog.type !== "tinycloud.credentials/catalog/v1" || catalog.protocol !== "tinycloud.credentials/acquisition/v1" || catalog.catalogVersion !== 1 || !Array.isArray(catalog.profiles)) throw new CredentialError("DESCRIPTOR_INVALID", "Credential catalog is invalid");
  for (const entryValue of catalog.profiles) {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) continue;
    const entry = entryValue as Record<string, unknown>;
    if (entry.supported !== true || entry.enabled !== true || (entry.readiness !== "ready" && entry.readiness !== "degraded")) continue;
    try { const candidate = validateCredentialFlowDescriptor(entry.descriptor); if (descriptorSatisfiesRequirement(candidate, requirement) && entry.descriptorDigest === await canonicalDigest(candidate)) return candidate; } catch { /* malformed catalog entry: skip */ }
  }
  throw new CredentialError("UNSUPPORTED_PROFILE", "No available credential profile satisfies the requirement");
}
