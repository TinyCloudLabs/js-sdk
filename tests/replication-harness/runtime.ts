import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ImageResolver } from "./src/contracts/frozen";
import type { RunEnvironment, ResolvedImage, ResolvedSut } from "./src/contracts/lifecycle";
import type { RunInputs } from "./src/contracts/gate";
import type { NodeImageRef } from "./src/contracts/topology";
import { realClock } from "./src/contracts/clock";
import { Docker } from "./src/topology/docker";
import { NodeImageResolver } from "./src/topology/images";
import { assembleHarnessRuntime, loadS2RuntimeAdapters } from "./src/runner/runtime";
import { createRequirementProbe } from "./src/runner/requirements";
import { readJunitPrecondition } from "./src/gate/junit";
import { defaultWorkspaceRoot } from "./src/clients/sut";
import type { configureGateRuntime } from "./bin/gate-adapters";

export { assembleHarnessRuntime, loadS2RuntimeAdapters } from "./src/runner/runtime";
export type { ClientSecretCollector, HarnessClientFactories, HarnessRuntime, HarnessRuntimeAdapters } from "./src/runner/runtime";

type GateRuntimeRegistrar = typeof configureGateRuntime;
const imageKey = (ref: NodeImageRef): string => JSON.stringify(ref);
function dockerCommand(): string[] {
  return process.env.DOCKER?.trim() ? process.env.DOCKER.trim().split(/\s+/) : ["sudo", "-n", "docker"];
}
function sutFilePath(path: string): string {
  return path.startsWith("file:") ? fileURLToPath(path) : path;
}

export async function exportSutArtifacts(outDir: string, sut: ResolvedSut): Promise<void> {
  const files = [
    [sut.cli.packageJson, "sut/cli/package.json"],
    [sut.cli.entry, "sut/cli/entry.js"],
    [sut.nodeSdk.packageJson, "sut/node-sdk/package.json"],
    [sut.nodeSdk.entry, "sut/node-sdk/entry.js"],
  ] as const;
  for (const [source, relativePath] of files) {
    const destination = join(outDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sutFilePath(source), destination);
  }
  if (sut.source === "published") {
    if (!sut.root) throw new Error("PUBLISHED_SUT_ROOT_MISSING: resolve output has no install prefix");
    const publishedDir = join(outDir, "sut/published");
    await mkdir(publishedDir, { recursive: true });
    await Promise.all([
      copyFile(join(sut.root, "package.json"), join(publishedDir, "package.json")),
      copyFile(join(sut.root, "package-lock.json"), join(publishedDir, "package-lock.json")),
    ]);
  }
  await writeFile(join(outDir, "sut/selection.json"), `${JSON.stringify({ source: sut.source }, null, 2)}\n`);
}

export async function registerGateRuntime(configure: GateRuntimeRegistrar): Promise<void> {
  const adapters = await loadS2RuntimeAdapters();
  const assembly = assembleHarnessRuntime(adapters);
  const docker = dockerCommand();
  const imageCache = new Map<string, ResolvedImage>();
  const disposers = new WeakMap<RunEnvironment, () => Promise<void>>();
  const resolver = new NodeImageResolver(new Docker(docker));
  const imageResolver: ImageResolver = async (ref) => {
    const key = imageKey(ref);
    const cached = imageCache.get(key);
    if (cached) return cached;
    const image = await resolver.resolve(ref);
    imageCache.set(key, image);
    return image;
  };
  const createRunEnvironment = async (inputs: RunInputs, resultsDir: string, inputsDir?: string): Promise<RunEnvironment> => {
    imageCache.set(imageKey("prod"), inputs.image);
    if (inputs.gate) imageCache.set(imageKey("default"), inputs.image);
    let sut: ResolvedSut;
    let cleanup: (() => Promise<void>) | undefined;
    if (inputs.sut.source === "workspace") {
      sut = await adapters.resolveSut({ mode: "workspace", root: defaultWorkspaceRoot() });
    } else {
      if (!inputsDir) throw new Error("PUBLISHED_SUT_INPUTS_DIR_MISSING: leg did not provide the resolve artifact directory");
      const prefix = await mkdtemp(join(tmpdir(), "tc893-published-sut-"));
      cleanup = async () => rm(prefix, { recursive: true, force: true });
      try {
        const packageFile = join(inputsDir, "sut/published/package.json");
        const lockFile = join(inputsDir, "sut/published/package-lock.json");
        const lockHash = createHash("sha256").update(await readFile(lockFile)).digest("hex");
        if (lockHash !== inputs.sut.lockfileSha256) throw new Error(`SUT_LOCKFILE_SHA256_MISMATCH: expected ${inputs.sut.lockfileSha256}, got ${lockHash}`);
        await Promise.all([copyFile(packageFile, join(prefix, "package.json")), copyFile(lockFile, join(prefix, "package-lock.json"))]);
        const install = Bun.spawn(["npm", "ci", "--no-audit", "--no-fund"], { cwd: prefix, stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
        if (exitCode !== 0) throw new Error(`PUBLISHED_SUT_INSTALL_FAILED: npm ci exited ${exitCode}: ${stderr || stdout}`);
        const [cli, nodeSdk] = await Promise.all([
          adapters.resolveAnchoredPackage(prefix, "@tinycloud/cli"),
          adapters.resolveAnchoredPackage(prefix, "@tinycloud/node-sdk"),
        ]);
        await Promise.all([
          adapters.checkInstalledIntegrity(prefix, cli.packageJson, "@tinycloud/cli", inputs.sut.cli.integrity),
          adapters.checkInstalledIntegrity(prefix, nodeSdk.packageJson, "@tinycloud/node-sdk", inputs.sut.nodeSdk.integrity),
        ]);
        const cliBin = typeof cli.data.bin === "string" ? cli.data.bin
          : cli.data.bin && typeof cli.data.bin === "object" ? (cli.data.bin as Record<string, unknown>).tc : undefined;
        const cliVersion = cli.data.version;
        const sdkVersion = nodeSdk.data.version;
        if (typeof cliBin !== "string" || typeof cliVersion !== "string" || typeof sdkVersion !== "string") {
          throw new Error("PUBLISHED_SUT_PACKAGE_METADATA_INVALID: installed packages lack version or CLI bin metadata");
        }
        const cliEntry = resolve(dirname(cli.packageJson), cliBin);
        const sdkLoader = await adapters.resolveSdkLoader(prefix, "published");
        const sdkShim = await import(pathToFileURL(sdkLoader).href) as { resolved?: unknown };
        if (typeof sdkShim.resolved !== "string") throw new Error("PUBLISHED_SUT_SDK_LOADER_INVALID: SDK loader did not resolve an entry");
        sut = {
          source: "published", root: prefix, lockfileSha256: lockHash,
          cli: { version: cliVersion, packageJson: cli.packageJson, entry: cliEntry, integrity: inputs.sut.cli.integrity },
          nodeSdk: { version: sdkVersion, packageJson: nodeSdk.packageJson, entry: sdkShim.resolved, condition: "import", integrity: inputs.sut.nodeSdk.integrity },
        };
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
    const environment: RunEnvironment = {
      runId: inputs.subject.runId ?? `local-${crypto.randomUUID()}`,
      resultsDir,
      clock: realClock,
      docker,
      sut,
      image(ref) {
        const image = imageCache.get(imageKey(ref));
        if (!image) throw new Error(`runtime image was not resolved: ${imageKey(ref)}`);
        return image;
      },
      slackMs: Number(process.env.TC893_SLACK_MS ?? 3000),
      teardownMs: Number(process.env.TC893_TEARDOWN_MS ?? 60_000),
    };
    if (cleanup) disposers.set(environment, cleanup);
    return environment;
  };
  configure({
    sutResolver: adapters.resolveSut,
    imageResolver,
    exportSutArtifacts,
    topologyFactory: assembly.topologyFactory,
    collectClientSecrets: assembly.collectClientSecrets,
    probeRequirement: createRequirementProbe(),
    junitPrecondition: async (subject, directory) => directory ? readJunitPrecondition(directory, subject) : null,
    fetchInfo: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
      const payload = await response.json() as { version?: unknown; features?: unknown };
      if (typeof payload.version !== "string") throw new Error(`GET ${url} returned no version`);
      return { version: payload.version, features: Array.isArray(payload.features) ? payload.features.filter((value): value is string => typeof value === "string") : [] };
    },
    createRunEnvironment,
    disposeRunEnvironment: async (environment) => { await disposers.get(environment)?.(); disposers.delete(environment); },
  });
}
