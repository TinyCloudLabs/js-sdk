import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FakeRegistry, KEY, OTHER_IDENTITY, fakeVerifier, integrityOf, lockfileFor, provenanceFor, tarballOf, type LockEntry } from "../test-support/self-update-fakes.js";
import { checkResolvedAgainstShrinkwrap, lockedPackages, releaseShrinkwrap, verifyCliRelease, verifyStagedTree, VerificationError } from "./provenance.js";
import { readTarballFiles } from "./tarball.js";

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
  async function tree(registry: FakeRegistry, packages: LockEntry[]) {
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.9.5");
    return verifyStagedTree(registry, fakeVerifier, lockedPackages(lockfileFor([{ name: "@tinycloud/cli", version: "1.9.5", integrity: cli.dist.integrity }, ...packages])), cli);
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
    expect(await codeOf(tree(registry, [{ name: "chalk", version: "5.3.0", resolved: "git+https://example.com/chalk.git" }]))).toBe("DEPENDENCY_NOT_FROM_REGISTRY");
  });

  test("a second entry for the same package version with another integrity is checked too", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5").publish("chalk", "5.3.0");
    expect(await codeOf(tree(registry, [
      { name: "chalk", version: "5.3.0" },
      { name: "chalk", version: "5.3.0", integrity: integrityOf("chalk", "decoy"), path: "node_modules/other/node_modules/chalk" },
    ]))).toBe("SIGNATURE_INVALID");
  });

  test("a tree that holds a different CLI than the verified release refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.9.5");
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.9.5");
    const packages = lockedPackages(lockfileFor([{ name: "@tinycloud/cli", version: "1.9.5", integrity: integrityOf("@tinycloud/cli", "evil") }]));
    expect(await codeOf(verifyStagedTree(registry, fakeVerifier, packages, cli))).toBe("SIGNATURE_INVALID");
  });
});

describe("dependencies that aren't registry tarballs", () => {
  const notFromRegistry: [string, Record<string, unknown>][] = [
    ["git", { version: "1.0.0", resolved: "git+ssh://git@github.com/evil/dep.git#0123456789abcdef0123456789abcdef01234567" }],
    ["a tarball URL", { version: "1.0.0", resolved: "https://evil.example/dep-1.0.0.tgz", integrity: integrityOf("dep", "1.0.0") }],
    ["a file", { version: "1.0.0", resolved: "file:../dep" }],
    ["a link", { resolved: "../dep", link: true }],
    ["another package's registry tarball (an alias)", { name: "dep", version: "1.0.0", resolved: "https://registry.npmjs.org/not-dep/-/not-dep-1.0.0.tgz", integrity: integrityOf("dep", "1.0.0") }],
    ["a registry URL with a query", { version: "1.0.0", resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz?x=1", integrity: integrityOf("dep", "1.0.0") }],
    ["a lookalike registry host", { version: "1.0.0", resolved: "https://registry.npmjs.org.evil.example/dep/-/dep-1.0.0.tgz", integrity: integrityOf("dep", "1.0.0") }],
  ];
  for (const [kind, entry] of notFromRegistry) {
    test(`${kind} refuses`, () => {
      const lockfile = { lockfileVersion: 3, packages: { "": {}, "node_modules/dep": entry } };
      let code: string | undefined;
      try {
        lockedPackages(lockfile);
      } catch (error) {
        code = (error as VerificationError).code;
      }
      expect(code).toBe("DEPENDENCY_NOT_FROM_REGISTRY");
    });
  }

  test("the release's shrinkwrap is read from its verified tarball; a git dependency in it refuses", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.10.0", {
      shrinkwrap: lockfileFor([{ name: "chalk", version: "5.3.0" }, { name: "dep", version: "1.0.0", resolved: "git+https://github.com/evil/dep.git#abc" }]),
    });
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.10.0");
    expect(await codeOf(releaseShrinkwrap(registry, cli))).toBe("DEPENDENCY_NOT_FROM_REGISTRY");
  });

  test("a downloaded tarball that isn't the signed one refuses before its shrinkwrap is read", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.10.0");
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.10.0");
    registry.tarball = async () => tarballOf({ "package.json": "{}", "npm-shrinkwrap.json": JSON.stringify(lockfileFor([])) });
    expect(await codeOf(releaseShrinkwrap(registry, cli))).toBe("SIGNATURE_INVALID");
  });

  test("the resolved lockfile must hold exactly the shrinkwrap's packages and the CLI", async () => {
    const registry = new FakeRegistry().publish("@tinycloud/cli", "1.10.0");
    const cli = await verifyCliRelease(registry, fakeVerifier, "1.10.0");
    const shrinkwrap = (await releaseShrinkwrap(registry, cli))!;
    expect(shrinkwrap.map((entry) => `${entry.name}@${entry.version}`)).toEqual(["chalk@5.3.0"]);
    const self = { name: "@tinycloud/cli", version: "1.10.0", integrity: cli.dist.integrity };
    const resolved = (entries: LockEntry[]) => lockedPackages(lockfileFor([self, ...entries]));
    expect(() => checkResolvedAgainstShrinkwrap(resolved([{ name: "chalk", version: "5.3.0", path: "node_modules/@tinycloud/cli/node_modules/chalk" }]), shrinkwrap, cli)).not.toThrow();
    expect(() => checkResolvedAgainstShrinkwrap(resolved([{ name: "chalk", version: "5.3.0" }, { name: "left-pad", version: "1.3.0" }]), shrinkwrap, cli)).toThrow(VerificationError);
    expect(() => checkResolvedAgainstShrinkwrap(resolved([{ name: "chalk", version: "5.3.1" }]), shrinkwrap, cli)).toThrow(VerificationError);
    expect(() => checkResolvedAgainstShrinkwrap(resolved([]), shrinkwrap, cli)).toThrow(VerificationError);
  });

  test("tarball entries are read by their path below the package directory", () => {
    const files = readTarballFiles(tarballOf({ "package.json": "{}", "npm-shrinkwrap.json": "first", "dist/npm-shrinkwrap.json": "nested" }), ["npm-shrinkwrap.json"]);
    expect(files.get("npm-shrinkwrap.json")?.toString()).toBe("first");
    expect(files.size).toBe(1);
  });
});
