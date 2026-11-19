import type { ReplicaAccountGate } from "@tinycloud/sdk-services/kv/replication";

/** Browser-only gate fields; node profiles keep the shared salt-based gate layout. */
export interface BrowserGate extends ReplicaAccountGate {
  keyId: string;
  accountKeyId: string;
  consentDeadline: number | null;
}

export interface GateHmacRecord {
  v: 1;
  incarnation: string;
  keyId: string;
  hmac: CryptoKey;
}

export interface AccountKeyRecord {
  v: 1;
  incarnation: string;
  lifecycleEpoch: number;
  principalHash: string;
  keyId: string;
  aesGcm: CryptoKey;
  hmac: CryptoKey;
}

export const GATE_HMAC_KEY = "gateHmac";
export const ACCOUNT_KEY = "accountKey";

const HEX = "0123456789abcdef";
const ENCODER = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += HEX.charAt(byte >>> 4) + HEX.charAt(byte & 15);
  return value;
}

function keyId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function newGateHmac(incarnation: string): Promise<GateHmacRecord> {
  const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  return { v: 1, incarnation, keyId: keyId(), hmac };
}

export async function newAccountKey(incarnation: string, lifecycleEpoch: number, principalHash: string): Promise<AccountKeyRecord> {
  const [aesGcm, hmac] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  ]);
  return { v: 1, incarnation, lifecycleEpoch, principalHash, keyId: keyId(), aesGcm, hmac };
}

/** Domain separation prevents one identifier class from revealing another's HMAC. */
export async function gateHash(key: CryptoKey, domain: "principal" | "identity" | "partition" | "lookup", material: string): Promise<string> {
  const bytes = ENCODER.encode(`${domain}\0${material}`);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)));
}

function isHmac(key: unknown): key is CryptoKey {
  if (!(key instanceof CryptoKey) || key.extractable || key.algorithm.name !== "HMAC") return false;
  const algorithm = key.algorithm;
  return "hash" in algorithm && algorithm.hash !== null && typeof algorithm.hash === "object" &&
    "name" in algorithm.hash && algorithm.hash.name === "SHA-256" &&
    key.usages.length === 2 && key.usages.includes("sign") && key.usages.includes("verify");
}

function isAesGcm(key: unknown): key is CryptoKey {
  if (!(key instanceof CryptoKey) || key.extractable || key.algorithm.name !== "AES-GCM") return false;
  return "length" in key.algorithm && key.algorithm.length === 256 &&
    key.usages.length === 2 && key.usages.includes("encrypt") && key.usages.includes("decrypt");
}

export function validGateHmac(record: GateHmacRecord | undefined, gate: BrowserGate): record is GateHmacRecord {
  return record?.v === 1 && record.incarnation === gate.incarnation && record.keyId === gate.keyId &&
    /^[0-9a-f]{32}$/.test(record.keyId) && isHmac(record.hmac);
}

export function validAccountKey(record: AccountKeyRecord | undefined, gate: BrowserGate): record is AccountKeyRecord {
  return record?.v === 1 && record.incarnation === gate.incarnation && record.lifecycleEpoch === gate.lifecycleEpoch &&
    record.principalHash === gate.principalHash && record.keyId === gate.accountKeyId &&
    /^[0-9a-f]{32}$/.test(record.keyId) && isAesGcm(record.aesGcm) && isHmac(record.hmac);
}
