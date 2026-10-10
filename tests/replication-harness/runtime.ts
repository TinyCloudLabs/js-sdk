import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realClock } from "./src/contracts/clock";
import type { ImageResolver } from "./src/contracts/frozen";
import type { RunEnvironment, ResolvedImage, ResolvedSut } from "./src/contracts/lifecycle";
import type { RunInputs } from "./src/contracts/gate";
import type { NodeImageRef } from "./src/contracts/topology";
import { Docker } from "./src/topology/docker";
import { NodeImageResolver } from "./src/topology/images";
import { assembleHarnessRuntime, loadS2RuntimeAdapters } from "./src/runner/runtime";
import type { configureGateRuntime } from "./bin/gate-adapters";

export { assembleHarnessRuntime, loadS2RuntimeAdapters } from "./src/runner/runtime";
export type { ClientSecretCollector, HarnessClientFactories, HarnessRuntime, HarnessRuntimeAdapters } from "./src/runner/runtime";

type GateRuntimeRegistrar = typeof configureGateRuntime;
const imageKey = (ref: NodeImageRef): string => JSON.stringify(ref);
function dockerCommand(): string[] {
  return process.env.DOCKER?.trim() ? process.env.DOCKER.trim().split(/\s+/) : ["sudo", "-n", "docker"];
}

async function exportSutArtifacts(outDir: string, sut: ResolvedSut): Promise<void> {
  const files = [
    [sut.cli.packageJson, "sut/cli/package.json"],
    [sut.cli.entry, "sut/cli/entry.js"],
    [sut.nodeSdk.packageJson, "sut/node-sdk/package.json"],
    [sut.nodeSdk.entry, "sut/node-sdk/entry.js"],
  ] as const;
  for (const [source, relativePath] of files) {
    const destination = join(outDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await writeFile(join(outDir, "sut/selection.json"), `${JSON.stringify({ source: sut.source, root: sut.root }, null, 2)}\n`);
}

export async function registerGateRuntime(configure: GateRuntimeRegistrar): Promise<void> {
  const adapters = await loadS2RuntimeAdapters();
  const assembly = assembleHarnessRuntime(adapters);
  const docker = dockerCommand();
  const imageCache = new Map<string, ResolvedImage>();
  const resolver = new NodeImageResolver(new Docker(docker));
  const imageResolver: ImageResolver = async (ref) => {
    const key = imageKey(ref);
    const cached = imageCache.get(key);
    if (cached) return cached;
    const image = await resolver.resolve(ref);
    imageCache.set(key, image);
    return image;
  };
  const createRunEnvironment = (inputs: RunInputs, resultsDir: string): RunEnvironment => {
    imageCache.set(imageKey("prod"), inputs.image);
    if (inputs.gate) imageCache.set(imageKey("default"), inputs.image);
    return {
      runId: inputs.subject.runId ?? `local-${crypto.randomUUID()}`,
      resultsDir,
      clock: realClock,
      docker,
      sut: inputs.sut,
      image(ref) {
        const image = imageCache.get(imageKey(ref));
        if (!image) throw new Error(`runtime image was not resolved: ${imageKey(ref)}`);
        return image;
      },
      slackMs: Number(process.env.TC893_SLACK_MS ?? 3000),
      teardownMs: Number(process.env.TC893_TEARDOWN_MS ?? 60_000),
    };
  };
  configure({
    sutResolver: adapters.resolveSut,
    imageResolver,
    exportSutArtifacts,
    topologyFactory: assembly.topologyFactory,
    collectClientSecrets: assembly.collectClientSecrets,
    fetchInfo: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
      const payload = await response.json() as { version?: unknown; features?: unknown };
      if (typeof payload.version !== "string") throw new Error(`GET ${url} returned no version`);
      return { version: payload.version, features: Array.isArray(payload.features) ? payload.features.filter((value): value is string => typeof value === "string") : [] };
    },
    createRunEnvironment,
  });
}
