/**
 * The Release identity check against real npm provenance (TC-4276 F1), verified offline with sigstore's own verifier
 * (in a Node child; see offline-sigstore.ts) and a pinned trust root. The identity is compared by exact equality:
 * sigstore's SAN policy is an unanchored regex.
 */
import { describe, expect, test } from "bun:test";
import { BUNDLES, COURIER, SIGSTORE, offlineVerifier } from "../test-support/offline-sigstore.js";
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

function registryWith(pkg: { name: string; version: string; integrity: string }): FakeRegistry {
  const registry = new FakeRegistry();
  registry.integrity = () => pkg.integrity;
  registry.publish(pkg.name, pkg.version);
  registry.attestationsById.set(`${pkg.name}@${pkg.version}`, [{ predicateType: "https://slsa.dev/provenance/v1", bundle: BUNDLES.get(`${pkg.name}@${pkg.version}`) }]);
  return registry;
}

/** "true" when `pkg` verifies; otherwise the refusal's code and message, so each case shows which check refused it. */
async function verify(pkg: { name: string; version: string; integrity: string }, verifyBundle: BundleVerifier = offlineVerifier): Promise<string> {
  const registry = registryWith(pkg);
  try {
    return String(await verifyProvenance(registry, verifyBundle, await registry.manifest(pkg.name, pkg.version)));
  } catch (error) {
    if (error instanceof VerificationError) return `${error.code}: ${error.message}`;
    throw error;
  }
}

/** The refusal of courier 0.8.2 for an identity mismatch: the bundle verified, its signer is not the Release workflow. */
const identityRefusal = (reason: string) => `PROVENANCE_INVALID: ${COURIER.name}@${COURIER.version}: provenance ${reason}`;

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

  test("a valid bundle from another project's release workflow is refused for its signer", async () => {
    expect(await verify(SIGSTORE)).toBe(
      `PROVENANCE_INVALID: ${SIGSTORE.name}@${SIGSTORE.version}: provenance signed by "https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main", not the Release workflow`,
    );
  });

  test("a bundle whose transparency-log promise doesn't verify is refused before any identity is read", async () => {
    const bundle = structuredClone(BUNDLES.get(`${COURIER.name}@${COURIER.version}`)) as { verificationMaterial: { tlogEntries: { inclusionPromise: { signedEntryTimestamp: string } }[] } };
    const entry = bundle.verificationMaterial.tlogEntries[0]!;
    const set = Buffer.from(entry.inclusionPromise.signedEntryTimestamp, "base64");
    set[set.length - 1] ^= 1;
    entry.inclusionPromise.signedEntryTimestamp = set.toString("base64");
    expect(await verify(COURIER, async () => offlineVerifier(bundle))).toStartWith(
      `PROVENANCE_INVALID: ${COURIER.name}@${COURIER.version}: provenance does not verify: TLOG_INCLUSION_PROMISE_ERROR: inclusion promise could not be verified`,
    );
  });

  const lookalikes = [
    `${RELEASE_IDENTITY.certificateIdentityURI}-evil`,
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master2",
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master/x",
    "https://github.com/TinyCloudLabs/js-sdk-evil/.github/workflows/changesets.yml@refs/heads/master",
    "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/other.yml@refs/heads/master",
  ];
  for (const san of lookalikes) {
    test(`a certificate for ${san.slice("https://github.com/".length)} is refused for its signer`, async () => {
      // sigstore's own policy check (`signerIdentity.match(policyIdentity)`) would have accepted the first three.
      expect(await verify(COURIER, tampered((identity) => ({ ...identity, subjectAlternativeName: san })))).toBe(
        identityRefusal(`signed by ${JSON.stringify(san)}, not the Release workflow`),
      );
    });
  }

  test("another issuer, or a source repository, ref or repository id that differs, is refused for that field", async () => {
    expect(await verify(COURIER, tampered((identity) => ({ ...identity, extensions: { issuer: "https://token.actions.githubusercontent.com.evil" } })))).toBe(
      identityRefusal(`issuer "https://token.actions.githubusercontent.com.evil"`),
    );
    const extension = (last: number, found: string[], expected: string) =>
      identityRefusal(`certificate extension 1.3.6.1.4.1.57264.1.${last} is ${JSON.stringify(found)}, not ${JSON.stringify(expected)}`);
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 12, "https://github.com/TinyCloudLabs/js-sdk-evil")))).toBe(
      extension(12, ["https://github.com/TinyCloudLabs/js-sdk-evil"], "https://github.com/TinyCloudLabs/js-sdk"),
    );
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 14, "refs/heads/master-evil")))).toBe(extension(14, ["refs/heads/master-evil"], "refs/heads/master"));
    expect(await verify(COURIER, tampered((identity) => withOid(identity, 15, "913991043")))).toBe(extension(15, ["913991043"], "913991042"));
    expect(await verify(COURIER, tampered((identity) => ({ ...identity, oids: [] })))).toBe(extension(12, [], "https://github.com/TinyCloudLabs/js-sdk"));
  });

  test("a trust root that can't be fetched is PROVENANCE_UNAVAILABLE, not a verdict on the release", async () => {
    expect(await verify(COURIER, async () => { throw new ProvenanceUnavailableError(new Error("ENOTFOUND tuf-repo-cdn.sigstore.dev")); })).toStartWith("PROVENANCE_UNAVAILABLE: ");
  });
});
