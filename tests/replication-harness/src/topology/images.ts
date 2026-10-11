import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeImageRef } from "../contracts/topology";
import { HarnessError } from "../contracts/common";
import type { ResolvedImage } from "../contracts/lifecycle";
import { Docker, labels } from "./docker";
import { disposeResources } from "./factory";
import { ResourceLedger } from "./ledger";
interface ImageDefaults { images: Record<string, string>; postgres: string; postgresC: string; toxiproxy: string }
export class NodeImageResolver {
  private defaults?: Promise<ImageDefaults>;
  constructor(private readonly docker: Docker, private readonly defaultsPath = new URL("../../defaults.json", import.meta.url).pathname, private readonly probeRoot = process.env.TC893_RESULTS ?? "results", private readonly probeStartDeadlineMs = 120_000) {}
  private load(): Promise<ImageDefaults> {
    this.defaults ??= readFile(this.defaultsPath, "utf8").then((text) => JSON.parse(text) as ImageDefaults);
    return this.defaults;
  }
  async resolve(ref: NodeImageRef): Promise<ResolvedImage> {
    try {
      const defaults = await this.load();
      let role: ResolvedImage["role"] = "custom";
      let imageRef: string;
      if (typeof ref === "string") {
        role = ref;
        imageRef = ref === "prod" ? await this.productionRef() : defaults.images[ref];
      } else if ("ref" in ref) imageRef = ref.ref;
      else throw new HarnessError("IMAGE_RESOLVE_FAILED", "--node-build belongs to S6a");
      if (!imageRef) throw new Error(`unknown node image ${String(ref)}`);
      const tagRef = imageRef.split("@")[0];
      await this.docker.run(["pull", tagRef]);
      const inspected = await this.docker.run(["image", "inspect", tagRef, "--format", "{{json .RepoDigests}}"]);
      const digests = JSON.parse(inspected.stdout.trim()) as string[];
      const digestRef = imageRef.includes("@sha256:") ? imageRef : digests.find((item) => item.startsWith(`${tagRef.split(":")[0]}@sha256:`));
      if (!digestRef) throw new Error(`registry returned no digest for ${tagRef}`);
      const digest = digestRef.slice(digestRef.lastIndexOf("@") + 1);
      const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
      const topoId = `image-probe-${crypto.randomUUID().slice(0, 8)}`;
      const probeName = `tc893-${topoId}`;
      const runId = "image-resolver";
      const resourceLabels = { "tc893.run": runId, "tc893.topo": topoId };
      const ledger = new ResourceLedger(join(this.probeRoot, runId, topoId, "ledger.jsonl"));
      await ledger.intent("container", probeName, resourceLabels);
      try {
        await this.docker.run(["run", "-d", "--name", probeName, "-p", "127.0.0.1::8000", ...labels(runId, topoId), "-e", "TINYCLOUD_KEYS__TYPE=Static", "-e", `TINYCLOUD_KEYS__SECRET=${secret}`, "-e", "TINYCLOUD_PORT=8000", "-e", "ROCKET_PORT=8000", digestRef], { deadlineMs: this.probeStartDeadlineMs });
        await ledger.created({ kind: "container", name: probeName, labels: resourceLabels });
        const portText = (await this.docker.run(["port", probeName, "8000/tcp"], { deadlineMs: 10_000 })).stdout.trim();
        const url = `http://127.0.0.1:${portText.slice(portText.lastIndexOf(":") + 1)}`;
        let info: { version: string; features?: string[] } | undefined;
        const until = Date.now() + 60_000;
        while (!info && Date.now() < until) {
          try { const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(1500) }); if (response.ok) info = await response.json() as typeof info; }
          catch { await Bun.sleep(250); }
          if (!info) await Bun.sleep(250);
        }
        if (!info) {
          const logs = await this.docker.tryRun(["logs", probeName], { deadlineMs: 2000 });
          const detail = `${logs.stdout}${logs.stderr}`.replaceAll(secret, "[REDACTED]").slice(-2048);
          throw new Error(`image probe /info timed out: ${detail}`);
        }
        const nodeVersion = info.version;
        const pinned = `${tagRef.split("@")[0]}@${digest}`;
        return { role, ref: imageRef, digest, pinned, nodeVersion, features: info.features ?? [] };
      } finally {
        const cleanup = await disposeResources(this.docker, ledger.resources(), [], 10_000, false, resourceLabels);
        if (cleanup.errors.length) throw new HarnessError("IMAGE_RESOLVE_FAILED", `image probe cleanup failed for ${probeName}`, cleanup.errors);
      }
    } catch (error) {
      if (error instanceof HarnessError && error.code === "IMAGE_RESOLVE_FAILED") throw error;
      throw new HarnessError("IMAGE_RESOLVE_FAILED", `could not resolve node image ${JSON.stringify(ref)}`, error);
    }
  }
  private async productionRef(): Promise<string> {
    const response = await fetch("https://tee.node.tinycloud.xyz/info");
    if (!response.ok) throw new Error(`production /info returned ${response.status}`);
    const info = await response.json() as { version: string };
    return `ghcr.io/tinycloudlabs/tinycloud-node:${info.version}-dstack`;
  }
}
