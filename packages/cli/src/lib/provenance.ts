/**
 * Release verification for self-update (TC-4276).
 *
 * - Every package in a staged tree must carry a valid npm registry signature (ECDSA over `name@version:integrity`),
 *   and the lockfile integrity must equal the signed one.
 * - The CLI itself must carry a SLSA provenance attestation signed by TinyCloudLabs/js-sdk's Release workflow on master.
 * - Any other `@tinycloud/*` package that has an attestation must carry the same identity; one without is allowed and
 *   reported (TC-4278 republishes the last unattested ones).
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readTarballFiles } from "./tarball.js";
import { CLI_PACKAGE } from "./versions.js";

export const REGISTRY = "https://registry.npmjs.org";
/**
 * The Release workflow's Fulcio certificate identity. Every field is compared for exact equality with the verified
 * certificate (Naomi, TC-4276): no pattern matching, because sigstore's own SAN policy is a regex and would accept
 * `…@refs/heads/master-evil`.
 */
export const RELEASE_IDENTITY = {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master",
  /** Fulcio extensions 1.3.6.1.4.1.57264.1.12 / .14 / .15: source repository URI, ref and (rename-proof) id. */
  sourceRepositoryURI: "https://github.com/TinyCloudLabs/js-sdk",
  sourceRepositoryRef: "refs/heads/master",
  sourceRepositoryId: "913991042",
} as const;
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const FULCIO_SOURCE_OIDS = {
  "1.3.6.1.4.1.57264.1.12": RELEASE_IDENTITY.sourceRepositoryURI,
  "1.3.6.1.4.1.57264.1.14": RELEASE_IDENTITY.sourceRepositoryRef,
  "1.3.6.1.4.1.57264.1.15": RELEASE_IDENTITY.sourceRepositoryId,
} as const;

export type VerificationCode =
  | "PROVENANCE_MISSING"
  | "PROVENANCE_INVALID"
  | "PROVENANCE_UNAVAILABLE"
  | "SIGNATURE_INVALID"
  | "DEPENDENCY_NOT_FROM_REGISTRY";

export class VerificationError extends Error {
  constructor(readonly code: VerificationCode, readonly packageId: string, detail: string) {
    super(`${packageId}: ${detail}`);
    this.name = "VerificationError";
  }
}

/** Sigstore's trust root or transparency data couldn't be fetched: nothing was verified either way. */
export class ProvenanceUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`sigstore trust root unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProvenanceUnavailableError";
  }
}

export interface RegistryKey { keyid: string; key: string; expires: string | null }
export interface VersionManifest {
  name: string;
  version: string;
  dist: { integrity: string; signatures?: { keyid: string; sig: string }[]; attestations?: unknown };
}
export interface Attestation { predicateType: string; bundle: unknown }

/** The registry calls verification needs; tests pass a fake. */
export interface ReleaseRegistry {
  manifest(name: string, version: string): Promise<VersionManifest>;
  /** `null` when the registry has no attestations for this version. */
  attestations(name: string, version: string): Promise<Attestation[] | null>;
  keys(): Promise<RegistryKey[]>;
  /** Publish time in ms, only needed for a signature made with a key that has since expired. */
  publishedAt(name: string, version: string): Promise<number>;
  /** The package's tarball from the registry, unchecked. */
  tarball(name: string, version: string): Promise<Uint8Array>;
}

/** The signer of a verified bundle, as @sigstore/verify reports it. */
export interface SignerIdentity {
  subjectAlternativeName?: string;
  extensions?: { issuer?: string };
  oids?: { oid?: { id: number[] }; value: Uint8Array }[];
}

/**
 * Verifies a Sigstore bundle cryptographically (certificate chain, transparency log, signature) with no identity
 * policy, and returns its signer for `releaseIdentityMismatch`. Throws `ProvenanceUnavailableError` when the trust
 * root can't be fetched; any other throw means the bundle doesn't verify.
 */
export type BundleVerifier = (bundle: unknown) => Promise<SignerIdentity>;

/** A Fulcio v2 extension value: a DER UTF8String. */
function derUtf8(value: Uint8Array): string | null {
  const bytes = Buffer.from(value);
  if (bytes[0] !== 0x0c || bytes.length < 2) return null;
  let length = bytes[1];
  let offset = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 2 || bytes.length < 2 + count) return null;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[2 + index];
    offset = 2 + count;
  }
  return bytes.length === offset + length ? bytes.subarray(offset).toString("utf8") : null;
}

/** Why `identity` isn't the Release workflow's, or null when it is. Exact string equality only. */
export function releaseIdentityMismatch(identity: SignerIdentity): string | null {
  if (identity.subjectAlternativeName !== RELEASE_IDENTITY.certificateIdentityURI) {
    return `signed by ${JSON.stringify(identity.subjectAlternativeName)}, not the Release workflow`;
  }
  if (identity.extensions?.issuer !== RELEASE_IDENTITY.certificateIssuer) return `issuer ${JSON.stringify(identity.extensions?.issuer)}`;
  for (const [oid, expected] of Object.entries(FULCIO_SOURCE_OIDS)) {
    const values = (identity.oids ?? []).filter((entry) => entry.oid?.id.join(".") === oid).map((entry) => derUtf8(entry.value));
    if (values.length !== 1 || values[0] !== expected) return `certificate extension ${oid} is ${JSON.stringify(values)}, not ${JSON.stringify(expected)}`;
  }
  return null;
}

export interface LockedPackage {
  name: string;
  version: string;
  integrity: string;
  /** Lockfile flags: a dev package isn't installed with the CLI; an optional one may be skipped on this platform. */
  dev?: boolean;
  optional?: boolean;
}

export function packageUrlPath(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

function purl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

function sha512Hex(integrity: string): string | null {
  const sri = integrity.split(/\s+/).find((part) => part.startsWith("sha512-"));
  return sri ? Buffer.from(sri.slice("sha512-".length), "base64").toString("hex") : null;
}

export async function verifyRegistrySignature(registry: ReleaseRegistry, manifest: VersionManifest, keys: RegistryKey[]): Promise<void> {
  const id = `${manifest.name}@${manifest.version}`;
  const signatures = manifest.dist.signatures ?? [];
  if (signatures.length === 0) throw new VerificationError("SIGNATURE_INVALID", id, "no registry signature");
  const message = Buffer.from(`${id}:${manifest.dist.integrity}`);
  for (const { keyid, sig } of signatures) {
    const key = keys.find((candidate) => candidate.keyid === keyid);
    if (!key) continue;
    if (key.expires && Date.parse(key.expires) < await registry.publishedAt(manifest.name, manifest.version)) continue;
    const publicKey = createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" });
    if (verifySignature("sha256", message, publicKey, Buffer.from(sig, "base64"))) return;
  }
  throw new VerificationError("SIGNATURE_INVALID", id, "registry signature does not verify");
}

/**
 * Verify the SLSA provenance of `manifest`: its subject is this exact package and tarball, and its Sigstore bundle
 * was signed by the Release workflow identity. Returns false when the registry holds no provenance for it.
 */
export async function verifyProvenance(registry: ReleaseRegistry, verifyBundle: BundleVerifier, manifest: VersionManifest): Promise<boolean> {
  const id = `${manifest.name}@${manifest.version}`;
  const attestations = await registry.attestations(manifest.name, manifest.version);
  const provenance = attestations?.find((attestation) => attestation.predicateType === SLSA_PROVENANCE);
  if (!provenance) return false;
  const statement = dsseStatement(provenance.bundle);
  const subject = statement?.subject?.[0];
  if (!subject || subject.name !== purl(manifest.name, manifest.version) || subject.digest?.sha512 !== sha512Hex(manifest.dist.integrity)) {
    throw new VerificationError("PROVENANCE_INVALID", id, "provenance does not name this package's tarball");
  }
  let signer: SignerIdentity;
  try {
    signer = await verifyBundle(provenance.bundle);
  } catch (error) {
    if (error instanceof ProvenanceUnavailableError) throw new VerificationError("PROVENANCE_UNAVAILABLE", id, error.message);
    // sigstore's error code (e.g. TLOG_INCLUSION_PROMISE_ERROR) names the failed check in the log and JSON detail.
    const code = (error as { code?: unknown }).code;
    throw new VerificationError("PROVENANCE_INVALID", id, `provenance does not verify: ${typeof code === "string" ? `${code}: ` : ""}${(error as Error).message}`);
  }
  const mismatch = releaseIdentityMismatch(signer);
  if (mismatch) throw new VerificationError("PROVENANCE_INVALID", id, `provenance ${mismatch}`);
  return true;
}

/**
 * `name@version` must carry provenance from the Release workflow: `PROVENANCE_MISSING` without any. For the CLI's
 * prepack, a @tinycloud package published in the same Release run (TC-4276 D1).
 */
export async function requireReleaseProvenance(registry: ReleaseRegistry, verifyBundle: BundleVerifier, name: string, version: string): Promise<void> {
  if (!await verifyProvenance(registry, verifyBundle, await registry.manifest(name, version))) {
    throw new VerificationError("PROVENANCE_MISSING", `${name}@${version}`, "no provenance attestation");
  }
}

function dsseStatement(bundle: unknown): { subject?: { name?: unknown; digest?: { sha512?: unknown } }[] } | null {
  if (!bundle || typeof bundle !== "object" || !("dsseEnvelope" in bundle)) return null;
  const envelope = bundle.dsseEnvelope;
  if (!envelope || typeof envelope !== "object" || !("payload" in envelope) || typeof envelope.payload !== "string") return null;
  try {
    const statement: unknown = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    return statement && typeof statement === "object" ? statement : null;
  } catch {
    return null;
  }
}

/** Check the CLI release before anything is downloaded: registry signature plus the required provenance. */
export async function verifyCliRelease(registry: ReleaseRegistry, verifyBundle: BundleVerifier, version: string): Promise<VersionManifest> {
  const manifest = await registry.manifest(CLI_PACKAGE, version);
  if (manifest.name !== CLI_PACKAGE || manifest.version !== version) {
    throw new VerificationError("SIGNATURE_INVALID", `${CLI_PACKAGE}@${version}`, "registry returned a different package");
  }
  await verifyRegistrySignature(registry, manifest, await registry.keys());
  if (!await verifyProvenance(registry, verifyBundle, manifest)) {
    throw new VerificationError("PROVENANCE_MISSING", `${CLI_PACKAGE}@${version}`, "no provenance attestation");
  }
  return manifest;
}

/**
 * The registry packages of an npm v2/v3 lockfile. Anything that isn't a registry tarball (git, file, link, a tarball
 * URL, or an alias to one of those) refuses with `DEPENDENCY_NOT_FROM_REGISTRY`; the updater checks this on a
 * lockfile-only resolve, before anything is downloaded or run. Packages bundled inside another tarball are covered by
 * that tarball's integrity.
 */
export function lockedPackages(lockfile: unknown): LockedPackage[] {
  if (!lockfile || typeof lockfile !== "object" || !("packages" in lockfile) || !lockfile.packages || typeof lockfile.packages !== "object") {
    throw new VerificationError("SIGNATURE_INVALID", "package-lock.json", "unreadable lockfile");
  }
  const packages: LockedPackage[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === "" || !entry || typeof entry !== "object") continue;
    if ("inBundle" in entry && entry.inBundle === true) continue;
    const name = "name" in entry && typeof entry.name === "string" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const version = "version" in entry ? entry.version : undefined;
    const integrity = "integrity" in entry ? entry.integrity : undefined;
    const resolved = "resolved" in entry ? entry.resolved : undefined;
    const link = "link" in entry && entry.link === true;
    if (link || typeof version !== "string" || typeof integrity !== "string" || typeof resolved !== "string" || !isRegistryTarball(resolved, name)) {
      throw new VerificationError("DEPENDENCY_NOT_FROM_REGISTRY", path, `not a package from the npm registry (${JSON.stringify(resolved ?? null)})`);
    }
    packages.push({
      name,
      version,
      integrity,
      ...("dev" in entry && entry.dev === true ? { dev: true } : {}),
      ...("optional" in entry && entry.optional === true ? { optional: true } : {}),
    });
  }
  return packages;
}

/** `https://registry.npmjs.org/<name>/-/<file>.tgz`: the registry's own tarball URL for `name`. */
function isRegistryTarball(resolved: string, name: string): boolean {
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return false;
  }
  return url.origin === REGISTRY && url.search === "" && url.hash === "" &&
    url.pathname.startsWith(`/${name}/-/`) && url.pathname.endsWith(".tgz") && !url.pathname.slice(name.length + 4).includes("/");
}

function sha512Base64(data: Uint8Array): string {
  return createHash("sha512").update(data).digest("base64");
}

/**
 * The runtime dependency tree the verified CLI release pins in its `npm-shrinkwrap.json` (TC-4276, Naomi's
 * dependencies gate), read from the downloaded tarball after checking it is the signed one. Nothing is installed or
 * run: a dependency that isn't a registry tarball refuses here. Null when the release has no shrinkwrap.
 */
export async function releaseShrinkwrap(registry: ReleaseRegistry, cli: VersionManifest): Promise<LockedPackage[] | null> {
  const id = `${cli.name}@${cli.version}`;
  const tarball = await registry.tarball(cli.name, cli.version);
  const expected = cli.dist.integrity.split(/\s+/).find((part) => part.startsWith("sha512-"))?.slice("sha512-".length);
  if (!expected || sha512Base64(tarball) !== expected) throw new VerificationError("SIGNATURE_INVALID", id, "downloaded tarball is not the one the registry signed");
  let file: Buffer | undefined;
  try {
    file = readTarballFiles(tarball, ["npm-shrinkwrap.json"]).get("npm-shrinkwrap.json");
  } catch {
    throw new VerificationError("SIGNATURE_INVALID", id, "unreadable tarball");
  }
  if (!file) return null;
  let shrinkwrap: unknown;
  try {
    shrinkwrap = JSON.parse(file.toString("utf8"));
  } catch {
    throw new VerificationError("SIGNATURE_INVALID", id, "unreadable npm-shrinkwrap.json");
  }
  return lockedPackages(shrinkwrap).filter((entry) => !entry.dev);
}

/**
 * The staging lockfile npm resolved must be the release's shrinkwrap plus the CLI itself: the same packages, versions
 * and integrities, nothing more and nothing less (wherever npm places them).
 */
export function checkResolvedAgainstShrinkwrap(resolved: LockedPackage[], shrinkwrap: LockedPackage[], cli: VersionManifest): void {
  const key = (entry: LockedPackage) => `${entry.name}@${entry.version} ${entry.integrity}`;
  const want = new Set([...shrinkwrap.map(key), key({ name: cli.name, version: cli.version, integrity: cli.dist.integrity })]);
  const got = new Set(resolved.filter((entry) => !entry.dev).map(key));
  const extra = [...got].filter((entry) => !want.has(entry));
  const missing = [...want].filter((entry) => !got.has(entry));
  if (extra.length > 0 || missing.length > 0) {
    throw new VerificationError("SIGNATURE_INVALID", `${cli.name}@${cli.version}`,
      `resolved tree differs from the release's npm-shrinkwrap.json (extra: ${extra.slice(0, 3).join(", ") || "none"}; missing: ${missing.slice(0, 3).join(", ") || "none"})`);
  }
}

/**
 * Verify every package of a staged tree. `cli` is the already verified CLI release: the tree must hold exactly it.
 * Returns the `@tinycloud/*` packages that have no provenance, for the log.
 */
export async function verifyStagedTree(
  registry: ReleaseRegistry,
  verifyBundle: BundleVerifier,
  packages: LockedPackage[],
  cli: VersionManifest,
  concurrency = 8,
): Promise<string[]> {
  const cliEntries = packages.filter((entry) => entry.name === CLI_PACKAGE);
  if (cliEntries.length !== 1 || cliEntries[0].version !== cli.version || cliEntries[0].integrity !== cli.dist.integrity) {
    throw new VerificationError("SIGNATURE_INVALID", `${CLI_PACKAGE}@${cli.version}`, "the installed CLI is not the verified release");
  }
  const keys = await registry.keys();
  const unattested: string[] = [];
  // Every distinct (name, version, integrity) is checked: a second entry for the same version with another
  // integrity must not hide behind the first.
  const queue = [...new Map(packages.map((entry) => [`${entry.name}@${entry.version}\0${entry.integrity}`, entry])).values()];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const id = `${entry.name}@${entry.version}`;
      const manifest = entry.name === CLI_PACKAGE ? cli : await registry.manifest(entry.name, entry.version);
      if (manifest.name !== entry.name || manifest.version !== entry.version || manifest.dist.integrity !== entry.integrity) {
        throw new VerificationError("SIGNATURE_INVALID", id, "installed tarball is not the one the registry signed");
      }
      if (entry.name === CLI_PACKAGE) continue;
      await verifyRegistrySignature(registry, manifest, keys);
      if (entry.name.startsWith("@tinycloud/") && !await verifyProvenance(registry, verifyBundle, manifest) && !unattested.includes(id)) unattested.push(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return unattested.sort();
}

async function getJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

/** The npm registry over HTTPS. */
export function npmRegistry(timeoutMs = 30_000): ReleaseRegistry {
  let keys: Promise<RegistryKey[]> | undefined;
  const packuments = new Map<string, Promise<unknown>>();
  const expect = async (url: string): Promise<unknown> => {
    const { status, body } = await getJson(url, timeoutMs);
    if (status !== 200) throw new Error(`${url} returned ${status}`);
    return body;
  };
  return {
    async manifest(name, version) {
      return await expect(`${REGISTRY}/${packageUrlPath(name)}/${version}`) as VersionManifest;
    },
    async attestations(name, version) {
      const { status, body } = await getJson(`${REGISTRY}/-/npm/v1/attestations/${packageUrlPath(name)}@${version}`, timeoutMs);
      if (status === 404) return null;
      if (status !== 200 || !body || typeof body !== "object" || !("attestations" in body) || !Array.isArray(body.attestations)) {
        throw new Error(`attestations for ${name}@${version} returned ${status}`);
      }
      return body.attestations as Attestation[];
    },
    keys() {
      keys ??= expect(`${REGISTRY}/-/npm/v1/keys`).then((body) => {
        if (!body || typeof body !== "object" || !("keys" in body) || !Array.isArray(body.keys)) throw new Error("registry keys unreadable");
        return body.keys as RegistryKey[];
      });
      return keys;
    },
    async publishedAt(name, version) {
      let packument = packuments.get(name);
      if (!packument) packuments.set(name, packument = expect(`${REGISTRY}/${packageUrlPath(name)}`));
      const body = await packument;
      const time = body && typeof body === "object" && "time" in body && body.time && typeof body.time === "object" && version in body.time
        ? Date.parse(String((body.time as Record<string, unknown>)[version]))
        : NaN;
      if (!Number.isFinite(time)) throw new Error(`no publish time for ${name}@${version}`);
      return time;
    },
    async tarball(name, version) {
      const url = `${REGISTRY}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(timeoutMs, 120_000)) });
      if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * Sigstore verification with the pinned `sigstore` dependency, loaded only when an update runs. The trust root is
 * fetched once per process (TUF, cached in `tufCachePath`); failing to fetch it is `ProvenanceUnavailableError`.
 * No identity policy goes to sigstore: its SAN check is a regex, so `releaseIdentityMismatch` decides the identity.
 */
export function sigstoreVerifier(tufCachePath: string): BundleVerifier {
  let verifier: Promise<{ verify(bundle: never): { identity?: SignerIdentity } }> | undefined;
  return async (bundle) => {
    const pending = verifier ??= import("sigstore").then(({ createVerifier }) => createVerifier({ tufCachePath })).catch((error: unknown) => {
      verifier = undefined;
      throw new ProvenanceUnavailableError(error);
    });
    const { identity } = (await pending).verify(bundle as never);
    if (!identity) throw new Error("the bundle has no certificate identity");
    return identity;
  };
}
