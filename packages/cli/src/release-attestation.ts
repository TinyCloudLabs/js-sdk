/**
 * The updater's Release-identity check, built for the CLI's prepack (scripts/release-shrinkwrap.mjs; TC-4276 F1 (b),
 * Naomi 21:34Z): every `@tinycloud/*` version the CLI pins must carry the Release workflow's provenance unless it is
 * on the committed list of unattested versions.
 */
import { npmRegistry, requireReleaseProvenance, sigstoreVerifier } from "./lib/provenance.js";

/** Resolves when npm's `name@version` is `integrity` and carries provenance from the Release workflow; throws `VerificationError`. */
export function releaseAttestationVerifier(tufCachePath: string): (name: string, version: string, integrity: string) => Promise<void> {
  const registry = npmRegistry();
  const verifyBundle = sigstoreVerifier(tufCachePath);
  return (name, version, integrity) => requireReleaseProvenance(registry, verifyBundle, name, version, integrity);
}
