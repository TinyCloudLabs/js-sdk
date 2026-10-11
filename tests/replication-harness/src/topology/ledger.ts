import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResourceRef } from "../contracts/lifecycle";

export type LedgerRecord = { op: "intent"; kind: ResourceRef["kind"]; name: string; labels: Record<string, string> } | { op: "created"; ref: ResourceRef };
export class ResourceLedger {
  readonly records: LedgerRecord[] = [];
  constructor(readonly path: string) {}
  async intent(kind: ResourceRef["kind"], name: string, labels: Record<string, string>): Promise<void> {
    const record: LedgerRecord = { op: "intent", kind, name, labels };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.records.push(record);
  }
  async created(ref: ResourceRef): Promise<void> {
    const record: LedgerRecord = { op: "created", ref };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.records.push(record);
  }
  resources(): ResourceRef[] {
    const byName = new Map<string, ResourceRef>();
    for (const record of this.records) if (record.op === "created") byName.set(`${record.ref.kind}:${record.ref.name}`, record.ref);
    return [...byName.values()];
  }
  static async read(path: string): Promise<LedgerRecord[]> {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerRecord);
  }
}
