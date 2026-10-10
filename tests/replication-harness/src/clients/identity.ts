import { HarnessError } from "../contracts/common";

const sdkOwnerKeys = new Map<string, string>();

/** Register a CLI owner's synthetic key for SDK clients sharing its run identity. */
export function registerSdkIdentityPrivateKey(runId: string, identity: string, privateKeyHex: string): void {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new HarnessError("TOPOLOGY_INVALID", "SDK identity key must be 32 bytes of hex");
  }
  const cacheKey = `${runId}\u0000${identity}`;
  const existing = sdkOwnerKeys.get(cacheKey);
  if (existing && existing.toLowerCase() !== privateKeyHex.replace(/^0x/i, "").toLowerCase()) {
    throw new HarnessError("TOPOLOGY_INVALID", `Identity ${identity} already has a different key in run ${runId}`);
  }
  sdkOwnerKeys.set(cacheKey, privateKeyHex.replace(/^0x/i, "").toLowerCase());
}

/** Return an owner key only when an earlier client has explicitly registered it. */
export function registeredSdkIdentityPrivateKey(runId: string, identity: string): string | undefined {
  return sdkOwnerKeys.get(`${runId}\u0000${identity}`);
}

/** Return a process-local synthetic owner key, shared only by clients in the same run identity. */
export function sdkIdentityPrivateKey(runId: string, identity: string): string {
  const cacheKey = `${runId}\u0000${identity}`;
  const existing = sdkOwnerKeys.get(cacheKey);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const privateKeyHex = Buffer.from(bytes).toString("hex");
  sdkOwnerKeys.set(cacheKey, privateKeyHex);
  return privateKeyHex;
}

/** Drop process-local identity material after a run is disposed. */
export function forgetSdkIdentityKeys(runId: string): void {
  const prefix = `${runId}\u0000`;
  for (const key of sdkOwnerKeys.keys()) {
    if (key.startsWith(prefix)) sdkOwnerKeys.delete(key);
  }
}
