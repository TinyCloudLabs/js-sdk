/** A fake npm registry, npm and launcher for the TC-4276 self-update tests. No network, no real install. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RELEASE_IDENTITY, REGISTRY, type Attestation, type BundleVerifier, type RegistryKey, type ReleaseRegistry, type VersionManifest } from "../lib/provenance.js";
import type { UpdaterDeps } from "../lib/self-update.js";
import { activeVersion, readPackageVersion, writeFileAtomic } from "../lib/versions.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const KEY: RegistryKey = { keyid: "SHA256:fake-registry-key", key: publicKey.export({ type: "spki", format: "der" }).toString("base64"), expires: null };
export const OTHER_IDENTITY = "https://github.com/someone-else/js-sdk/.github/workflows/changesets.yml@refs/heads/master";

export function integrityOf(name: string, version: string): string {
  return `sha512-${createHash("sha512").update(`${name}@${version} tarball`).digest("base64")}`;
}

export function signedManifest(name: string, version: string, integrity = integrityOf(name, version)): VersionManifest {
  const sig = sign("sha256", Buffer.from(`${name}@${version}:${integrity}`), privateKey).toString("base64");
  return { name, version, dist: { integrity, signatures: [{ keyid: KEY.keyid, sig }] } };
}

export function provenanceFor(name: string, version: string, integrity: string, identity: string = RELEASE_IDENTITY.certificateIdentityURI): Attestation {
  const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
  const sha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  const payload = Buffer.from(JSON.stringify({ subject: [{ name: purl, digest: { sha512 } }] })).toString("base64");
  return { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload }, identity } };
}

/** Stands in for sigstore: the fake bundle names its signer, and the policy must match it. */
export const fakeVerifier: BundleVerifier = async (bundle, policy) => {
  const identity = bundle && typeof bundle === "object" && "identity" in bundle ? bundle.identity : undefined;
  if (identity !== policy.certificateIdentityURI) throw new Error(`certificate identity error - expected ${policy.certificateIdentityURI}, got ${String(identity)}`);
};

export interface PublishOptions { attested?: boolean; identity?: string; badSignature?: boolean }

export class FakeRegistry implements ReleaseRegistry {
  readonly manifests = new Map<string, VersionManifest>();
  readonly attestationsById = new Map<string, Attestation[]>();
  tags: Record<string, string> = {};
  /** Third-party and `@tinycloud/*` packages every staged CLI tree contains. */
  tree: { name: string; version: string }[] = [{ name: "chalk", version: "5.3.0" }];
  keyList: RegistryKey[] = [KEY];
  publishTimes = new Map<string, number>();

  publish(name: string, version: string, options: PublishOptions = {}): this {
    const manifest = signedManifest(name, version);
    if (options.badSignature) manifest.dist.signatures = [{ keyid: KEY.keyid, sig: signedManifest(name, `${version}-other`).dist.signatures![0].sig }];
    this.manifests.set(`${name}@${version}`, manifest);
    if (options.attested ?? name.startsWith("@tinycloud/")) {
      this.attestationsById.set(`${name}@${version}`, [provenanceFor(name, version, manifest.dist.integrity, options.identity)]);
    }
    return this;
  }

  async manifest(name: string, version: string): Promise<VersionManifest> {
    const manifest = this.manifests.get(`${name}@${version}`);
    if (!manifest) throw new Error(`${REGISTRY}/${name}/${version} returned 404`);
    return structuredClone(manifest);
  }

  async attestations(name: string, version: string): Promise<Attestation[] | null> {
    return this.attestationsById.get(`${name}@${version}`) ?? null;
  }

  async keys(): Promise<RegistryKey[]> {
    return this.keyList;
  }

  async publishedAt(name: string, version: string): Promise<number> {
    return this.publishTimes.get(`${name}@${version}`) ?? 0;
  }

  async distTags(): Promise<Record<string, string>> {
    return { ...this.tags };
  }
}

export function lockfileFor(packages: { name: string; version: string; integrity?: string; resolved?: string }[]): unknown {
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: {} },
      ...Object.fromEntries(packages.map((entry) => [`node_modules/${entry.name}`, {
        version: entry.version,
        resolved: entry.resolved ?? `${REGISTRY}/${entry.name}/-/${entry.name.split("/").pop()}-${entry.version}.tgz`,
        integrity: entry.integrity ?? integrityOf(entry.name, entry.version),
      }])),
    },
  };
}

export interface FakeUpdater {
  deps: UpdaterDeps;
  registry: FakeRegistry;
  dir: string;
  clock: { now: number };
  staged: string[];
  logs: string[];
  /** Versions whose staged copy fails its smoke test. */
  smokeFails: Set<string>;
  /** How many launcher checks (after a switch) report the wrong version. */
  launcherFailures: { count: number };
  /** Pids the fake process table says are running. */
  alive: Set<number>;
  /** Resolves a staged install only when released, to hold the lock open. */
  holdStage?: Promise<void>;
  /** Called when a staged install starts. */
  onStage?: () => void;
  active(): string;
  lease(pid: number, version: string, courier: boolean): void;
}

export function fakeUpdater(baseVersion: string, registry: FakeRegistry = new FakeRegistry()): FakeUpdater {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-updater-"));
  const root = join(dir, "versions");
  const packageDir = join(dir, "global", "lib", "node_modules", "@tinycloud", "cli");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: baseVersion }));
  const fake: FakeUpdater = {
    registry,
    dir,
    clock: { now: Date.UTC(2026, 10, 25) },
    staged: [],
    logs: [],
    smokeFails: new Set(),
    launcherFailures: { count: 0 },
    alive: new Set([process.pid]),
    active: () => activeVersion(root, packageDir, baseVersion).version,
    lease(pid, version, courier) {
      writeFileAtomic(join(root, ".leases", `${pid}.json`), JSON.stringify({ pid, version, courier }));
    },
    deps: undefined as unknown as UpdaterDeps,
  };
  fake.deps = {
    root,
    base: { version: baseVersion, packageDir, bin: join(packageDir, "bin", "tinycloud") },
    now: () => fake.clock.now,
    registry,
    verifyBundle: fakeVerifier,
    async stage(directory, version) {
      fake.staged.push(version);
      fake.onStage?.();
      await fake.holdStage;
      const cli = join(directory, "node_modules", "@tinycloud", "cli");
      mkdirSync(join(cli, "dist"), { recursive: true });
      mkdirSync(join(cli, "bin"), { recursive: true });
      writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version }));
      writeFileSync(join(cli, "dist", "launcher.js"), "");
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lockfileFor([
        { name: "@tinycloud/cli", version, integrity: (await registry.manifest("@tinycloud/cli", version)).dist.integrity },
        ...registry.tree,
      ])));
    },
    async run(bin, args) {
      if (bin === fake.deps.base.bin) {
        if (fake.launcherFailures.count > 0) {
          fake.launcherFailures.count -= 1;
          return { code: 1, stdout: "" };
        }
        return { code: 0, stdout: `${fake.active()}\n` };
      }
      const version = readPackageVersion(dirname(dirname(bin)));
      if (!version || fake.smokeFails.has(version)) return { code: 1, stdout: "" };
      return { code: 0, stdout: args[0] === "--version" ? `${version}\n` : "" };
    },
    log: (line) => fake.logs.push(line),
    alive: (pid) => fake.alive.has(pid),
  };
  return fake;
}
