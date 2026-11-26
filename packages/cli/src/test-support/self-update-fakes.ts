/** A fake npm registry, npm and launcher for the TC-4276 self-update tests. No network, no real install. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { RELEASE_IDENTITY, REGISTRY, type Attestation, type BundleVerifier, type RegistryKey, type ReleaseRegistry, type SignerIdentity, type VersionManifest } from "../lib/provenance.js";
import type { UpdaterDeps } from "../lib/self-update.js";
import { activeVersion, CLI_PACKAGE, readPackageVersion, writeFileAtomic } from "../lib/versions.js";

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

/** A Fulcio extension value as the certificate carries it: a DER UTF8String. */
export function derUtf8(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([0x0c, ...length]), body]);
}

/** The signer identity of a Release workflow certificate whose SAN is `san`. */
export function releaseSigner(san: string = RELEASE_IDENTITY.certificateIdentityURI): SignerIdentity {
  const oid = (last: number, value: string) => ({ oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, last] }, value: derUtf8(value) });
  return {
    subjectAlternativeName: san,
    extensions: { issuer: RELEASE_IDENTITY.certificateIssuer },
    oids: [
      oid(12, RELEASE_IDENTITY.sourceRepositoryURI),
      oid(14, RELEASE_IDENTITY.sourceRepositoryRef),
      oid(15, RELEASE_IDENTITY.sourceRepositoryId),
    ],
  };
}

/** Stands in for sigstore: the fake bundle names its signer's SAN; the rest of the certificate is the Release workflow's. */
export const fakeVerifier: BundleVerifier = async (bundle) => {
  const identity = bundle && typeof bundle === "object" && "identity" in bundle ? bundle.identity : undefined;
  if (typeof identity !== "string") throw new Error("bundle does not verify");
  return releaseSigner(identity);
};

/** A gzipped npm tarball holding `files` under `package/`. */
export function tarballOf(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

export interface LockEntry { name: string; version: string; integrity?: string; resolved?: string; path?: string; dev?: boolean }

export interface FakeLockfile { lockfileVersion: number; packages: Record<string, Record<string, unknown>> }

export function lockfileFor(packages: LockEntry[]): FakeLockfile {
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: {} },
      ...Object.fromEntries(packages.map((entry) => [entry.path ?? `node_modules/${entry.name}`, {
        ...(entry.path ? { name: entry.name } : {}),
        version: entry.version,
        resolved: entry.resolved ?? `${REGISTRY}/${entry.name}/-/${entry.name.split("/").pop()}-${entry.version}.tgz`,
        integrity: entry.integrity ?? integrityOf(entry.name, entry.version),
        ...(entry.dev ? { dev: true } : {}),
      }])),
    },
  };
}

export interface PublishOptions {
  attested?: boolean;
  identity?: string;
  badSignature?: boolean;
  /** CLI releases only: the tarball's `npm-shrinkwrap.json`; default: the registry's `tree`; `false`: none. */
  shrinkwrap?: unknown;
}

export class FakeRegistry implements ReleaseRegistry {
  readonly published = new Map<string, PublishOptions>();
  /** Overrides of the attestations `publish` derives. */
  readonly attestationsById = new Map<string, Attestation[]>();
  tags: Record<string, string> = {};
  /** Third-party and `@tinycloud/*` packages every CLI release pins in its shrinkwrap. */
  tree: LockEntry[] = [{ name: "chalk", version: "5.3.0" }];
  keyList: RegistryKey[] = [KEY];
  publishTimes = new Map<string, number>();

  publish(name: string, version: string, options: PublishOptions = {}): this {
    this.published.set(`${name}@${version}`, options);
    return this;
  }

  /** The release's npm-shrinkwrap.json, built from the tree as it is now. */
  shrinkwrapOf(version: string): unknown {
    const options = this.published.get(`${CLI_PACKAGE}@${version}`);
    if (options?.shrinkwrap !== undefined) return options.shrinkwrap;
    return lockfileFor(this.tree);
  }

  cliTarball(version: string): Uint8Array {
    const shrinkwrap = this.shrinkwrapOf(version);
    return tarballOf({
      "package.json": JSON.stringify({ name: CLI_PACKAGE, version }),
      ...(shrinkwrap === false ? {} : { "npm-shrinkwrap.json": JSON.stringify(shrinkwrap) }),
    });
  }

  integrity(name: string, version: string): string {
    return name === CLI_PACKAGE
      ? `sha512-${createHash("sha512").update(this.cliTarball(version)).digest("base64")}`
      : integrityOf(name, version);
  }

  async manifest(name: string, version: string): Promise<VersionManifest> {
    const options = this.published.get(`${name}@${version}`);
    if (!options) throw new Error(`${REGISTRY}/${name}/${version} returned 404`);
    const manifest = signedManifest(name, version, this.integrity(name, version));
    if (options.badSignature) manifest.dist.signatures = [{ keyid: KEY.keyid, sig: signedManifest(name, `${version}-other`).dist.signatures![0].sig }];
    return manifest;
  }

  async attestations(name: string, version: string): Promise<Attestation[] | null> {
    const id = `${name}@${version}`;
    const override = this.attestationsById.get(id);
    if (override) return override;
    const options = this.published.get(id);
    if (!options || !(options.attested ?? name.startsWith("@tinycloud/"))) return null;
    return [provenanceFor(name, version, this.integrity(name, version), options.identity)];
  }

  async keys(): Promise<RegistryKey[]> {
    return this.keyList;
  }

  async publishedAt(name: string, version: string): Promise<number> {
    return this.publishTimes.get(`${name}@${version}`) ?? 0;
  }

  async tarball(name: string, version: string): Promise<Uint8Array> {
    if (name !== CLI_PACKAGE || !this.published.has(`${name}@${version}`)) throw new Error(`${name}@${version} tarball returned 404`);
    return this.cliTarball(version);
  }

  async distTags(): Promise<Record<string, string>> {
    return { ...this.tags };
  }
}

export interface FakeUpdater {
  deps: UpdaterDeps;
  registry: FakeRegistry;
  dir: string;
  clock: { now: number };
  /** Versions npm resolved a staging lockfile for. */
  staged: string[];
  /** Versions npm installed (`npm ci`) into a staging directory. */
  installed: string[];
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
  /** Runs after the fake `npm ci`, to tamper with what it installed. */
  afterInstall?: (directory: string) => void;
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
    installed: [],
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
    async resolve(directory, version) {
      fake.staged.push(version);
      fake.onStage?.();
      await fake.holdStage;
      // As `npm install --package-lock-only` honouring the release's shrinkwrap: the CLI plus its pinned tree.
      const shrinkwrap = registry.shrinkwrapOf(version) as FakeLockfile;
      const lock = lockfileFor([{ name: CLI_PACKAGE, version, integrity: registry.integrity(CLI_PACKAGE, version) }]);
      for (const [path, entry] of Object.entries(shrinkwrap.packages)) if (path !== "") lock.packages[path] = entry;
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, dependencies: { [CLI_PACKAGE]: version } }));
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));
    },
    async install(directory) {
      const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8")) as FakeLockfile;
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (path === "" || entry.dev === true) continue;
        const name = typeof entry.name === "string" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
        mkdirSync(join(directory, path), { recursive: true });
        writeFileSync(join(directory, path, "package.json"), JSON.stringify({ name, version: entry.version }));
        if (name === CLI_PACKAGE) {
          fake.installed.push(String(entry.version));
          mkdirSync(join(directory, path, "dist"), { recursive: true });
          mkdirSync(join(directory, path, "bin"), { recursive: true });
          writeFileSync(join(directory, path, "dist", "launcher.js"), "");
        }
      }
      writeFileSync(join(directory, "node_modules", ".package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => path !== "" && entry.dev !== true)),
      }));
      fake.afterInstall?.(directory);
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
