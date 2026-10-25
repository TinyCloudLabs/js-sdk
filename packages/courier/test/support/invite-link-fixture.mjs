// A stored link as the private invite record keeps it: id, content id, the per-invite signing did:key and its seed.
// The seed is a fixed, public test value; the did is derived from it by the real signer.
import { signerFromSeed } from '@tinycloud/share-envelope/links';

export const LINK_SEED_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const LINK_SEED = Buffer.from(LINK_SEED_BYTES).toString('base64url');
export const LINK_ISSUER = signerFromSeed(LINK_SEED_BYTES).did;
export const LINK_CID = `bafkrei${'a'.repeat(52)}`;

export const storedLink = (id = 'link-1') => ({ id, cid: LINK_CID, issuer: LINK_ISSUER, seed: LINK_SEED });
