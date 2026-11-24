/**
 * The Release identity check against real npm provenance (TC-4276 F1), verified offline with sigstore's own verifier
 * and a pinned trust root. The identity is compared by exact equality: sigstore's SAN policy is an unanchored regex.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { FakeRegistry, derUtf8 } from "../test-support/self-update-fakes.js";
import {
  ProvenanceUnavailableError,
  RELEASE_IDENTITY,
  releaseIdentityMismatch,
  VerificationError,
  verifyProvenance,
  type BundleVerifier,
  type SignerIdentity,
} from "./provenance.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test-support/fixtures/sigstore/${name}`, import.meta.url), "utf8"));
const COURIER = { name: "@tinycloud/courier", version: "0.8.2", integrity: "sha512-LU2djD/HkQiNZECfRVUoCkvGqqQILKkwV4yAO4WovFI9iJg3+0H1R7Uiw6CVWllNdLOcMyR9ThcJgHUsM88MZA==" };
const SIGSTORE = { name: "sigstore", version: "4.1.1", integrity: "sha512-endqECJkfhozrXMK5ngu/UAA0xVcVEFdnHJCElGaExypjW+HK5i6zu3NteLoaX/iFbRUbC3+DjttQs0GARr+5w==" };
const BUNDLES = new Map<string, unknown>([
  [`${COURIER.name}@${COURIER.version}`, fixture("courier-0.8.2.provenance.json")],
  [`${SIGSTORE.name}@${SIGSTORE.version}`, fixture("sigstore-4.1.1.provenance.json")],
]);

/** sigstore's verifier (the modules the pinned `sigstore` uses), with no identity policy and an offline trust root. */
const offlineVerifier: BundleVerifier = (() => {
  const fromSigstore = createRequire(createRequire(import.meta.url).resolve("sigstore"));
  const { Verifier, toTrustMaterial, toSignedEntity } = fromSigstore("@sigstore/verify");
  const { bundleFromJSON } = fromSigstore("@sigstore/bundle");
  const { TrustedRoot } = fromSigstore("@sigstore/protobuf-specs");
  const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(fixture("trusted_root.json"))));
  return async (bundle) => verifier.verify(toSignedEntity(bundleFromJSON(bundle)), {}).identity as SignerIdentity;
})();

function registryWith(pkg: { name: string; version: string; integrity: string }): FakeRegistry {
  const registry = new FakeRegistry();
  registry.integrity = () => pkg.integrity;
  registry.publish(pkg.name, pkg.version);
  registry.attestationsById.set(`${pkg.name}@${pkg.version}`, [{ predicateType: "https://slsa.dev/provenance/v1", bundle: BUNDLES.get(`${pkg.name}@${pkg.version}`) }]);
  return registry;
}

async function verify(pkg: { name: string; version: string; integrity: string }, verifyBundle: BundleVerifier = offlineVerifier): Promise<string> {
  const registry = registryWith(pkg);
  try {
    return String(await verifyProvenance(registry, verifyBundle, await registry.manifest(pkg.name, pkg.version)));
  } catch (error) {
    if (error instanceof VerificationError) return error.code;
    throw error;
  }
}

/** The real Release workflow signer of @tinycloud/courier 0.8.2, with `change` applied after verification. */
function tampered(change: (identity: SignerIdentity) => SignerIdentity): BundleVerifier {
  return async (bundle) => change(await offlineVerifier(bundle));
}

function withOid(identity: SignerIdentity, last: number, value: string): SignerIdentity {
  return {
    ...identity,
    oids: (identity.oids ?? []).map((entry) => entry.oid?.id.join(".") === `1.3.6.1.4.1.57264.1.${last}` ? { ...entry, value: derUtf8(value) } : entry),
  };
}

describe("the Release identity, on real provenance", () => {
  test("a release the Release workflow on master signed verifies", async () => {
    expect(await verify(COURIER)).toBe("true");
    const signer = await offlineVerifier(BUNDLES.get(`${COURIER.name}@${COURIER.version}`));
    expect(releaseIdentityMismatch(signer)).toBeNull();
  });

  test("a valid bundle from another project's release workflow is refused", async () => {
    expect(await verify(SIGSTORE)).toBe("PROVENANCE_INVALID");
  });

  const lookalikes = [
    `${RELEASE_IDENTITY.certificateIdentityURI}-evil`,
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master2",
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master/x",
    "https://github.com/TinyCloudLabs/js-sdk-evil/.github/workflows/changesets.yml@refs/heads/master",
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/other.yml@refs/heads/master",
  ];
  for (const san of lookalikes) {
    test(`a certificate for ${san.slice("https://github.com/".length)} is refused`, async () => {
      // sigstore's own policy check (`signerIdentity.match(policyIdentity)`) would have accepted the first three.
      expect(await verify(COURIER, tampered((identity) => ({ ...identity, subjectAlternativeName: san })))).toBe("PROVENANCE_INVALID");
    });
  }

  test("another issuer, or a source repository, ref or repository id that differs, is refused", async () => {
    expect(await verify(COURIER, tampered((identity) => ({ ...identity, extensions: { issuer: "https://token.actions.githubusercontent.com.evil" } })))).toBe("PROVENANCE_INVALID");
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 12, "https://github.com/TinyCloudLabs/js-sdk-evil")))).toBe("PROVENANCE_INVALID");
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 14, "refs/heads/master-evil")))).toBe("PROVENANCE_INVALID");
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 15, "913991043")))).toBe("PROVENANCE_INVALID");
    expect(await verify(COURIER, tampered((identity) => ({ ...identity, oids: [] })))).toBe("PROVENANCE_INVALID");
  });

  test("a trust root that can't be fetched is PROVENANCE_UNAVAILABLE, not a verdict on the release", async () => {
    expect(await verify(COURIER, async () => { throw new ProvenanceUnavailableError(new Error("ENOTFOUND tuf-repo-cdn.sigstore.dev")); })).toBe("PROVENANCE_UNAVAILABLE");
  });
});
