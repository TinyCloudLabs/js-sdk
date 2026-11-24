import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FakeRegistry, KEY, OTHER_IDENTITY, fakeVerifier, integrityOf, lockfileFor, provenanceFor } from "../test-support/self-update-fakes.js";
import { lockedPackages, verifyCliRelease, verifyStagedTree, VerificationError } from "./provenance.js";

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof VerificationError ? error.code : `unexpected: ${(error as Error).message}`;
  }
}

describe("the CLI release itself", () => {
  test("a release signed by the Release workflow on master verifies", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    expect((await verifyCliRelease(registry, fakeVerifier, "1.9.5")).version).toBe("1.9.5");
  });

  test("a release without provenance (1.9.2 and older) is refused", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.2", { attested: false });
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.2"))).toBe("PROVENANCE_MISSING");
  });

  test("provenance signed by another repository or workflow is refused", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5", { identity: OTHER_IDENTITY });
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBe("PROVENANCE_INVALID");
  });

  test("provenance for a different tarball is refused", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    registry.attestationsById.set("@tinycloud/cli@1.9.5", [provenanceFor("@tinycloud/cli", "1.9.5", integrityOf("@tinycloud/cli", "1.9.6"))]);
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBe("PROVENANCE_INVALID");
  });

  test("a registry signature that does not verify is refused", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5", { badSignature: true });
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBe("SIGNATURE_INVALID");
  });

  test("a signature by a key that expired before the publish is refused; one made before expiry verifies", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    registry.keyList = [{ ...KEY, expires: "2026-01-01T00:00:00.000Z" }];
    registry.publishTimes.set("@tinycloud/cli@1.9.5", Date.parse("2026-06-01T00:00:00.000Z"));
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBe("SIGNATURE_INVALID");
    registry.publishTimes.set("@tinycloud/cli@1.9.5", Date.parse("2025-06-01T00:00:00.000Z"));
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBeUndefined();
  });

  test("a signature by a key the registry doesn't list is refused", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    registry.keyList = [{ keyid: "SHA256:other", key: other, expires: null }];
    expect(await codeOf(verifyCliRelease(registry, fakeVerifier, "1.9.5"))).toBe("SIGNATURE_INVALID");
  });
});

describe("the staged dependency tree", () => {
  async function tree(registry: FakeRegistry, packages: { name: string; version: string; integrity?: string; resolved?: string }[]) {
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.9.5");
    return verifyStagedTree(registry, fakeVerifier, lockedPackages(lockfileFor([{ name: "@tinycloud/cli", version: "1.9.5" }, ...packages])), cli);
  }

  test("a @tinycloud dependency with provenance from another identity refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("@tinycloud/sdk-core", "3.14.0", { identity: OTHER_IDENTITY });
    expect(await codeOf(tree(registry, [{ name: "@tinycloud/sdk-core", version: "3.14.0" }]))).toBe("PROVENANCE_INVALID");
  });

  test("a @tinycloud dependency without provenance but with a good registry signature is allowed and reported", async () => {
    const registry = new FakeRegistry()
      .publish("@tinycloud/cli", "1.9.5")
      .publish("@tinycloud/share-sdk", "1.6.0", { attested: false })
      .publish("@tinycloud/sdk-core", "3.14.0")
      .publish("chalk", "5.3.0");
    expect(await tree(registry, [
      { name: "@tinycloud/share-sdk", version: "1.6.0" },
      { name: "@tinycloud/sdk-core", version: "3.14.0" },
      { name: "chalk", version: "5.3.0" },
    ])).toEqual(["@tinycloud/share-sdk@1.6.0"]);
  });

  test("an unattested @tinycloud dependency with a bad registry signature refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("@tinycloud/share-sdk", "1.6.0", { attested: false, badSignature: true });
    expect(await codeOf(tree(registry, [{ name: "@tinycloud/share-sdk", version: "1.6.0" }]))).toBe("SIGNATURE_INVALID");
  });

  test("a third-party package with a bad registry signature refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("chalk", "5.3.0", { badSignature: true });
    expect(await codeOf(tree(registry, [{ name: "chalk", version: "5.3.0" }]))).toBe("SIGNATURE_INVALID");
  });

  test("an installed tarball that isn't the one the registry signed refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("chalk", "5.3.0");
    expect(await codeOf(tree(registry, [{ name: "chalk", version: "5.3.0", integrity: integrityOf("chalk", "6.6.6") }]))).toBe("SIGNATURE_INVALID");
  });

  test("a package from outside the npm registry refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("chalk", "5.3.0");
    expect(await codeOf(tree(registry, [{ name: "chalk", version: "5.3.0", resolved: "git+https://example.com/chalk.git" }]))).toBe("SIGNATURE_INVALID");
  });

  test("a tree that holds a different CLI than the verified release refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.9.5");
    const packages = lockedPackages(lockfileFor([{ name: "@tinycloud/cli", version: "1.9.5", integrity: integrityOf("@tinycloud/cli", "evil") }]));
    expect(await codeOf(verifyStagedTree(registry, fakeVerifier, packages, cli))).toBe("SIGNATURE_INVALID");
  });
});
