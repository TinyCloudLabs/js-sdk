/**
 * Real-consumer harness for refused secret writes (TC-834 S1-T5).
 *
 * Chain: a real `KVService` whose context fetch is stubbed with one node
 * response → a network-encrypted `DataVaultService` → `SecretsService.put` →
 * `handleError(cliErrorFromService(error))`. `handleError` exits the process,
 * so the test spawns this file once per scenario (non-interactive, so the
 * error renders as JSON) and reads the output and exit code.
 *
 * Usage: bun secrets-put-classification.ts <capability-401|plain-401|403|500>
 */
import {
  DataVaultService,
  KVService,
  SecretsService,
  type IServiceContext,
} from "@tinycloud/sdk-core";

import { cliErrorFromService, handleError } from "../src/output/errors.js";

const spaceId = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000abc:default";
const host = "https://node.tinycloud.test";

const scenarios: Record<string, { status: number; body: string }> = {
  "capability-401": { status: 401, body: "Unauthorized Action: vault/secrets/API_KEY / tinycloud.kv/put" },
  "plain-401": { status: 401, body: "Unauthorized" },
  "403": { status: 403, body: "Unauthorized Action: vault/secrets/API_KEY / tinycloud.kv/put" },
  "500": { status: 500, body: "internal error" },
};

const scenario = scenarios[process.argv[2] ?? ""];
if (!scenario) {
  console.error(`unknown scenario ${JSON.stringify(process.argv[2])}`);
  process.exit(64);
}

const nodeResponse = {
  ok: false,
  status: scenario.status,
  statusText: "Refused",
  headers: { get: () => null },
  json: async () => ({}),
  text: async () => scenario.body,
  arrayBuffer: async () => new TextEncoder().encode(scenario.body).buffer as ArrayBuffer,
  blob: async () => new Blob([scenario.body]),
};

const context = {
  session: {
    delegationHeader: { Authorization: "Bearer test" },
    delegationCid: "bafy-test",
    spaceId,
    verificationMethod: "did:key:z6MkSession",
    jwk: {},
  },
  isAuthenticated: true,
  invoke: () => ({ Authorization: "Bearer signed-invocation" }),
  fetch: async () => nodeResponse,
  hosts: [host],
  getService: () => undefined,
  emit: () => undefined,
  on: () => () => undefined,
  abortSignal: new AbortController().signal,
  retryPolicy: {
    maxAttempts: 1,
    backoff: "none",
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableErrors: [],
  },
} as unknown as IServiceContext;

const kv = new KVService({});
kv.initialize(context);

const networkId = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const vault = new DataVaultService({
  spaceId,
  crypto: {} as never,
  encryption: {
    networkId,
    service: {
      encryptToNetwork: async (targetNetworkId: string) => ({
        ok: true,
        data: {
          v: 1,
          networkId: targetNetworkId,
          alg: "x25519-aes256gcm/v1",
          keyVersion: 1,
          encryptedSymmetricKey: "AQID",
          encryptedSymmetricKeyHash: "a".repeat(64),
          ciphertext: "AQID",
        },
      }),
    } as never,
  },
  tc: {
    kv,
    did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000abc",
    address: "0x0000000000000000000000000000000000000abc",
    chainId: 1,
    hosts: [host],
  },
} as never);
vault.initialize(context);

const result = await new SecretsService(vault).put("API_KEY", "secret");
if (result.ok) {
  console.error("put unexpectedly succeeded");
  process.exit(65);
}
handleError(cliErrorFromService(result.error));
