import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, readlink, symlink, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HarnessError } from "../contracts/common";
import type { ResolvedSut } from "../contracts/lifecycle";
import type { SutResolutionRequest } from "../contracts/frozen";

const PACKAGE_NAMES = { cli: "@tinycloud/cli", nodeSdk: "@tinycloud/node-sdk" } as const;
type JsonRecord = Record<string, unknown>;
interface PackageMetadata extends JsonRecord { version?: string; bin?: string | Record<string, string>; dist?: { integrity?: string } }
interface CachedPublishedSut {
  readonly sut: ResolvedSut;
  readonly prefix: string;
  readonly lockfileSha256: string;
  readonly cliFilesSha256: string;
  readonly sdkFilesSha256: string;
  readonly cliIntegrity: string;
  readonly sdkIntegrity: string;
}
export function publishedCacheRunDirectory(cacheRoot: string, runId: string): string {
  return join(cacheRoot, "tc893-sut-cache", runId);
}
export function publishedCachePrefix(cacheRoot: string, runId: string, cliVersion: string, nodeSdkVersion: string): string {
  return join(publishedCacheRunDirectory(cacheRoot, runId), `tc893-${cliVersion}+${nodeSdkVersion}`);
}
const publishedCacheRunId = `${process.pid}-${randomUUID()}`;
const publishedInstalls = new Map<string, Promise<CachedPublishedSut>>();
process.once("exit", () => rmSync(publishedCacheRunDirectory(tmpdir(), publishedCacheRunId), { recursive: true, force: true }));
export async function cleanupPublishedSutCache(cacheRoot = tmpdir(), runId = publishedCacheRunId): Promise<void> {
  await Promise.allSettled([...publishedInstalls.values()]);
  await rm(publishedCacheRunDirectory(cacheRoot, runId), { recursive: true, force: true });
  if (cacheRoot === tmpdir() && runId === publishedCacheRunId) publishedInstalls.clear();
}
interface NpmMetadata { version: string; integrity?: string }

function fail(message: string, detail?: unknown): never {
  throw new HarnessError("PREFLIGHT_FAILED", message, detail);
}
function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label} must be an object`);
  return value as JsonRecord;
}
function hasSdkPhase1Export(value: unknown): boolean {
  return value !== null && typeof value === "object" && "sqliteReplicaStorage" in value;
}
async function readJson(path: string, label: string): Promise<JsonRecord> {
  try { return asRecord(JSON.parse(await readFile(path, "utf8")) as unknown, label); }
  catch (error) { return fail(`${label} is missing or invalid`, { path, error: String(error) }); }
}

export async function resolveAnchoredPackage(prefixInput: string, name: string): Promise<{ packageJson: string; data: PackageMetadata }> {
  const prefix = await realpath(prefixInput);
  const req = createRequire(join(prefix, "package.json"));
  let candidate: string;
  try {
    candidate = name === PACKAGE_NAMES.nodeSdk
      ? Bun.resolveSync(`${name}/package.json`, join(prefix, "package.json"))
      : req.resolve(`${name}/package.json`);
  } catch (error) { return fail(`Cannot resolve ${name}/package.json from ${prefix}`, String(error)); }
  const packageJson = await realpath(candidate);
  const nodeModules = `${prefix}${sep}node_modules${sep}`;
  if (!packageJson.startsWith(nodeModules)) fail(`${name} resolved outside the anchored node_modules directory`, { prefix, packageJson });
  return { packageJson, data: await readJson(packageJson, `${name} package.json`) as PackageMetadata };
}

async function npmView(name: string, version: string): Promise<NpmMetadata> {
  const proc = Bun.spawn(["npm", "view", `${name}@${version}`, "version", "dist.integrity", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (exitCode !== 0) return fail(`npm view failed for ${name}@${version}`, stderr);
  const parsed: unknown = JSON.parse(stdout);
  if (Array.isArray(parsed) && typeof parsed[0] === "string" && (parsed[1] === undefined || typeof parsed[1] === "string")) return { version: parsed[0], integrity: parsed[1] };
  if (parsed !== null && typeof parsed === "object" && typeof (parsed as JsonRecord).version === "string") {
    const integrity = (parsed as JsonRecord)["dist.integrity"];
    if (integrity === undefined || typeof integrity === "string") return { version: (parsed as JsonRecord).version as string, integrity };
  }
  if (typeof parsed === "string") return { version: parsed };
  return fail(`npm view returned an unexpected result for ${name}@${version}`, parsed);
}

export async function checkInstalledIntegrity(prefix: string, packageJson: string, name: string, expected?: string): Promise<void> {
  if (typeof expected !== "string" || expected.length === 0) fail(`${name} has no registry integrity`, { name });
  const lockPath = join(prefix, "node_modules", ".package-lock.json");
  const lock = await readJson(lockPath, "Installed npm lockfile");
  const packages = asRecord(lock.packages, "Installed npm lockfile packages");
  const lockKey = relative(prefix, dirname(packageJson)).split(sep).join("/");
  const lockEntry = asRecord(packages[lockKey], `Lock entry for ${name}`);
  const locked = lockEntry.integrity;
  if (typeof locked !== "string" || locked.length === 0) fail(`${name} has no installed lockfile integrity`, { lockPath, lockKey });
  if (locked !== expected) fail(`${name} integrity differs from npm registry integrity`, { expected, locked });
}
export async function installedFilesSha256(packageJson: string): Promise<string> {
  const root = await realpath(dirname(packageJson));
  const rows: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isSymbolicLink()) {
        const target = await realpath(path);
        const targetRel = relative(root, target);
        if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) fail("Installed package contains an escaping symlink", { packageJson, path, target });
        rows.push(`${rel}:link:${await readlink(path)}:${createHash("sha256").update(await readFile(target)).digest("hex")}`);
      } else if (info.isFile()) {
        rows.push(`${rel}:${info.mode & 0o777}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    }
  };
  await visit(root);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

export async function verifyInstalledFiles(packageJson: string, expected: string): Promise<void> {
  const actual = await installedFilesSha256(packageJson);
  if (actual !== expected) fail("Installed package files changed after resolution", { packageJson, expected, actual });
}

export async function resolveSdkLoader(rootInput: string, source: "workspace" | "published"): Promise<string> {
  const root = await realpath(rootInput);
  if (source === "published") return join(root, "tc893-load-node-sdk.mjs");
  const loaderRoot = join(tmpdir(), "tc893-sdk-loaders", createHash("sha256").update(root).digest("hex"));
  const modules = join(loaderRoot, "node_modules");
  await mkdir(modules, { recursive: true });
  const scopeLink = join(modules, "@tinycloud");
  try { await symlink(join(root, "node_modules", "@tinycloud"), scopeLink, "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const shimDirectory = join(modules, ".tc893");
  await mkdir(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, "load-node-sdk.mjs");
  await writeFile(shimPath, 'export * as sdk from "@tinycloud/node-sdk";\nexport const resolved = import.meta.resolve("@tinycloud/node-sdk");\n');
  return shimPath;
}

async function readFileHashes(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(`${relative(root, full).split(sep).join("/")}:${createHash("sha256").update(await readFile(full)).digest("hex")}`);
    }
  };
  await visit(directory);
  return result;
}

export async function workspaceDistSha256(root: string): Promise<string> {
  const rows = (await Promise.all(["packages/cli/dist", "packages/node-sdk/dist"].map((path) => readFileHashes(root, join(root, path))))).flat().sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

async function installPublishedFresh(request: SutResolutionRequest, prefix: string): Promise<CachedPublishedSut> {
  const cliVersion = request.cliVersion!;
  const nodeSdkVersion = request.nodeSdkVersion!;
  const npmCache = join(dirname(prefix), "npm");
  const install = Bun.spawn(["npm", "i", "--prefix", prefix, "--no-audit", "--no-fund", "--save-exact", `${PACKAGE_NAMES.cli}@${cliVersion}`, `${PACKAGE_NAMES.nodeSdk}@${nodeSdkVersion}`], { env: { ...process.env, npm_config_cache: npmCache }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
  if (exitCode !== 0) fail("npm install of the published SUT failed", { exitCode, stdout, stderr });
  const lockPath = join(prefix, "package-lock.json");
  const lockfileSha256 = createHash("sha256").update(await readFile(lockPath)).digest("hex");
  const cli = await resolveAnchoredPackage(prefix, PACKAGE_NAMES.cli);
  const nodeSdk = await resolveAnchoredPackage(prefix, PACKAGE_NAMES.nodeSdk);
  const [cliNpm, sdkNpm] = await Promise.all([npmView(PACKAGE_NAMES.cli, cliVersion), npmView(PACKAGE_NAMES.nodeSdk, nodeSdkVersion)]);
  if (cliNpm.version !== cliVersion || sdkNpm.version !== nodeSdkVersion) fail("Registry returned a version different from the exact requested SUT", { cliVersion: cliNpm.version, nodeSdkVersion: sdkNpm.version });
  await Promise.all([
    checkInstalledIntegrity(prefix, cli.packageJson, PACKAGE_NAMES.cli, cliNpm.integrity),
    checkInstalledIntegrity(prefix, nodeSdk.packageJson, PACKAGE_NAMES.nodeSdk, sdkNpm.integrity),
  ]);
  const bin = typeof cli.data.bin === "string" ? cli.data.bin : cli.data.bin?.tc;
  if (!bin) fail("Resolved CLI package has no tc bin entry", cli.data.bin);
  let entry: string;
  try { entry = await realpath(resolve(dirname(cli.packageJson), bin)); }
  catch (error) { return fail("Resolved CLI entry is missing", { packageJson: cli.packageJson, bin, error: String(error) }); }
  const nodeModules = `${prefix}${sep}node_modules${sep}`;
  if (!entry.startsWith(nodeModules)) fail("Resolved CLI entry escapes the anchored node_modules directory", { prefix, entry });
  const shimPath = join(prefix, "tc893-load-node-sdk.mjs");
  await writeFile(shimPath, 'export * as sdk from "@tinycloud/node-sdk";\nexport const resolved = import.meta.resolve("@tinycloud/node-sdk");\n');
  const sdkShim = await import(pathToFileURL(shimPath).href) as { sdk: unknown; resolved: string };
  if (!hasSdkPhase1Export(sdkShim.sdk)) fail("Published SDK lacks sqliteReplicaStorage required for Phase 1", { version: nodeSdk.data.version, cliEntry: entry, cliVersion: cli.data.version });
  const [cliFilesSha256, sdkFilesSha256] = await Promise.all([installedFilesSha256(cli.packageJson), installedFilesSha256(nodeSdk.packageJson)]);
  return {
    prefix,
    lockfileSha256,
    cliFilesSha256,
    sdkFilesSha256,
    cliIntegrity: cliNpm.integrity!,
    sdkIntegrity: sdkNpm.integrity!,
    sut: {
      source: "published", root: prefix, lockfileSha256,
      cli: { version: cli.data.version ?? cliNpm.version, packageJson: cli.packageJson, entry, integrity: cliNpm.integrity },
      nodeSdk: { version: nodeSdk.data.version ?? sdkNpm.version, packageJson: nodeSdk.packageJson, entry: sdkShim.resolved, condition: "import", integrity: sdkNpm.integrity },
    },
  };
}

async function installPublished(request: SutResolutionRequest): Promise<ResolvedSut> {
  const cliVersion = request.cliVersion;
  const nodeSdkVersion = request.nodeSdkVersion;
  if (!cliVersion || !nodeSdkVersion) fail("Published SUT requires exact CLI and node-sdk versions");
  const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (!exactSemver.test(cliVersion) || !exactSemver.test(nodeSdkVersion)) fail("Published SUT versions must be exact semver versions");
  const key = `${cliVersion}+${nodeSdkVersion}`;
  let install = publishedInstalls.get(key);
  if (!install) {
    const prefix = publishedCachePrefix(tmpdir(), publishedCacheRunId, cliVersion, nodeSdkVersion);
    install = installPublishedFresh(request, prefix);
    publishedInstalls.set(key, install);
    void install.catch(() => { if (publishedInstalls.get(key) === install) publishedInstalls.delete(key); });
  }
  const cached = await install;
  const [cliNpm, sdkNpm] = await Promise.all([npmView(PACKAGE_NAMES.cli, cliVersion), npmView(PACKAGE_NAMES.nodeSdk, nodeSdkVersion)]);
  if (cliNpm.version !== cliVersion || sdkNpm.version !== nodeSdkVersion ||
    cliNpm.integrity !== cached.cliIntegrity || sdkNpm.integrity !== cached.sdkIntegrity) {
    fail("Registry metadata changed after published SUT resolution", { cliVersion: cliNpm.version, nodeSdkVersion: sdkNpm.version });
  }
  const [actualLock, cli, nodeSdk] = await Promise.all([
    readFile(join(cached.prefix, "package-lock.json")).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
    resolveAnchoredPackage(cached.prefix, PACKAGE_NAMES.cli),
    resolveAnchoredPackage(cached.prefix, PACKAGE_NAMES.nodeSdk),
  ]);
  if (actualLock !== cached.lockfileSha256) fail("Published SUT lockfile changed after resolution", { expected: cached.lockfileSha256, actual: actualLock });
  await Promise.all([
    checkInstalledIntegrity(cached.prefix, cli.packageJson, PACKAGE_NAMES.cli, cliNpm.integrity),
    checkInstalledIntegrity(cached.prefix, nodeSdk.packageJson, PACKAGE_NAMES.nodeSdk, sdkNpm.integrity),
    verifyInstalledFiles(cli.packageJson, cached.cliFilesSha256),
    verifyInstalledFiles(nodeSdk.packageJson, cached.sdkFilesSha256),
  ]);
  return cached.sut;
}

export async function resolveSut(request: SutResolutionRequest): Promise<ResolvedSut> {
  if (request.mode === "published") return installPublished(request);
  const root = await realpath(request.root ?? process.cwd());
  const cliPackage = join(root, "packages", "cli", "package.json");
  const sdkPackage = join(root, "packages", "node-sdk", "package.json");
  const [cliRaw, sdkRaw] = await Promise.all([readJson(cliPackage, "Workspace CLI package"), readJson(sdkPackage, "Workspace node-sdk package")]);
  const cliData = cliRaw as PackageMetadata;
  const sdkData = sdkRaw as PackageMetadata;
  const shimPath = await resolveSdkLoader(root, "workspace");
  const sdkShim = await import(pathToFileURL(shimPath).href) as { sdk: unknown; resolved: string };
  if (!hasSdkPhase1Export(sdkShim.sdk)) fail("Workspace SDK lacks sqliteReplicaStorage required for Phase 1", { version: sdkData.version });
  const distSha256 = await workspaceDistSha256(root);
  const gitSha = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
  const dirty = (await Bun.$`git -C ${root} status --porcelain`.text()).trim().length > 0;
  return {
    source: "workspace", root, gitSha, dirty, distSha256,
    cli: { version: cliData.version ?? "unknown", packageJson: cliPackage, entry: join(root, "packages", "cli", "dist", "index.js") },
    nodeSdk: { version: sdkData.version ?? "unknown", packageJson: sdkPackage, entry: sdkShim.resolved, condition: "import" },
  };
}
