/**
 * Single use is a property of the store. `consume` is ONE atomic compare-and-delete and the only
 * nonce operation a verifier performs. Production stores: a Durable Object, or D1/Postgres with a
 * conditional delete. Cloudflare KV is eventually consistent and MUST NOT be used; there is no
 * stateless (HMAC, self-expiring) mode because that would rest on timestamps alone.
 */
export interface NonceStore {
  consume(audience: string, nonce: string): Promise<{ existed: boolean; boundAccount?: string }>;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** In-memory store for tests and single-process tools. Not for production Workers (no cross-isolate atomicity). */
export class InMemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, { boundAccount?: string }>();

  /** Mints a nonce for `audience`, optionally bound to the logged-in caller's account. */
  issue(audience: string, boundAccount?: string): string {
    const nonce = randomNonce();
    this.nonces.set(`${audience}\n${nonce}`, boundAccount === undefined ? {} : { boundAccount });
    return nonce;
  }

  async consume(audience: string, nonce: string): Promise<{ existed: boolean; boundAccount?: string }> {
    const key = `${audience}\n${nonce}`;
    const found = this.nonces.get(key);
    this.nonces.delete(key);
    return found === undefined ? { existed: false } : { existed: true, ...found };
  }
}
