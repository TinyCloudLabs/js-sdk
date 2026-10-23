import { parsePkhDid, pkhPrincipalsEqual } from "./did";

/**
 * Single use is a property of the store. `consume` is one atomic compare-and-delete and the only
 * nonce operation a verifier performs: it deletes the entry only where the audience, the nonce and
 * the bound account all match (for example `DELETE ... WHERE nonce = ? AND audience = ? AND
 * owner_did = ? RETURNING`). The verifier calls it before the signature and claim checks. Every
 * nonce is minted bound to the authenticated caller's account. Production stores: a Durable Object,
 * or D1/Postgres with a conditional delete; there is no stateless mode, because single use does not
 * rely on timestamps. Details: TC-1540
 */
export interface NonceStore {
  consume(audience: string, nonce: string, account: string): Promise<{ existed: boolean }>;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * In-memory store for tests and single-process tools. Deployments use a shared store that implements
 * `consume` atomically. Entries do not expire: a nonce lives until it is consumed or the process ends.
 */
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
