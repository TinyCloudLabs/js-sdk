import { toBase64Url } from "@tinycloud/share-envelope";

/**
 * The agent's key-encryption key (design C §3, V3-6). Security-sensitive:
 * keep this module small and free of logging.
 *
 *   KEK_a = HKDF-SHA256(ikm = private key bytes,
 *                       salt = "xyz.tinycloud.share/agent-kek/v1",
 *                       info = agentDid)
 *   kid   = HKDF-SHA256(same ikm and salt, info = "kid")[0..8]
 *
 * The private key is the one the agent signs its invocations and delegations
 * with (the session key when it has a private part, otherwise the profile
 * key), and `agentDid` is that key's DID. KEK_a is imported non-extractable,
 * for AES-GCM wrapping only.
 */
export interface AgentKeyMaterial {
  readonly agentDid: string;
  /** base64url of the first 8 bytes of HKDF(…, info "kid"). */
  readonly kid: string;
  readonly kek: CryptoKey;
}

const KEK_SALT = new TextEncoder().encode("xyz.tinycloud.share/agent-kek/v1");

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (value === undefined) throw new Error("WebCrypto is required for agent record keys");
  return value;
}

/**
 * Derive KEK_a and kid. `privateKeyBytes` is read, never retained; the caller
 * owns (and should zero) it.
 */
export async function deriveAgentKeyMaterial(privateKeyBytes: Uint8Array, agentDid: string): Promise<AgentKeyMaterial> {
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.byteLength < 32) throw new TypeError("agent private key must be at least 32 bytes");
  if (typeof agentDid !== "string" || !agentDid.startsWith("did:")) throw new TypeError("agent DID is invalid");
  const copy = new Uint8Array(privateKeyBytes);
  const ikm = await subtle().importKey("raw", copy, "HKDF", false, ["deriveBits", "deriveKey"]);
  copy.fill(0);
  const kek = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEK_SALT, info: new TextEncoder().encode(agentDid) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const kidBytes = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: KEK_SALT, info: new TextEncoder().encode("kid") }, ikm, 64));
  return { agentDid, kid: toBase64Url(kidBytes), kek };
}
