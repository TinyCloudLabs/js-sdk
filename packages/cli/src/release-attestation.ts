/**
 * The updater's Release-identity check, built for the CLI's prepack (scripts/release-shrinkwrap.mjs; TC-4276 D1,
 * Naomi): a `@tinycloud/*` version that the same Release run publishes must carry the Release workflow's provenance
 * before the CLI is published pinning it.
 */
import { npmRegistry, requireReleaseProvenance, sigstoreVerifier } from "./lib/provenance.js";

/** Resolves when npm's `name@version` carries provenance from the Release workflow; throws `VerificationError`. */
export function releaseAttestationVerifier(tufCachePath: string): (name: string, version: string) => Promise<void> {
  const registry = npmRegistry();
  const verifyBundle = sigstoreVerifier(tufCachePath);
  return (name, version) => requireReleaseProvenance(registry, verifyBundle, name, version);
}
