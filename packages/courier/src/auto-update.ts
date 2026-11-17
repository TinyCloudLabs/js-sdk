import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import { isRecord } from './a2a.js';
import { profileDir, readRegularFile, writeSecure } from './profile.js';
import { courierPackage, courierVersion } from './version.js';
import { WAKE_CHILD_ENV } from './guard/install.js';

/**
 * Self-update on start (standalone `courier` bin only).
 *
 * One check per install per 24 h against the npm `latest` dist-tag. A strictly newer stable release is downloaded into a
 * private directory while it is hashed (sha512 against `dist.integrity`); its npm provenance is verified with sigstore
 * (DSSE signature, Fulcio certificate chain, Rekor inclusion, signer pinned to this repository's release workflow,
 * subject digest equal to the hash of the file just downloaded); and `npm audit signatures` runs on a staged install of
 * that file. Only then is that same file installed, with scripts off, by the package manager and at the location that
 * installed the running copy, and the command is re-run on the new version. Every skip or refusal is one stderr line and
 * never fails the command; a failed install is rolled back, and if that fails too the command does not run.
 */

let cachedName: string | undefined;
/** Read on first use, inside the guarded check: a package.json missing mid-swap must not crash every courier command at load. */
const packageName = (): string => (cachedName ??= courierPackage().name);
export const REGISTRY = 'https://registry.npmjs.org';
/** The only signer whose provenance is accepted: the release workflow of this repository, run from master. */
export const SIGNER_IDENTITY = 'https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master';
export const SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';
const PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Hard limit for each step. A start where every step runs to its limit, including a rollback, takes their sum: 118 s.
 * A step that reaches its limit ends the update (nothing is installed) or, for an install, triggers the rollback.
 */
export const STEP_TIMEOUT_MS = {
  latest: 3_000, attestation: 5_000, signature: 10_000, download: 15_000, stage: 20_000, audit: 10_000, install: 20_000,
  rollbackRelease: 5_000, rollbackDownload: 10_000, rollbackInstall: 20_000,
} as const;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
/** One file per install (`update-check-<id>.json`): two installs under one Courier home each keep their own 24 h slot. */
const STATE_PREFIX = 'update-check-';
/** Set on the re-executed process: it does not check again. (`WAKE_CHILD_ENV` marks wake-adapter children the same way.) */
export const REEXEC_ENV = 'COURIER_AUTO_UPDATED';
export const OPT_OUT_ENV = 'COURIER_NO_AUTO_UPDATE';
export const OPT_OUT_FLAG = '--no-auto-update';

// ---------------------------------------------------------------------------------------------------------------------
// semver

interface Semver { major: number; minor: number; patch: number; pre: string[] }

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(version: string): Semver | undefined {
  const m = SEMVER.exec(version);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative when `a` < `b`. Throws on a string that is not a semver version. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semver version: ${x ? b : a}`);
  for (const key of ['major', 'minor', 'patch'] as const) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** A release version: no prerelease part. */
export const isStable = (version: string): boolean => parseSemver(version)?.pre.length === 0;

// ---------------------------------------------------------------------------------------------------------------------
// where and how the running copy was installed

export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface Install {
  manager: Manager;
  scope: 'global' | 'local';
  /** The app directory (local) or the global prefix (npm) / global project directory. */
  root: string;
  /** The `node_modules` directory that holds `@tinycloud/courier`. */
  modulesDir: string;
}

const sep = path.sep;
const has = (file: string): boolean => fs.existsSync(file);

/**
 * The install the package at `packageRoot` came from, by its real path: `undefined` for a copy that is not installed
 * (a source checkout, `npx`), `{ unsupported }` for an install Courier can't update. Package managers are told apart
 * by where the package sits and which lockfile the app directory has.
 */
export function detectInstall(packageRoot: string, platform: NodeJS.Platform = process.platform): Install | { unsupported: string } | undefined {
  let real: string;
  try { real = fs.realpathSync(packageRoot); } catch { return undefined; }
  // Throwaway runs are never updated: npx (`_npx`), pnpm dlx (`dlx`), bunx (`bunx-<uid>-…`), yarn dlx (`xfs-…`).
  if (/[\\/](_npx|dlx)[\\/]|[\\/](bunx|xfs)-[^\\/]*[\\/]/.test(real)) return undefined;

  const pnpmMarker = `${sep}node_modules${sep}.pnpm${sep}`;
  const pnpmAt = real.indexOf(pnpmMarker);
  if (pnpmAt !== -1) {
    const modulesDir = real.slice(0, pnpmAt + `${sep}node_modules`.length);
    const global = real.includes(`${sep}pnpm${sep}global${sep}`);
    return { manager: 'pnpm', scope: global ? 'global' : 'local', root: path.dirname(modulesDir), modulesDir };
  }

  const scopeDir = path.dirname(real);
  const modulesDir = path.dirname(scopeDir);
  if (path.basename(real) !== 'courier' || path.basename(scopeDir) !== '@tinycloud' || path.basename(modulesDir) !== 'node_modules') return undefined;
  const base = path.dirname(modulesDir);

  if (real.includes(`${sep}.bun${sep}install${sep}global${sep}`)) return { manager: 'bun', scope: 'global', root: base, modulesDir };
  if (/[\\/](\.config[\\/]yarn|\.yarn|Yarn[\\/]Data)[\\/]global[\\/]/.test(real)) return { manager: 'yarn', scope: 'global', root: base, modulesDir };

  if (!has(path.join(base, 'package.json'))) {
    // `<prefix>/lib/node_modules` (POSIX) or `<prefix>/node_modules` (Windows) with no project beside it: an npm global prefix.
    if (platform === 'win32') return { manager: 'npm', scope: 'global', root: base, modulesDir };
    if (path.basename(base) === 'lib') return { manager: 'npm', scope: 'global', root: path.dirname(base), modulesDir };
    return undefined;
  }
  if (has(path.join(base, '.yarnrc.yml'))) return { unsupported: 'it was installed with Yarn Berry' };
  const manager: Manager = has(path.join(base, 'pnpm-lock.yaml')) ? 'pnpm'
    : has(path.join(base, 'yarn.lock')) ? 'yarn'
      : has(path.join(base, 'bun.lock')) || has(path.join(base, 'bun.lockb')) ? 'bun'
        : 'npm';
  return { manager, scope: 'local', root: base, modulesDir };
}

/**
 * The argv that installs `spec` the way `install` was made. With `work` (the private directory that holds the empty npm
 * config files) it is the form Courier runs: scripts off, the npm registry named, and for npm the user and global
 * configuration replaced by those files so no scoped-registry override applies. Without it, the command a person would run.
 */
export function installCommand(install: Install, spec: string, work?: string): { command: string; args: string[] } {
  const global = install.scope === 'global';
  const own = work !== undefined;
  const registry = ['--registry', `${REGISTRY}/`];
  const scripts = own ? ['--ignore-scripts'] : [];
  switch (install.manager) {
    case 'npm': {
      // A file installed into an app directory is not recorded in its package.json or lockfile.
      const mode = global ? ['--global'] : own ? ['--no-save'] : [];
      return { command: 'npm', args: ['install', ...mode, '--prefix', install.root, spec, ...scripts, ...(work === undefined ? registry : ['--no-audit', '--no-fund', ...npmConfigArgs(work)])] };
    }
    case 'pnpm':
      return { command: 'pnpm', args: global ? ['add', '--global', spec, ...scripts, ...registry] : ['add', '--dir', install.root, spec, ...scripts, ...registry] };
    case 'yarn':
      return { command: 'yarn', args: global ? ['global', 'add', spec, ...scripts, ...registry] : ['--cwd', install.root, 'add', spec, ...scripts, ...registry] };
    case 'bun':
      return { command: 'bun', args: global ? ['add', '--global', spec, ...scripts, ...registry] : ['add', '--cwd', install.root, spec, ...scripts, ...registry] };
  }
}

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export function manualCommand(install: Install, version: string): string {
  const { command, args } = installCommand(install, `${packageName()}@${version}`);
  return [command, ...args].map(shellWord).join(' ');
}

/** The directories the install writes to: it must be able to write all of them. */
export function writeTargets(install: Install): string[] {
  return install.scope === 'local' ? [install.root, install.modulesDir] : [install.modulesDir];
}

// ---------------------------------------------------------------------------------------------------------------------
// the check

export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface UpdateDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** The running version. */
  version: string;
  /** The running package's directory (the one with `package.json` and `dist/`). */
  packageRoot: string;
  fetch: typeof fetch;
  run: (command: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<RunResult>;
  /** Verify a sigstore bundle (DSSE signature, certificate chain, transparency log) for exactly this signer; rejects if it does not hold. */
  verifyBundle: (bundle: unknown, policy: { certificateIssuer: string; certificateIdentityURI: string }) => Promise<void>;
  /** One line to stderr. */
  log: (line: string) => void;
  /** Defaults to the real platform: auto-update is off on Windows. */
  platform?: NodeJS.Platform;
}

export type UpdateResult =
  | { kind: 'none' }
  | { kind: 'updated'; from: string; to: string; entry: string }
  /** A failed update whose rollback failed too and left no usable copy: the command must not run. */
  | { kind: 'broken' };

interface CheckState { checkedAt: number; install: string; result: string }

/** Why a skip or a refusal happened; the message is the one log line. */
class Stop extends Error {
  constructor(message: string, readonly result: string) { super(message); }
}

/** An update that failed and could not be undone: there is no usable copy to run. */
class Broken extends Stop {
  constructor(message: string) { super(message, 'broken'); }
}

const truthy = (value: string | undefined): boolean => value !== undefined && value !== '' && !/^(0|false|no)$/i.test(value);

/** `argv` without `--no-auto-update`, and whether it was there. Arguments after `--` are left alone. */
export function stripOptOutFlag(argv: string[]): { argv: string[]; optOut: boolean } {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  const kept = head.filter((a) => a !== OPT_OUT_FLAG);
  return { argv: end === -1 ? kept : [...kept, ...argv.slice(end)], optOut: kept.length !== head.length };
}

/** Commands that never check: informational ones, and the hooks a woken agent runs on every tool call. */
const EXEMPT_COMMANDS: Record<string, boolean> = { guard: true, 'run-approved': true, broker: true };

function exempt(argv: string[]): boolean {
  const args = parseArgs(argv);
  if (!args.positional[0] || args.has('help') || args.has('version')) return true;
  // Any hook name before `--` counts, wherever it sits: a leading `--flag value` must not move it out of the exemption.
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).some((word) => EXEMPT_COMMANDS[word] === true);
}

function readState(file: string): CheckState | undefined {
  const text = readRegularFile(file);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<CheckState>;
    if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && typeof value.install === 'string') {
      return { checkedAt: value.checkedAt, install: value.install, result: typeof value.result === 'string' ? value.result : '' };
    }
  } catch { /* unreadable state: check again */ }
  return undefined;
}

async function getJson(deps: UpdateDeps, url: string, timeoutMs: number, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'error' });
  } catch {
    throw new Stop(`auto-update skipped: npm registry unreachable (${what}), staying on ${deps.version}`, 'offline');
  }
  if (!res.ok) throw new Stop(`auto-update skipped: npm registry answered ${res.status} for ${what}, staying on ${deps.version}`, 'offline');
  try {
    return await res.json();
  } catch {
    throw new Stop(`auto-update skipped: npm registry sent unreadable data for ${what}, staying on ${deps.version}`, 'offline');
  }
}

interface Release { version: string; integrity: string; tarball: string; provenance: boolean }

function parseRelease(doc: unknown, deps: UpdateDeps): Release {
  const bad = (why: string) => new Stop(`auto-update skipped: npm registry data for ${packageName()}@latest is not usable (${why}), staying on ${deps.version}`, 'bad-metadata');
  if (!isRecord(doc) || doc.name !== packageName() || typeof doc.version !== 'string' || !parseSemver(doc.version)) throw bad('name or version');
  if (!isRecord(doc.dist)) throw bad('no dist');
  const { integrity, tarball, attestations } = doc.dist;
  const version = doc.version;
  const provenance = isRecord(attestations) && isRecord(attestations.provenance) && attestations.provenance.predicateType === PROVENANCE_TYPE;
  return {
    version,
    integrity: typeof integrity === 'string' ? integrity : '',
    tarball: typeof tarball === 'string' ? tarball : '',
    provenance,
  };
}

const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

const refuse = (version: string, why: string, deps: UpdateDeps): Stop => new Stop(`refused ${packageName()}@${version}: ${why}, staying on ${deps.version}`, 'refused');

/** The registry document must give a sha512 integrity and a tarball URL on the npm registry; nothing is fetched yet. */
function assertServable(release: Release, deps: UpdateDeps): void {
  if (!SHA512_INTEGRITY.test(release.integrity)) throw refuse(release.version, 'the registry gives no sha512 integrity', deps);
  if (release.tarball !== `${REGISTRY}/${packageName()}/-/courier-${release.version}.tgz`) throw refuse(release.version, 'its tarball is not served from the npm registry', deps);
}

/**
 * Stream the tarball into `file` while hashing it. The file stays only if its sha512 is `integrity`. Returns that digest
 * as hex, which is what the provenance statement must name.
 */
async function downloadTarball(url: string, integrity: string, file: string, timeoutMs: number, version: string, deps: UpdateDeps): Promise<string> {
  const unreachable = (suffix = '') => new Stop(`auto-update skipped: could not download ${packageName()}@${version}${suffix}, staying on ${deps.version}`, 'offline');
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    throw unreachable();
  }
  if (!res.ok || !res.body) throw unreachable(` (HTTP ${res.status})`);
  const hash = createHash('sha512');
  let size = 0;
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_TARBALL_BYTES) throw refuse(version, 'its tarball is larger than 100 MB', deps);
      hash.update(chunk);
      for (let written = 0; written < chunk.byteLength;) written += fs.writeSync(fd, chunk, written);
    }
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw unreachable();
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest();
  if (`sha512-${digest.toString('base64')}` !== integrity) throw refuse(version, 'the downloaded tarball does not match its registry integrity (sha512)', deps);
  fs.chmodSync(file, 0o400);
  return digest.toString('hex');
}

/**
 * The npm provenance bundle must verify with sigstore (DSSE signature, Fulcio chain, Rekor inclusion) for exactly the
 * pinned signer, and the statement it signed must be about the tarball that was hashed. Nothing in the registry's own JSON
 * is trusted: a bundle that merely says the right things fails the signature or the identity check.
 */
async function verifyProvenance(release: Release, digestHex: string, deps: UpdateDeps): Promise<void> {
  const bad = (why: string) => refuse(release.version, why, deps);
  const doc = await getJson(deps, `${REGISTRY}/-/npm/v1/attestations/${packageName().replace('/', '%2f')}@${release.version}`, STEP_TIMEOUT_MS.attestation, 'provenance');
  const list = isRecord(doc) && Array.isArray(doc.attestations) ? doc.attestations : [];
  const entry = list.find((a) => isRecord(a) && a.predicateType === PROVENANCE_TYPE);
  const bundle = isRecord(entry) ? entry.bundle : undefined;
  const envelope = isRecord(bundle) && isRecord(bundle.dsseEnvelope) ? bundle.dsseEnvelope : undefined;
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payloadType !== 'application/vnd.in-toto+json') throw bad('its provenance attestation is missing');
  try {
    await deps.verifyBundle(bundle, { certificateIssuer: SIGNER_ISSUER, certificateIdentityURI: SIGNER_IDENTITY });
  } catch (e) {
    throw bad(`its provenance did not verify for ${SIGNER_IDENTITY} (${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'})`);
  }
  let statement: unknown;
  try { statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')); } catch { throw bad('its provenance attestation is unreadable'); }
  if (!isRecord(statement) || statement.predicateType !== PROVENANCE_TYPE || !Array.isArray(statement.subject) || statement.subject.length !== 1) throw bad('its provenance attestation is malformed');
  const [subject] = statement.subject as unknown[];
  const digest = isRecord(subject) && isRecord(subject.digest) ? subject.digest.sha512 : undefined;
  if (!isRecord(subject) || subject.name !== `pkg:npm/${packageName().replace('@', '%40')}@${release.version}` || digest !== digestHex) {
    throw bad('its provenance attestation is for a different tarball');
  }
}

/** The empty files (in the private work directory) that stand in for the user's and the global npm configuration. */
const NPM_CONFIG_FILES = ['user.npmrc', 'global.npmrc'];

/** npm options that name the registry and ignore every user and global npm configuration, scoped-registry overrides included. */
const npmConfigArgs = (work: string): string[] => [
  '--userconfig', path.join(work, NPM_CONFIG_FILES[0]), '--globalconfig', path.join(work, NPM_CONFIG_FILES[1]),
  '--registry', `${REGISTRY}/`, `--${packageName().split('/')[0]}:registry=${REGISTRY}/`, '--no-update-notifier', '--loglevel', 'error',
];

/**
 * `npm audit signatures` on a staged install of the downloaded file: registry signatures and attestations of its
 * dependencies. An extra check; the proof that the release itself came from our workflow is `verifyProvenance`.
 */
async function auditStaged(release: Release, tarball: string, work: string, deps: UpdateDeps): Promise<void> {
  const stage = path.join(work, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'package.json'), '{"name":"courier-update-stage","private":true}\n');
  let installed: RunResult;
  try {
    // No scripts run before the release is verified.
    installed = await deps.run('npm', ['install', '--prefix', stage, tarball, '--ignore-scripts', '--no-audit', '--no-fund', ...npmConfigArgs(work)], { cwd: stage, timeoutMs: STEP_TIMEOUT_MS.stage });
  } catch {
    throw new Stop(`auto-update skipped: npm is not available to verify ${packageName()}@${release.version}, staying on ${deps.version}`, 'no-npm');
  }
  if (installed.code !== 0) throw new Stop(`auto-update skipped: could not stage ${packageName()}@${release.version} for verification, staying on ${deps.version}`, 'offline');
  const audited = await deps.run('npm', ['audit', 'signatures', '--json', ...npmConfigArgs(work)], { cwd: stage, timeoutMs: STEP_TIMEOUT_MS.audit });
  let report: unknown;
  try { report = JSON.parse(audited.stdout); } catch { /* judged below by the exit code */ }
  const problems = isRecord(report) ? [...(Array.isArray(report.invalid) ? report.invalid : []), ...(Array.isArray(report.missing) ? report.missing : [])] : [];
  if (audited.code !== 0 || problems.length > 0 || !isRecord(report)) throw refuse(release.version, 'npm audit signatures failed on its dependencies', deps);
}

function assertWritable(install: Install, release: Release, deps: UpdateDeps): void {
  for (const dir of writeTargets(install)) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new Stop(`auto-update skipped: ${packageName()}@${release.version} is available but ${dir} is not writable, staying on ${deps.version}; run: ${manualCommand(install, release.version)}`, 'no-permission');
    }
  }
}

const installedPackageDir = (install: Install): string => path.join(install.modulesDir, ...packageName().split('/'));

function installedVersion(install: Install): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installedPackageDir(install), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch { return undefined; }
}

/** Install `tarball` the way `install` was made (scripts off, private npm config) and say whether `version` is then what is on disk. */
async function installFile(install: Install, tarball: string, work: string, timeoutMs: number, version: string, deps: UpdateDeps): Promise<'ok' | 'failed' | 'not-run'> {
  const { command, args } = installCommand(install, tarball, work);
  let result: RunResult;
  try {
    result = await deps.run(command, args, { cwd: work, timeoutMs });
  } catch {
    return 'not-run';
  }
  return result.code === 0 && installedVersion(install) === version && has(path.join(installedPackageDir(install), 'dist', 'cli.js')) ? 'ok' : 'failed';
}

/**
 * Put the running version back from its registry tarball, checked against that release's `dist.integrity` (the same
 * download-hash-install route as the update, minus the provenance a beta may not have). Returns why it could not.
 */
async function rollback(install: Install, work: string, deps: UpdateDeps): Promise<string | undefined> {
  try {
    const previous = parseRelease(await getJson(deps, `${REGISTRY}/${packageName().replace('/', '%2f')}/${deps.version}`, STEP_TIMEOUT_MS.rollbackRelease, deps.version), deps);
    if (previous.version !== deps.version) return 'the registry answered for another version';
    assertServable(previous, deps);
    const file = path.join(work, `previous-${previous.version}.tgz`);
    await downloadTarball(previous.tarball, previous.integrity, file, STEP_TIMEOUT_MS.rollbackDownload, previous.version, deps);
    return (await installFile(install, file, work, STEP_TIMEOUT_MS.rollbackInstall, deps.version, deps)) === 'ok' ? undefined : `${install.manager} did not leave ${deps.version} in place`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function switchTo(install: Install, release: Release, tarball: string, work: string, deps: UpdateDeps): Promise<string> {
  const outcome = await installFile(install, tarball, work, STEP_TIMEOUT_MS.install, release.version, deps);
  if (outcome === 'ok') return fs.realpathSync(path.join(installedPackageDir(install), 'dist', 'cli.js'));
  if (outcome === 'not-run') throw new Stop(`auto-update failed: ${install.manager} is not available, staying on ${deps.version}; run: ${manualCommand(install, release.version)}`, 'failed');
  const failure = `installing ${release.version} did not leave ${release.version} in place`;
  const undone = await rollback(install, work, deps);
  if (undone === undefined) throw new Stop(`auto-update failed: ${failure}; ${deps.version} was put back and checked against its registry integrity`, 'failed');
  const repair = `repair it with: ${manualCommand(install, deps.version)}`;
  const line = `auto-update FAILED: ${failure}, and putting ${deps.version} back failed too (${undone})`;
  if (installedVersion(install) === deps.version && has(path.join(installedPackageDir(install), 'dist', 'cli.js'))) throw new Stop(`${line}; the installed copy still reports ${deps.version}, ${repair}`, 'rollback-failed');
  throw new Broken(`${line}; the installed copy is not usable, ${repair}`);
}

/**
 * The one self-update check. Never throws: every skip or refusal is one `log` line, and the command goes on. Returns
 * `updated` when the package on disk is now a newer release and `entry` is its `dist/cli.js`.
 */
export async function checkForUpdate(argv: string[], deps: UpdateDeps, flagOptOut = false): Promise<UpdateResult> {
  const none: UpdateResult = { kind: 'none' };
  try {
    if (truthy(deps.env[WAKE_CHILD_ENV]) || truthy(deps.env[REEXEC_ENV]) || exempt(argv)) return none;

    // A copy that is not an installed package (source checkout, npx) is never updated and never says so.
    const install = detectInstall(deps.packageRoot, deps.platform);
    if (!install) return none;
    if (flagOptOut) throw new Stop(`auto-update skipped: ${OPT_OUT_FLAG}`, 'opt-out');
    if (truthy(deps.env[OPT_OUT_ENV])) throw new Stop(`auto-update skipped: ${OPT_OUT_ENV} is set`, 'opt-out');
    if (truthy(deps.env.CI)) throw new Stop('auto-update skipped: running under CI', 'ci');
    // The package managers' Windows shims (`npm.cmd`) can't be spawned without a shell, and the profile files' ownership and
    // symlink checks are POSIX: rather than half-work, auto-update is off there.
    if ((deps.platform ?? process.platform) === 'win32') throw new Stop(`auto-update skipped: not supported on Windows; update with: npm install --global ${packageName()}@latest`, 'unsupported');

    const stateFile = path.join(profileDir(), `${STATE_PREFIX}${createHash('sha256').update(deps.packageRoot).digest('hex').slice(0, 16)}.json`);
    const now = deps.now();
    const previous = readState(stateFile);
    if (previous && previous.install === deps.packageRoot && previous.checkedAt <= now + 60_000 && now - previous.checkedAt < CHECK_INTERVAL_MS) return none;

    const save = (result: string) => { try { writeSecure(stateFile, { checkedAt: now, install: deps.packageRoot, result } satisfies CheckState); } catch { /* best effort after the claim */ } };
    // Claim the slot before any network call: a second process that starts now sees it and skips.
    try {
      writeSecure(stateFile, { checkedAt: now, install: deps.packageRoot, result: 'checking' } satisfies CheckState);
    } catch {
      throw new Stop(`auto-update skipped: cannot write ${stateFile}`, 'no-state');
    }

    try {
      if ('unsupported' in install) throw new Stop(`auto-update skipped: ${install.unsupported}; update it with your package manager`, 'unsupported');
      const release = parseRelease(await getJson(deps, `${REGISTRY}/${packageName().replace('/', '%2f')}/latest`, STEP_TIMEOUT_MS.latest, 'latest'), deps);
      if (!isStable(release.version) || compareSemver(release.version, deps.version) <= 0) { save('current'); return none; }
      if (!release.provenance) throw new Stop(`no npm provenance for ${release.version}, staying on ${deps.version}`, 'refused');
      if (install.scope === 'local' && install.manager !== 'npm') {
        // Installing the verified file would write its (temporary) path into the app's package.json.
        throw new Stop(`auto-update skipped: ${release.version} is available, but a ${install.manager} app install can't take a verified file without rewriting package.json, staying on ${deps.version}; run: ${manualCommand(install, release.version)}`, 'unsupported');
      }
      assertWritable(install, release, deps);
      assertServable(release, deps);

      // Everything below works on one private file: the bytes that are hashed and verified are the bytes that get installed.
      const work = fs.mkdtempSync(path.join(profileDir(), 'update-'));
      let entry: string;
      try {
        for (const name of NPM_CONFIG_FILES) fs.writeFileSync(path.join(work, name), '', { mode: 0o600 });
        const tarball = path.join(work, `courier-${release.version}.tgz`);
        const digest = await downloadTarball(release.tarball, release.integrity, tarball, STEP_TIMEOUT_MS.download, release.version, deps);
        await verifyProvenance(release, digest, deps);
        await auditStaged(release, tarball, work, deps);
        entry = await switchTo(install, release, tarball, work, deps);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      save(`updated to ${release.version}`);
      deps.log(`${packageName()} updated ${deps.version} → ${release.version} (${install.manager}${install.scope === 'global' ? ' global' : ` in ${install.root}`})`);
      return { kind: 'updated', from: deps.version, to: release.version, entry };
    } catch (e) {
      if (e instanceof Stop) save(e.result);
      else save('error');
      throw e;
    }
  } catch (e) {
    if (e instanceof Broken) {
      deps.log(e.message);
      return { kind: 'broken' };
    }
    deps.log(e instanceof Stop ? e.message : `auto-update skipped: ${e instanceof Error ? e.message : String(e)}`);
    return none;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the real world

/** The package managers read their configuration from these: a variable set for another purpose must not redirect the install. */
const MANAGER_CONFIG_ENV = /^(npm_config_|pnpm_config_|yarn_|bun_config_)/i;

export function managerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !MANAGER_CONFIG_ENV.test(key)));
}

function runProcess(command: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: managerEnv(process.env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 1_000_000) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Run `entry` with `argv` as a child that owns this process's stdio, forward stop signals to it, and give back its exit code.
 * SIGTERM and SIGHUP are forwarded at once. SIGINT is forwarded only if the child is still running after `graceMs`: when
 * the signal came from a terminal's Ctrl-C the whole foreground group, child included, already got it (whether or not
 * stdin is a terminal), and a second SIGINT is what `watch` reads as "stop now". A `kill -INT` sent to this process alone
 * still reaches the child, one grace period later.
 */
export function runOnNewVersion(entry: string, argv: string[], env: NodeJS.ProcessEnv = process.env, opts: { graceMs?: number } = {}): Promise<number> {
  const graceMs = opts.graceMs ?? 3_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', env: { ...env, [REEXEC_ENV]: '1' } });
    let pendingInt: NodeJS.Timeout | undefined;
    const onInt = () => { pendingInt ??= setTimeout(() => { child.kill('SIGINT'); }, graceMs); };
    const onTerm = () => { child.kill('SIGTERM'); };
    const onHup = () => { child.kill('SIGHUP'); };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const done = (code: number) => {
      clearTimeout(pendingInt);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      resolve(code);
    };
    child.once('error', (e) => {
      process.stderr.write(`courier: could not start the updated copy (${e.message}); run the command again\n`);
      done(1);
    });
    child.once('close', (code, signal) => { done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)); });
  });
}

/** Sigstore verification of a provenance bundle: DSSE signature, Fulcio certificate chain, Rekor inclusion, and the pinned signer. */
export async function verifyWithSigstore(bundle: unknown, policy: { certificateIssuer: string; certificateIdentityURI: string }): Promise<void> {
  const { verify } = await import('sigstore');
  const cache = path.join(profileDir(), 'sigstore-tuf');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      verify(bundle as Parameters<typeof verify>[0], { ...policy, tufCachePath: cache, timeout: STEP_TIMEOUT_MS.signature / 2, retry: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('timed out')); }, STEP_TIMEOUT_MS.signature); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entry for `cli.ts`: the check with the real registry, disk and package manager. Returns the argv to run and, when
 * the package was updated, the new `dist/cli.js` to re-run it with.
 */
export async function autoUpdate(argv: string[]): Promise<{ argv: string[]; entry?: string; broken?: boolean }> {
  const { argv: kept, optOut } = stripOptOutFlag(argv);
  let version: string;
  try { version = courierVersion(); } catch { return { argv: kept }; }
  const result = await checkForUpdate(kept, {
    env: process.env,
    now: Date.now,
    version,
    packageRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    fetch: globalThis.fetch,
    run: runProcess,
    verifyBundle: verifyWithSigstore,
    log: (line) => { process.stderr.write(`courier: ${line}\n`); },
  }, optOut);
  if (result.kind === 'updated') return { argv: kept, entry: result.entry };
  return result.kind === 'broken' ? { argv: kept, broken: true } : { argv: kept };
}
