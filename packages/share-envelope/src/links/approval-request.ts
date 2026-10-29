import { p256 } from "@noble/curves/p256";
import { z } from "zod";
import { didKeyFromEd25519PublicKey } from "../didkey.js";
import { ed25519KeyProblem } from "./ed25519-strict.js";
import { decodeStrictBase64Url } from "./header.js";
import { LinkError } from "./errors.js";

const bytes32 = z.string().refine((value) => decodeStrictBase64Url(value)?.length === 32);
const ed25519Jwk = z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: bytes32 }).strict();
const p256Jwk = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: bytes32, y: bytes32 }).strict()
  .refine((key) => {
    try {
      const point = new Uint8Array(65);
      point[0] = 4;
      point.set(decodeStrictBase64Url(key.x)!, 1);
      point.set(decodeStrictBase64Url(key.y)!, 33);
      p256.ProjectivePoint.fromHex(point).assertValidity();
      return true;
    } catch { return false; }
  });
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
});
const permission = z.object({
  service: z.string().min(1), space: z.string().min(1), path: z.string(),
  actions: z.array(z.string().min(1)).min(1), caveats: z.array(z.unknown()).optional(),
}).strict();
const requestSchema = z.object({
  issuer: z.string(), requestVersion: z.literal(1), targetDid: z.string(),
  targetPublicJwk: ed25519Jwk, nodeOrigin: origin,
  permissions: z.array(permission).min(1), reason: z.string().optional(),
  grantLifetimeSeconds: z.number().int().positive(), resultEncryptionPublicJwk: p256Jwk,
}).strict();

export type OpenKeyApprovalRequestV1 = z.infer<typeof requestSchema>;

/** The signed request names exactly its issuer's public session key; no private JWK fields are accepted. */
export function parseApprovalRequest(value: unknown, options: { readonly issuer?: string } = {}): OpenKeyApprovalRequestV1 {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new LinkError("body_validation_failed", "invalid approval request");
  const request = parsed.data;
  const publicKey = decodeStrictBase64Url(request.targetPublicJwk.x)!;
  if (ed25519KeyProblem(publicKey) !== null || didKeyFromEd25519PublicKey(publicKey) !== request.targetDid ||
      request.issuer !== request.targetDid || (options.issuer !== undefined && request.issuer !== options.issuer)) {
    throw new LinkError("issuer_binding_mismatch");
  }
  return request;
}

