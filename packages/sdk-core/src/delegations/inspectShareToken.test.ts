// TC-3194: what a recipient may show before claiming a share comes from the owner's signature, never from the
// token's own claims. A token that names someone's space but carries a root they did not sign says nothing.
import { describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import { inspectShareToken, type EncodedShareData } from "./SharingService";
import { DelegationErrorCodes, type Delegation } from "./types";
import fixture from "../../test-fixtures/siwe-cacao/owner-share.json";

const owner = privateKeyToAccount(`0x${fixture.ownerPrivateKey}`);
// A different wallet, standing in for whoever a forger wants the link to name.
const sam = privateKeyToAccount(`0x${"5a".repeat(32)}`);
const spaceOf = (address: string) => `tinycloud:pkh:eip155:1:${address}:default`;
const SPACE = spaceOf(owner.address);
const SAM_SPACE = spaceOf(sam.address);

const SHARE_SEED = new Uint8Array(32).fill(23);
const SHARE_PUBLIC = ed25519.getPublicKey(SHARE_SEED);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC]))}`;
const SHARE_JWK = { kty: "OKP", crv: "Ed25519", x: Buffer.from(SHARE_PUBLIC).toString("base64url"), d: Buffer.from(SHARE_SEED).toString("base64url") };

const TRANSCRIPT = "xyz.tinycloud.recordings/rec-1/transcript.json";
const AUDIO = "xyz.tinycloud.recordings/rec-1/audio/";
const READ = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
const NOW = new Date("2026-11-17T12:00:00.000Z");
const ROOT_END = new Date("2027-11-17T12:00:00.000Z");

/** A wallet-signed SIWE CACAO from `signer` to `audience` over `paths`, as a wallet signs a share root. */
async function walletRoot(signer: typeof owner, space: string, paths: readonly string[], audience = SHARE_DID): Promise<Delegation> {
  const att: Record<string, Record<string, unknown[]>> = {};
  for (const path of paths) att[`${space}/kv/${path}`] = Object.fromEntries(READ.map((action) => [action, [{}]]));
  const lines = Object.keys(att).sort().map((uri, index) => ` (${index + 1}) 'tinycloud.kv': 'get', 'metadata' for '${uri}'.`).join("");
  const statement = `I further authorize the stated URI to perform the following actions on my behalf:${lines}`;
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`];
  const fields = { domain: "app.tinycloud.xyz", nonce: "tc3194nonce", issuedAt: "2026-11-17T11:00:00.000Z", expirationTime: ROOT_END.toISOString() };
  const message = new SiweMessage({ ...fields, address: signer.address, uri: audience, version: "1", chainId: 1, statement, resources }).prepareMessage();
  const signature = await signer.signMessage({ message });
  const authHeader = Buffer.from(encodeDagCbor({
    h: { t: "eip4361" },
    p: { domain: fields.domain, iss: `did:pkh:eip155:1:${signer.address}`, aud: audience, version: 1, nonce: fields.nonce, iat: fields.issuedAt, exp: fields.expirationTime, statement, resources },
    s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) },
  })).toString("base64url");
  const { cid } = await parseSignedSiweCacao(authHeader);
  return { cid, delegateDID: audience, spaceId: space, path: paths[0]!, actions: READ, expiry: ROOT_END, isRevoked: false, allowSubDelegation: true, authHeader };
}

/** A `tc1:` token claiming `space` and both recording resources, carrying `delegation` as its root. */
function token(space: string, delegation: Delegation): string {
  const data: EncodedShareData = {
    version: 1,
    host: "https://node.tinycloud.xyz",
    spaceId: space,
    path: TRANSCRIPT,
    resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }],
    keyDid: SHARE_DID,
    key: SHARE_JWK,
    delegation: { ...delegation, spaceId: space },
  };
  return `tc1:${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
}

describe("inspectShareToken", () => {
  test("names the owner, the exact resources and the access end from the owner's wallet signature", async () => {
    const inspected = await inspectShareToken(token(SPACE, await walletRoot(owner, SPACE, [TRANSCRIPT, AUDIO])), { now: NOW });

    expect(inspected).toEqual({
      ok: true,
      data: {
        owner: { address: owner.address, chainId: 1, spaceId: SPACE },
        resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }],
        accessExpiresAt: ROOT_END,
      },
    });
  });

  test("a forged token naming Sam's space never names Sam", async () => {
    const otherWallet = await walletRoot(owner, SPACE, [TRANSCRIPT, AUDIO]);
    const garbage = { ...otherWallet, authHeader: Buffer.from("not a signature").toString("base64url") };
    const sessionKeyRoot = { ...otherWallet, authHeader: "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6a2V5In0.c2ln" };
    for (const root of [otherWallet, garbage, sessionKeyRoot]) {
      const inspected = await inspectShareToken(token(SAM_SPACE, root), { now: NOW });
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.error.code).toBe(DelegationErrorCodes.INVALID_TOKEN);
    }
  });

  test("refuses a root that does not grant every resource the token claims, or grants it to another key", async () => {
    const narrower = await walletRoot(owner, SPACE, [TRANSCRIPT]);
    const toAnotherKey = await walletRoot(owner, SPACE, [TRANSCRIPT, AUDIO], fixture.delegation.audience);
    for (const root of [narrower, toAnotherKey]) {
      const inspected = await inspectShareToken(token(SPACE, root), { now: NOW });
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.error.code).toBe(DelegationErrorCodes.INVALID_TOKEN);
    }
  });

  test("reports a genuine share whose root has ended as expired", async () => {
    const inspected = await inspectShareToken(token(SPACE, await walletRoot(owner, SPACE, [TRANSCRIPT, AUDIO])), { now: ROOT_END });
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error.code).toBe(DelegationErrorCodes.AUTH_EXPIRED);
  });
});
