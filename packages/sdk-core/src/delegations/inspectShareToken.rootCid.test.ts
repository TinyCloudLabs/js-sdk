// TC-3194: `inspectShareToken`'s rootCid is the CID of the bytes the owner's wallet signed. Apps dedupe shares by it,
// so a token that claims another CID for those bytes is refused, and the same root gives the same CID from any token.
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
const SPACE = `tinycloud:pkh:eip155:1:${owner.address}:default`;
const SHARE_SEED = new Uint8Array(32).fill(29);
const SHARE_PUBLIC = ed25519.getPublicKey(SHARE_SEED);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC]))}`;
const SHARE_JWK = { kty: "OKP", crv: "Ed25519", x: Buffer.from(SHARE_PUBLIC).toString("base64url"), d: Buffer.from(SHARE_SEED).toString("base64url") };
const TRANSCRIPT = "xyz.tinycloud.recordings/rec-1/transcript.json";
const AUDIO = "xyz.tinycloud.recordings/rec-1/audio/";
const READ = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
const NOW = new Date("2026-11-17T12:00:00.000Z");
const ROOT_END = new Date("2027-11-17T12:00:00.000Z");

/** A wallet-signed SIWE CACAO from the owner to the share key over both resources; `nonce` makes a distinct root. */
async function walletRoot(nonce: string): Promise<Delegation> {
  const att: Record<string, Record<string, unknown[]>> = {};
  for (const path of [TRANSCRIPT, AUDIO]) att[`${SPACE}/kv/${path}`] = Object.fromEntries(READ.map((action) => [action, [{}]]));
  const lines = Object.keys(att).sort().map((uri, index) => ` (${index + 1}) 'tinycloud.kv': 'get', 'metadata' for '${uri}'.`).join("");
  const statement = `I further authorize the stated URI to perform the following actions on my behalf:${lines}`;
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`];
  const fields = { domain: "app.tinycloud.xyz", nonce, issuedAt: "2026-11-17T11:00:00.000Z", expirationTime: ROOT_END.toISOString() };
  const message = new SiweMessage({ ...fields, address: owner.address, uri: SHARE_DID, version: "1", chainId: 1, statement, resources }).prepareMessage();
  const signature = await owner.signMessage({ message });
  const authHeader = Buffer.from(encodeDagCbor({
    h: { t: "eip4361" },
    p: { domain: fields.domain, iss: `did:pkh:eip155:1:${owner.address}`, aud: SHARE_DID, version: 1, nonce, iat: fields.issuedAt, exp: fields.expirationTime, statement, resources },
    s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) },
  })).toString("base64url");
  const { cid } = await parseSignedSiweCacao(authHeader);
  return { cid, delegateDID: SHARE_DID, spaceId: SPACE, path: TRANSCRIPT, actions: READ, expiry: ROOT_END, isRevoked: false, allowSubDelegation: true, authHeader };
}

function token(delegation: Delegation, host = "https://node.tinycloud.xyz"): string {
  const data: EncodedShareData = {
    version: 1,
    host,
    spaceId: SPACE,
    path: TRANSCRIPT,
    resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }],
    keyDid: SHARE_DID,
    key: SHARE_JWK,
    delegation,
  };
  return `tc1:${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
}

describe("inspectShareToken rootCid", () => {
  test("is the CID of the signed root bytes, the same from any token that carries that root", async () => {
    const root = await walletRoot("tc3194cid1");
    const signedCid = (await parseSignedSiweCacao(root.authHeader!)).cid;
    for (const shareToken of [token(root), token(root, "https://other-node.example")]) {
      const inspected = await inspectShareToken(shareToken, { now: NOW });
      expect(inspected.ok && inspected.data.rootCid).toBe(signedCid);
    }
  });

  test("a token claiming another CID for the signed root is refused, so it can't pose as another share", async () => {
    const root = await walletRoot("tc3194cid1");
    const other = await walletRoot("tc3194cid2");
    for (const cid of [other.cid, "bafyforgedrootcid"]) {
      const inspected = await inspectShareToken(token({ ...root, cid }), { now: NOW });
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.error.code).toBe(DelegationErrorCodes.INVALID_TOKEN);
    }
  });
});
