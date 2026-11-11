import { ServiceContext } from "@tinycloud/sdk-services/context";
import { KVService } from "@tinycloud/sdk-services/kv";
import { SQLService } from "@tinycloud/sdk-services/sql";

const session = {
  delegationHeader: { Authorization: "Bearer fixture" },
  delegationCid: "fixture",
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  verificationMethod: "did:key:fixture",
  jwk: {},
};

export async function readSql(host: string): Promise<number> {
  const context = new ServiceContext({ hosts: [host], session, invoke: () => ({ "x-fixture-op": "sql" }) });
  const service = new SQLService({});
  service.initialize(context);
  const start = performance.now();
  const response = await service.db("main").query("SELECT 1");
  if (!response.ok) throw new Error(response.error.message);
  return performance.now() - start;
}

export async function syncPrefixes(host: string, start = 0, count = 8): Promise<void> {
  await Promise.all(Array.from({ length: count }, async (_, offset) => {
    const index = start + offset;
    const context = new ServiceContext({
      hosts: [host], session, priority: "background",
      invoke: () => ({ "x-fixture-op": "replica", "x-fixture-prefix": `notes-${index}/` }),
    });
    const service = new KVService({});
    service.initialize(context);
    const response = await service.changes({ prefix: `notes-${index}/` });
    if (!response.ok) throw new Error(response.error.message);
  }));
}

if (typeof self !== "undefined" && "importScripts" in self) {
  const worker = self as unknown as {
    onmessage: (event: MessageEvent<{ host: string; start: number; count: number }>) => void;
    postMessage(message: string): void;
  };
  worker.onmessage = ({ data }) => {
    void syncPrefixes(data.host, data.start, data.count).then(
      () => worker.postMessage("done"),
      (error: Error) => worker.postMessage(error.message),
    );
  };
}
