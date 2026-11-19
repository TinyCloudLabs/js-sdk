import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { createLink, prepareLinkRecord } from "../src/links/api.js";

// TEST ONLY key: the vectors' `issuerA`.
const SEED = new Uint8Array(32).fill(0x11);
const DID = "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S";
const issuerKey = { did: DID, sign: async (digest: Uint8Array) => ed25519.sign(digest, SEED) };
const API = "https://api.tinycloud.xyz";
const WHOLE_SECOND = Date.UTC(2026, 9, 26, 12, 25, 24);

describe("link header expiry", () => {
  for (const fraction of [671, 999, 0, 1]) {
    it(`is whole seconds and never later than the caller's expiry (.${String(fraction).padStart(3, "0")})`, async () => {
      const now = WHOLE_SECOND;
      const expiresAt = new Date(now + 3_600_000 + fraction);
      const { record } = await prepareLinkRecord({ type: "share", plaintext: new TextEncoder().encode("body"), issuerKey, apiOrigin: API, expiresAt, now });
      expect(Date.parse(record.header.expiresAt)).toBeLessThanOrEqual(expiresAt.getTime());
      expect(Date.parse(record.header.expiresAt) % 1000).toBe(0);
    });

    it(`posts a header with whole seconds (.${String(fraction).padStart(3, "0")})`, async () => {
      const now = WHOLE_SECOND;
      const expiresAt = new Date(now + 3_600_000 + fraction);
      let posted: { header: { expiresAt: string } } | undefined;
      const fetchFn = (async (_url: string, init: RequestInit) => {
        posted = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "a".repeat(26), expiresAt: posted!.header.expiresAt }), { status: 201, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      await createLink({ type: "share", plaintext: new TextEncoder().encode("body"), issuerKey, apiOrigin: API, linkOrigin: "https://share.tinycloud.xyz", expiresAt, now, fetch: fetchFn });
      expect(Date.parse(posted!.header.expiresAt)).toBeLessThanOrEqual(expiresAt.getTime());
      expect(Date.parse(posted!.header.expiresAt) % 1000).toBe(0);
    });
  }
});
