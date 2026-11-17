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

/**
 * Self-update on start (standalone `courier` bin only).
 *
 * One check per install per 24 h against the npm `latest` dist-tag. A strictly newer stable release is verified
 * (tarball sha512 against `dist.integrity`, a SLSA provenance attestation that names this repository and this tarball,
 * `npm audit signatures` on a staged copy) and only then installed with the package manager and at the location that
 * installed the running copy. The command is then re-run on the new version. Every skip or refusal is one stderr line and
 * never fails the command.
 */

export const PACKAGE = courierPackage().name;
export const REGISTRY = 'https://registry.npmjs.org';
const REPOSITORY = 'https://github.com/TinyCloudLabs/js-sdk';
const PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_TIMEOUT_MS = 3_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const STATE_FILE = 'update-check.json';
/** Set on the re-executed process and on every wake-adapter child: neither checks for updates. */
export const REEXEC_ENV = 'COURIER_AUTO_UPDATED';
export const WAKE_CHILD_ENV = 'COURIER_WAKE_CHILD';
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
  if (real.includes(`${sep}_npx${sep}`)) return undefined;

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

/** The argv that installs exactly `version` the way `install` was made. */
export function installCommand(install: Install, version: string): { command: string; args: string[] } {
  const spec = `${PACKAGE}@${version}`;
  const registry = ['--registry', `${REGISTRY}/`];
  const global = install.scope === 'global';
  switch (install.manager) {
    case 'npm':
      return { command: 'npm', args: ['install', ...(global ? ['--global'] : []), '--prefix', install.root, spec, '--no-audit', '--no-fund', ...registry] };
    case 'pnpm':
      return { command: 'pnpm', args: global ? ['add', '--global', spec, ...registry] : ['add', '--dir', install.root, spec, ...registry] };
    case 'yarn':
      return { command: 'yarn', args: global ? ['global', 'add', spec, ...registry] : ['--cwd', install.root, 'add', spec, ...registry] };
    case 'bun':
      return { command: 'bun', args: global ? ['add', '--global', spec, ...registry] : ['add', '--cwd', install.root, spec, ...registry] };
  }
}

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export function manualCommand(install: Install, version: string): string {
  const { command, args } = installCommand(install, version);
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
  /** One line to stderr. */
  log: (line: string) => void;
  platform?: NodeJS.Platform;
}

export type UpdateResult =
  | { kind: 'none' }
  | { kind: 'updated'; from: string; to: string; entry: string };

interface CheckState { checkedAt: number; install: string; result: string }

/** Why a skip or a refusal happened; the message is the one log line. */
class Stop extends Error {
  constructor(message: string, readonly result: string) { super(message); }
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
const EXEMPT_COMMANDS = new Set(['guard', 'run-approved', 'broker']);

function exempt(argv: string[]): boolean {
  const args = parseArgs(argv);
  const command = args.positional[0];
  if (!command) return true;
  return args.has('help') || args.has('version') || EXEMPT_COMMANDS.has(command);
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
  const bad = (why: string) => new Stop(`auto-update skipped: npm registry data for ${PACKAGE}@latest is not usable (${why}), staying on ${deps.version}`, 'bad-metadata');
  if (!isRecord(doc) || doc.name !== PACKAGE || typeof doc.version !== 'string' || !parseSemver(doc.version)) throw bad('name or version');
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

/** The registry document must give a sha512 integrity and a tarball URL on the npm registry; nothing is fetched yet. */
function assertServable(release: Release, deps: UpdateDeps): void {
  const refuse = (why: string) => new Stop(`refused ${PACKAGE}@${release.version}: ${why}, staying on ${deps.version}`, 'refused');
  if (!SHA512_INTEGRITY.test(release.integrity)) throw refuse('the registry gives no sha512 integrity');
  if (release.tarball !== `${REGISTRY}/${PACKAGE}/-/courier-${release.version}.tgz`) throw refuse('its tarball is not served from the npm registry');
}

/** Download the release tarball and compare its sha512 with `dist.integrity`. */
async function checkTarball(release: Release, deps: UpdateDeps): Promise<void> {
  const refuse = (why: string) => new Stop(`refused ${PACKAGE}@${release.version}: ${why}, staying on ${deps.version}`, 'refused');
  let res: Response;
  try {
    res = await deps.fetch(release.tarball, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new Stop(`auto-update skipped: could not download ${PACKAGE}@${release.version}, staying on ${deps.version}`, 'offline');
  }
  if (!res.ok || !res.body) throw new Stop(`auto-update skipped: could not download ${PACKAGE}@${release.version} (HTTP ${res.status}), staying on ${deps.version}`, 'offline');
  const hash = createHash('sha512');
  let size = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_TARBALL_BYTES) throw refuse('its tarball is larger than 100 MB');
      hash.update(chunk);
    }
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw new Stop(`auto-update skipped: could not download ${PACKAGE}@${release.version}, staying on ${deps.version}`, 'offline');
  }
  if (`sha512-${hash.digest('base64')}` !== release.integrity) throw refuse('the downloaded tarball does not match its registry integrity (sha512)');
}

/** The SLSA provenance statement must be about this tarball and say it was built from this repository. */
async function checkProvenance(release: Release, deps: UpdateDeps): Promise<void> {
  const refuse = (why: string) => new Stop(`refused ${PACKAGE}@${release.version}: ${why}, staying on ${deps.version}`, 'refused');
  if (!release.provenance) throw new Stop(`no npm provenance for ${release.version}, staying on ${deps.version}`, 'refused');
  const bundle = await getJson(deps, `${REGISTRY}/-/npm/v1/attestations/${PACKAGE.replace('/', '%2f')}@${release.version}`, DOWNLOAD_TIMEOUT_MS, 'provenance');
  const list = isRecord(bundle) && Array.isArray(bundle.attestations) ? bundle.attestations : [];
  const entry = list.find((a) => isRecord(a) && a.predicateType === PROVENANCE_TYPE);
  const payload = isRecord(entry) && isRecord(entry.bundle) && isRecord(entry.bundle.dsseEnvelope) ? entry.bundle.dsseEnvelope.payload : undefined;
  if (typeof payload !== 'string') throw refuse('its provenance attestation is missing');
  let statement: unknown;
  try { statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch { throw refuse('its provenance attestation is unreadable'); }
  if (!isRecord(statement) || statement.predicateType !== PROVENANCE_TYPE || !Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw refuse('its provenance attestation is malformed');
  }
  const [subject] = statement.subject as unknown[];
  const digest = isRecord(subject) && isRecord(subject.digest) ? subject.digest.sha512 : undefined;
  const expected = Buffer.from(release.integrity.slice('sha512-'.length), 'base64').toString('hex');
  if (!isRecord(subject) || subject.name !== `pkg:npm/${PACKAGE.replace('@', '%40')}@${release.version}` || digest !== expected) {
    throw refuse('its provenance attestation is for a different tarball');
  }
  const predicate = isRecord(statement.predicate) ? statement.predicate : {};
  const build = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : {};
  const external = isRecord(build.externalParameters) ? build.externalParameters : {};
  const workflow = isRecord(external.workflow) ? external.workflow : {};
  if (workflow.repository !== REPOSITORY) throw refuse(`its provenance says it was built from ${String(workflow.repository)}, not ${REPOSITORY}`);
}

/** `npm audit signatures` on a staged install of the release: registry signatures and attestations of it and its dependencies. */
async function auditStaged(release: Release, deps: UpdateDeps): Promise<void> {
  const refuse = (why: string) => new Stop(`refused ${PACKAGE}@${release.version}: ${why}, staying on ${deps.version}`, 'refused');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-update-'));
  try {
    fs.writeFileSync(path.join(stage, 'package.json'), '{"name":"courier-update-stage","private":true}\n');
    const registry = ['--registry', `${REGISTRY}/`];
    let installed: RunResult;
    try {
      // No scripts run before the release is verified.
      installed = await deps.run('npm', ['install', '--prefix', stage, `${PACKAGE}@${release.version}`, '--ignore-scripts', '--no-audit', '--no-fund', ...registry], { cwd: stage, timeoutMs: COMMAND_TIMEOUT_MS });
    } catch {
      throw new Stop(`auto-update skipped: npm is not available to verify ${PACKAGE}@${release.version}, staying on ${deps.version}`, 'no-npm');
    }
    if (installed.code !== 0) throw new Stop(`auto-update skipped: could not stage ${PACKAGE}@${release.version} for verification, staying on ${deps.version}`, 'offline');
    const audited = await deps.run('npm', ['audit', 'signatures', '--json', ...registry], { cwd: stage, timeoutMs: COMMAND_TIMEOUT_MS });
    let report: unknown;
    try { report = JSON.parse(audited.stdout); } catch { /* judged below by the exit code */ }
    const problems = isRecord(report) ? [...(Array.isArray(report.invalid) ? report.invalid : []), ...(Array.isArray(report.missing) ? report.missing : [])] : [];
    if (audited.code !== 0 || problems.length > 0 || !isRecord(report)) throw refuse('npm audit signatures failed on it or its dependencies');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function assertWritable(install: Install, release: Release, deps: UpdateDeps): void {
  for (const dir of writeTargets(install)) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new Stop(`auto-update skipped: ${PACKAGE}@${release.version} is available but ${dir} is not writable, staying on ${deps.version}; run: ${manualCommand(install, release.version)}`, 'no-permission');
    }
  }
}

function installedVersion(install: Install): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(install.modulesDir, '@tinycloud', 'courier', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch { return undefined; }
}

/** What npm recorded for the installed copy, when it records it (`node_modules/.package-lock.json`). */
function installedIntegrity(install: Install): string | undefined | 'unrecorded' {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(install.modulesDir, '.package-lock.json'), 'utf8')) as { packages?: Record<string, { integrity?: unknown }> };
    const entry = lock.packages?.[`node_modules/${PACKAGE}`];
    return typeof entry?.integrity === 'string' ? entry.integrity : 'unrecorded';
  } catch { return 'unrecorded'; }
}

async function switchTo(install: Install, release: Release, deps: UpdateDeps): Promise<string> {
  const fail = (why: string) => new Stop(`auto-update failed: ${why}; staying on ${deps.version}. Run: ${manualCommand(install, release.version)}`, 'failed');
  const { command, args } = installCommand(install, release.version);
  let result: RunResult;
  try {
    result = await deps.run(command, args, { cwd: install.root, timeoutMs: COMMAND_TIMEOUT_MS });
  } catch {
    throw fail(`${command} is not available`);
  }
  const entry = path.join(install.modulesDir, '@tinycloud', 'courier', 'dist', 'cli.js');
  const back = async () => {
    const undo = installCommand(install, deps.version);
    try { await deps.run(undo.command, undo.args, { cwd: install.root, timeoutMs: COMMAND_TIMEOUT_MS }); } catch { /* reported by the caller */ }
  };
  if (result.code !== 0) {
    if (installedVersion(install) !== deps.version) await back();
    throw fail(`${command} exited ${result.code}`);
  }
  const recorded = install.manager === 'npm' ? installedIntegrity(install) : 'unrecorded';
  if (installedVersion(install) !== release.version || !has(entry) || (recorded !== 'unrecorded' && recorded !== release.integrity)) {
    await back();
    throw fail(`the installed copy is not ${release.version} with the verified integrity; put ${deps.version} back`);
  }
  return fs.realpathSync(entry);
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

    const stateFile = path.join(profileDir(), STATE_FILE);
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
      const release = parseRelease(await getJson(deps, `${REGISTRY}/${PACKAGE.replace('/', '%2f')}/latest`, REGISTRY_TIMEOUT_MS, 'latest'), deps);
      if (!isStable(release.version) || compareSemver(release.version, deps.version) <= 0) { save('current'); return none; }
      if (!release.provenance) throw new Stop(`no npm provenance for ${release.version}, staying on ${deps.version}`, 'refused');
      assertWritable(install, release, deps);
      assertServable(release, deps);
      await checkProvenance(release, deps);
      await checkTarball(release, deps);
      await auditStaged(release, deps);
      const entry = await switchTo(install, release, deps);
      save(`updated to ${release.version}`);
      deps.log(`${PACKAGE} updated ${deps.version} → ${release.version} (${install.manager}${install.scope === 'global' ? ' global' : ` in ${install.root}`})`);
      return { kind: 'updated', from: deps.version, to: release.version, entry };
    } catch (e) {
      if (e instanceof Stop) save(e.result);
      else save('error');
      throw e;
    }
  } catch (e) {
    deps.log(e instanceof Stop ? e.message : `auto-update skipped: ${e instanceof Error ? e.message : String(e)}`);
    return none;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the real world

function runProcess(command: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false', npm_config_loglevel: 'error' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 1_000_000) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export interface RerunOptions {
  /** Stdin is a terminal: a Ctrl-C reaches the child itself, so SIGINT is forwarded only if the child outlasts `graceMs`. */
  interactive?: boolean;
  graceMs?: number;
}

/**
 * Run `entry` with `argv` as a child that owns this process's stdio, forward stop signals to it, and give back its exit code.
 * SIGTERM and SIGHUP are forwarded at once. SIGINT is too, unless a terminal is attached: then Ctrl-C has already
 * interrupted the child (same foreground group), and forwarding it as well would be a second SIGINT, which `watch` takes
 * as "stop now". In that case the child gets one SIGINT only if it is still running after `graceMs`, so a `kill -INT` sent to
 * this process alone never leaves the child behind.
 */
export function runOnNewVersion(entry: string, argv: string[], env: NodeJS.ProcessEnv = process.env, opts: RerunOptions = {}): Promise<number> {
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
  const graceMs = opts.graceMs ?? 5_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', env: { ...env, [REEXEC_ENV]: '1' } });
    let pendingInt: NodeJS.Timeout | undefined;
    const onInt = () => {
      if (!interactive) { child.kill('SIGINT'); return; }
      pendingInt ??= setTimeout(() => { child.kill('SIGINT'); }, graceMs);
    };
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
      process.stderr.write(`${PACKAGE}: could not start the updated copy (${e.message}); run the command again\n`);
      done(1);
    });
    child.once('close', (code, signal) => { done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)); });
  });
}

/**
 * Entry for `cli.ts`: the check with the real registry, disk and package manager. Returns the argv to run and, when
 * the package was updated, the new `dist/cli.js` to re-run it with.
 */
export async function autoUpdate(argv: string[]): Promise<{ argv: string[]; entry?: string }> {
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
    log: (line) => { process.stderr.write(`${PACKAGE}: ${line}\n`); },
  }, optOut);
  return result.kind === 'updated' ? { argv: kept, entry: result.entry } : { argv: kept };
}
