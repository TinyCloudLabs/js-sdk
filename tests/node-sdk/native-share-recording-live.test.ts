import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { inspectShareToken, ownerFullAccess, PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * TC-3194: a recording shared as one link over two resources (its transcript
 * key and its audio prefix), against a real local Node. The owner approves
 * once for a year-long root; a recipient claims it to their account DID with
 * no approval, reads both resources with full keys from a later session, and
 * after the owner stops sharing a claim is refused as REVOKED.
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test native-share-recording-live.test.ts
 *
 * Keys are throwaway; nothing here prints key material, tokens or Authorization values.
 */

const DAY = 86_400_000;
const config = {
  host: SERVER_URL,
  autoBootstrapAccount: false,
  tinycloudFallbackHosts: [SERVER_URL],
  autoDiscoverLocalNode: false,
  enablePublicSpace: false,
} satisfies Partial<TinyCloudNodeConfig>;

class CountingSigner extends PrivateKeySigner {
  approvals = 0;
  override async signMessage(message: string): Promise<string> {
    this.approvals++;
    return super.signMessage(message);
  }
}

const RECORDING = crypto.randomUUID();
const TRANSCRIPT = `xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript/${RECORDING}`;
const AUDIO = `xyz.tinycloud.tinychat/connectors/exo-voice-note/audio/${RECORDING}/`;
const FILES: Record<string, string> = {
  [TRANSCRIPT]: "Speaker 1 [00:00]: Transcript text.",
  [`${AUDIO}manifest`]: JSON.stringify({ parts: 2, mime: "audio/webm" }),
  [`${AUDIO}p/000000`]: "AUDIO-PART-0",
  [`${AUDIO}p/000001`]: "AUDIO-PART-1",
};
const READ = ["tinycloud.kv/get"];

const ownerSigner = new CountingSigner(Wallet.createRandom().privateKey.slice(2));
const recipientSigner = new CountingSigner(Wallet.createRandom().privateKey.slice(2));
let owner: TinyCloudNode;
let token: string;
let rootCid: string;
let kept: Parameters<TinyCloudNode["useDelegation"]>[0];

describe("native recording share (live)", () => {
  beforeAll(checkServerHealth);

  test("the owner shares transcript and audio for a year with one approval", async () => {
    owner = new TinyCloudNode({ ...config, signer: ownerSigner, autoCreateSpace: true, ...ownerFullAccess() });
    await owner.signIn();
    for (const [key, value] of Object.entries(FILES)) expect((await owner.kv.put(key, value)).ok).toBe(true);

    const before = ownerSigner.approvals;
    const generated = await owner.sharing.generate({
      resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }],
      expiry: new Date(Date.now() + 365 * DAY),
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(ownerSigner.approvals - before).toBe(1);
    token = generated.data.token;
    rootCid = generated.data.delegation.cid;
    expect(owner.sharing.decodeLink(token).resources?.map((resource) => resource.path)).toEqual([TRANSCRIPT, AUDIO]);
  }, 60_000);

  test("the token checks out offline against the owner's signature, and a token naming another owner does not", async () => {
    const inspected = await inspectShareToken(token);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.data.owner.address.toLowerCase()).toBe((await ownerSigner.getAddress()).toLowerCase());
    expect(inspected.data.resources).toEqual([{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }]);
    expect(inspected.data.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 364 * DAY);

    const data = JSON.parse(Buffer.from(token.slice("tc1:".length), "base64url").toString("utf8"));
    const other = Wallet.createRandom().address;
    const swap = (space: string) => space.replace(/0x[0-9a-fA-F]{40}/, other);
    const forged = `tc1:${Buffer.from(JSON.stringify({ ...data, spaceId: swap(data.spaceId), delegation: { ...data.delegation, spaceId: swap(data.delegation.spaceId) } })).toString("base64url")}`;
    const refused = await inspectShareToken(forged);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_TOKEN");
  });

  test("a recipient claims it to their account DID without an approval", async () => {
    const recipient = new TinyCloudNode({ ...config, signer: recipientSigner, autoCreateSpace: true });
    await recipient.signIn();
    const before = recipientSigner.approvals;
    const claim = await recipient.sharing.delegateReceivedShare(token, { delegateDID: recipient.did });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(recipientSigner.approvals - before).toBe(0);
    expect(claim.data.delegation.parentCid).toBe(rootCid);
    expect(claim.data.delegation.resources?.map((resource) => resource.path).sort()).toEqual([AUDIO, TRANSCRIPT].sort());
    kept = JSON.parse(JSON.stringify(claim.data.delegation));
  }, 60_000);

  test("a later recipient session reads both resources with full keys, and cannot write", async () => {
    const later = new TinyCloudNode({ ...config, signer: recipientSigner, autoCreateSpace: true });
    await later.signIn();
    const access = await later.useDelegation({
      ...kept,
      expiry: new Date(kept.expiry),
      ...(kept.createdAt ? { createdAt: new Date(kept.createdAt) } : {}),
    });
    for (const [key, value] of Object.entries(FILES)) {
      const read = await access.kv.get<unknown>(key);
      expect(read.ok).toBe(true);
      if (read.ok) expect(typeof read.data.data === "string" ? read.data.data : JSON.stringify(read.data.data)).toBe(value);
    }
    expect((await access.kv.get(`${AUDIO.replace(RECORDING, crypto.randomUUID())}manifest`)).ok).toBe(false);
    expect((await access.kv.put(TRANSCRIPT, "tampered")).ok).toBe(false);
  }, 60_000);

  test("after the owner stops sharing, a claim is refused as REVOKED", async () => {
    expect((await owner.revokeDelegation(rootCid)).ok).toBe(true);
    const recipient = new TinyCloudNode({ ...config, signer: recipientSigner, autoCreateSpace: true });
    await recipient.signIn();
    const late = await recipient.sharing.delegateReceivedShare(token, { delegateDID: recipient.did });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("REVOKED");
  }, 60_000);
});
