/**
 * Release verification for self-update (TC-4276).
 *
 * - Every package in a staged tree must carry a valid npm registry signature (ECDSA over `name@version:integrity`),
 *   and the lockfile integrity must equal the signed one.
 * - The CLI itself must carry a SLSA provenance attestation signed by TinyCloudLabs/js-sdk's Release workflow on master.
 * - Any other `@tinycloud/*` package that has an attestation must carry the same identity; one without is allowed and
 *   reported (TC-4278 republishes the last unattested ones).
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { CLI_PACKAGE } from "./versions.js";

export const REGISTRY = "https://registry.npmjs.org";
export const RELEASE_IDENTITY = {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: "https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master",
} as const;
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";

export type VerificationCode = "PROVENANCE_MISSING" | "PROVENANCE_INVALID" | "SIGNATURE_INVALID";

export class VerificationError extends Error {
  constructor(readonly code: VerificationCode, readonly packageId: string, detail: string) {
    super(`${packageId}: ${detail}`);
    this.name = "VerificationError";
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
}

/** Verifies a Sigstore bundle against the identity policy; throws when it does not hold. */
export type BundleVerifier = (bundle: unknown, policy: typeof RELEASE_IDENTITY) => Promise<void>;

export interface LockedPackage { name: string; version: string; integrity: string }

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
  try {
    await verifyBundle(provenance.bundle, RELEASE_IDENTITY);
  } catch (error) {
    throw new VerificationError("PROVENANCE_INVALID", id, `provenance does not verify: ${(error as Error).message}`);
  }
  return true;
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
 * The registry packages of an npm v2/v3 lockfile. Anything that does not come from the npm registry refuses; packages
 * bundled inside another tarball are covered by that tarball's integrity.
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
    if (typeof version !== "string" || typeof integrity !== "string" || typeof resolved !== "string" || !resolved.startsWith(`${REGISTRY}/`)) {
      throw new VerificationError("SIGNATURE_INVALID", path, "not a package from the npm registry");
    }
    packages.push({ name, version, integrity });
  }
  return packages;
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
  const queue = [...new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const id = `${entry.name}@${entry.version}`;
      const manifest = entry.name === CLI_PACKAGE ? cli : await registry.manifest(entry.name, entry.version);
      if (manifest.name !== entry.name || manifest.version !== entry.version || manifest.dist.integrity !== entry.integrity) {
        throw new VerificationError("SIGNATURE_INVALID", id, "installed tarball is not the one the registry signed");
      }
      if (entry.name === CLI_PACKAGE) continue;
      await verifyRegistrySignature(registry, manifest, keys);
      if (entry.name.startsWith("@tinycloud/") && !await verifyProvenance(registry, verifyBundle, manifest)) unattested.push(id);
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
  };
}

/** Sigstore verification with the pinned `sigstore` dependency, loaded only when an update runs. */
export function sigstoreVerifier(tufCachePath: string): BundleVerifier {
  return async (bundle, policy) => {
    const { verify } = await import("sigstore");
    await verify(bundle as Parameters<typeof verify>[0], { ...policy, tufCachePath });
  };
}
