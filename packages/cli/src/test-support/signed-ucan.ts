import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded;
}

export function createUcanIssuer(): { did: string; publicBytes: Uint8Array; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { did: `did:key:z${base58(Uint8Array.from([0xed, 0x01, ...publicBytes]))}`, publicBytes, privateKey };
}

export function signUcan(
  issuer: ReturnType<typeof createUcanIssuer>,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT" },
): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: issuer.did, ...payload })).toString("base64url");
  const signature = sign(null, Buffer.from(`${head}.${body}`), issuer.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}
