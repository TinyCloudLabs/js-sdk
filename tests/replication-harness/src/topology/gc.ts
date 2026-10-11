import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunEnvironment, ResourceRef } from "../contracts/lifecycle";
import { Docker } from "./docker";
import { ResourceLedger } from "./ledger";

export async function dockerDoctor(command?: readonly string[]): Promise<{ ok: boolean; version?: string; error?: string }> {
  const docker = new Docker(command);
  try { const result = await docker.run(["version", "--format", "{{.Server.Version}}"], { deadlineMs: 15_000 }); return { ok: true, version: result.stdout.trim() }; }
  catch (error) { return { ok: false, error: String(error) }; }
}
export async function gc(environment: RunEnvironment, options: { olderThanMs?: number; now?: number } = {}): Promise<{ removed: ResourceRef[]; errors: string[] }> {
  const docker = new Docker(environment.docker);
  const cutoff = (options.now ?? Date.now()) - (options.olderThanMs ?? 2 * 60 * 60_000);
  const removed: ResourceRef[] = [], errors: string[] = [];
  const deleted = new Set<string>();
  async function remove(kind: ResourceRef["kind"], name: string, labels: Record<string, string>): Promise<void> {
    const key = `${kind}:${name}`;
    if (deleted.has(key)) return;
    const args = kind === "container" ? ["rm", "-f", "-v", name] : [kind, "rm", name];
    await docker.run(args);
    deleted.add(key);
    removed.push({ kind, name, labels });
  }
  async function metadata(kind: ResourceRef["kind"], name: string): Promise<{ createdAt: number; labels: Record<string, string> } | undefined> {
    const args = kind === "container" ? ["inspect", "--format", "{{json .}}", name] : [kind, "inspect", "--format", "{{json .}}", name];
    const data = JSON.parse((await docker.run(args)).stdout) as Record<string, unknown>;
    const labels = (kind === "container" ? (data.Config as Record<string, unknown>)?.Labels : data.Labels) as Record<string, string> | undefined;
    const created = Date.parse(String(data.Created ?? data.CreatedAt ?? ""));
    if (!labels?.["tc893.run"] || !labels["tc893.topo"] || !Number.isFinite(created)) return undefined;
    return { createdAt: created, labels };
  }
  const listing = {
    container: ["ps", "-aq", "--filter", "label=tc893.run"],
    volume: ["volume", "ls", "-q", "--filter", "label=tc893.run"],
    network: ["network", "ls", "-q", "--filter", "label=tc893.run"],
  } satisfies Record<ResourceRef["kind"], string[]>;
  for (const kind of ["container", "volume", "network"] as const) {
    try {
      const names = (await docker.run(listing[kind])).stdout.split("\n").filter(Boolean);
      for (const name of names) {
        try {
          const resource = await metadata(kind, name);
          if (resource && resource.createdAt <= cutoff) await remove(kind, name, resource.labels);
        } catch (error) { errors.push(`${kind} ${name}: ${String(error)}`); }
      }
    } catch (error) { errors.push(String(error)); }
  }
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "ledger.jsonl") {
        const file = await stat(path);
        if (file.mtimeMs > cutoff) continue;
        try {
          const records = await ResourceLedger.read(path);
          const completed = new Set(records.filter((record) => record.op === "created").map((record) => `${record.ref.kind}:${record.ref.name}`));
          for (const record of records) if (record.op === "intent" && !completed.has(`${record.kind}:${record.name}`)) {
            try {
              const resource = await metadata(record.kind, record.name);
              if (resource && resource.labels["tc893.run"] === record.labels["tc893.run"] && resource.createdAt <= cutoff) await remove(record.kind, record.name, resource.labels);
            } catch (error) {
              if (!(error instanceof Error && /No such|not found/i.test(error.message))) errors.push(`${record.kind} ${record.name}: ${String(error)}`);
            }
          }
        } catch (error) { errors.push(`ledger ${path}: ${String(error)}`); }
      }
    }
  }
  try { await walk(environment.resultsDir); } catch (error) { errors.push(String(error)); }
  return { removed, errors };
}
