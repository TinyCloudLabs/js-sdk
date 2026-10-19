import { parsePkhDid, pkhPrincipalsEqual } from "./did";

/**
 * Single use is a property of the store. `consume` is ONE atomic compare-and-delete and the only
 * nonce operation a verifier performs: it deletes the entry only where the audience, the nonce AND
 * the bound account all match (cf. `DELETE ... WHERE nonce = ? AND audience = ? AND owner_did = ?
 * RETURNING`). It must not delete first and compare afterwards: the verifier calls it FIRST, before
 * any signature or claim check, so anyone who saw a nonce could otherwise burn it. Every nonce is
 * minted bound to the authenticated caller's account; unbound nonces do not exist. A mismatch
 * finds nothing and spends nothing.
 *
 * Production stores: a Durable Object, or D1/Postgres with a conditional delete. Cloudflare KV is
 * eventually consistent and MUST NOT be used; there is no stateless (HMAC, self-expiring) mode
 * because that would rest on timestamps alone.
 */
export interface NonceStore {
  consume(audience: string, nonce: string, account: string): Promise<{ existed: boolean }>;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** In-memory store for tests and single-process tools. Not for production Workers (no cross-isolate atomicity). */
export class InMemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, string>();

  /** Mints a nonce for `audience`, bound to the authenticated caller's `did:pkh` account. */
  issue(audience: string, account: string): string {
    if (parsePkhDid(account) === null) throw new TypeError("a nonce must be bound to a did:pkh:eip155 account");
    const nonce = randomNonce();
    this.nonces.set(`${audience}\n${nonce}`, account);
    return nonce;
  }

  async consume(audience: string, nonce: string, account: string): Promise<{ existed: boolean }> {
    const key = `${audience}\n${nonce}`;
    const bound = this.nonces.get(key);
    if (bound === undefined || !pkhPrincipalsEqual(bound, account)) return { existed: false };
    this.nonces.delete(key);
    return { existed: true };
  }
}
