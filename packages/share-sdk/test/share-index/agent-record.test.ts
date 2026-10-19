import { describe, expect, test } from "bun:test";
import { fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { deriveAgentKeyMaterial } from "../../src/share-index/agent-key.js";
import {
  AgentRecordError, MAX_AGENT_RECORD_BYTES, agentRecordBinding, openAgentRecordAsAgent, openAgentRecordAsOwner, parseStoredAgentRecord, sealAgentRecord,
} from "../../src/share-index/agent-record.js";
import { FakeOwnerNetwork, NETWORK_ID, SPACE_ID, newKey, standardBase64 } from "./helpers.js";

const encoder = new TextEncoder();
const agent = newKey();
const vaultKey = "sender-history/v2/records/agents/AAAAAAAAAAAAAAAAAAAAAA/s1";
const location = { spaceId: SPACE_ID, vaultKey };
const plaintext = encoder.encode(JSON.stringify({ shareId: "s1", secret: "link-material" }));

async function agentKey(seed = new Uint8Array(32).fill(7), did = agent.did) {
  return deriveAgentKeyMaterial(seed, did);
}

async function seal(network = new FakeOwnerNetwork(), options: { readonly withAgentKey?: boolean } = {}) {
  const key = await agentKey();
  const stored = await sealAgentRecord({ plaintext, spaceId: SPACE_ID, vaultKey, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network, ...(options.withAgentKey === false ? {} : { agentKey: key }) });
  return { stored, key, network };
}

function reparse(stored: StoredAgentRecord): StoredAgentRecord {
  return parseStoredAgentRecord(encoder.encode(JSON.stringify(stored)), { agentDid: agent.did, ownerNetworkId: NETWORK_ID });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "opened";
  } catch (error) {
    if (error instanceof AgentRecordError) return error.reason;
    throw error;
  }
}

describe("agent record codec (design C §3)", () => {
  test("(a) the owner unwraps through the owner network; (b) the agent reads back through KEK_a only", async () => {
    const { stored, key, network } = await seal();
    expect(new TextDecoder().decode(await openAgentRecordAsOwner(reparse(stored), location, network))).toBe(new TextDecoder().decode(plaintext));
    const before = network.unwrapCalls;
    expect(new TextDecoder().decode(await openAgentRecordAsAgent(reparse(stored), location, key))).toBe(new TextDecoder().decode(plaintext));
    expect(network.unwrapCalls).toBe(before);
  });

  test("(c) a verbatim foreign envelope, or one with no AAD, is refused before any decrypt request", async () => {
    const { stored, network } = await seal();
    const other = await sealAgentRecord({ plaintext, spaceId: SPACE_ID, vaultKey: `${vaultKey}x`, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network });
    const copied = { ...stored, wrapOwner: other.wrapOwner };
    const { aad: _aad, ...noAad } = stored.wrapOwner;
    const calls = network.unwrapCalls;
    expect(await reason(openAgentRecordAsOwner(copied, location, network))).toBe("decrypt");
    expect(await reason(openAgentRecordAsOwner({ ...stored, wrapOwner: noAad }, location, network))).toBe("decrypt");
    expect(await reason(openAgentRecordAsOwner({ ...stored, wrapOwner: { ...stored.wrapOwner, networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default" } }, location, network))).toBe("decrypt");
    expect(network.unwrapCalls).toBe(calls);
  });

  test("(c, V3-3) a crafted wrap declaring aad = B around a foreign wrapped key costs one decrypt, opens nothing, and the key is zeroed", async () => {
    const { stored, network } = await seal();
    const foreign = await sealAgentRecord({ plaintext, spaceId: SPACE_ID, vaultKey: `${vaultKey}x`, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network });
    const binding = agentRecordBinding({ ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID });
    const crafted = { ...stored, wrapOwner: { ...foreign.wrapOwner, aad: standardBase64(binding) } };
    const calls = network.unwrapCalls;
    let message = "";
    try { await openAgentRecordAsOwner(crafted, location, network); } catch (error) { message = String(error); expect((error as AgentRecordError).reason).toBe("commit"); }
    expect(network.unwrapCalls).toBe(calls + 1);
    const leaked = network.returned.at(-1)!;
    expect(leaked.every((byte) => byte === 0)).toBe(true);
    expect(message).toBe("AgentRecordError: agent record refused: commit");
  });

  test("(d) a 31- or 33-byte DEK on either path, a bad commit, or split-view wraps are refused", async () => {
    for (const length of [31, 33]) {
      const { stored, network } = await seal();
      network.override = (bytes) => { const out = new Uint8Array(length); out.set(bytes.subarray(0, Math.min(length, bytes.length))); return out; };
      expect(await reason(openAgentRecordAsOwner(stored, location, network))).toBe("decrypt");
      expect(network.returned.at(-1)!.every((byte) => byte === 0)).toBe(true);
    }
    for (const length of [31, 33]) {
      const { stored, key } = await seal();
      const binding = agentRecordBinding({ ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding }, key.kek, new Uint8Array(length)));
      const wrapAgent = toBase64Url(new Uint8Array([...iv, ...wrapped]));
      expect(await reason(openAgentRecordAsAgent({ ...stored, wrapAgent }, location, key))).toBe("decrypt");
    }
    const { stored, key, network } = await seal();
    const commit = fromBase64Url(stored.commit);
    commit[0]! ^= 1;
    expect(await reason(openAgentRecordAsOwner({ ...stored, commit: toBase64Url(commit) }, location, network))).toBe("commit");
    expect(await reason(openAgentRecordAsAgent({ ...stored, commit: toBase64Url(commit) }, location, key))).toBe("commit");
    // Split view: the agent wrap carries another seal's DEK.
    const second = await sealAgentRecord({ plaintext: encoder.encode("{\"other\":true}"), ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network, agentKey: key });
    expect(await reason(openAgentRecordAsAgent({ ...stored, wrapAgent: second.wrapAgent }, location, key))).toBe("commit");
  });

  test("(g) a record copied to another key or agent fails B or the KEK", async () => {
    const { stored, key, network } = await seal();
    const moved = { ...location, vaultKey: "sender-history/v2/records/agents/BBBBBBBBBBBBBBBBBBBBBB/s1" };
    expect(await reason(openAgentRecordAsOwner(stored, moved, network))).toBe("decrypt");
    expect(await reason(openAgentRecordAsAgent(stored, moved, key))).toBe("decrypt");
    const otherAgent = newKey();
    const otherKey = await deriveAgentKeyMaterial(new Uint8Array(32).fill(9), otherAgent.did);
    expect(await reason(openAgentRecordAsAgent({ ...stored, hdr: { ...stored.hdr, agentDid: otherAgent.did, kid: otherKey.kid } }, location, otherKey))).toBe("decrypt");
  });

  test("(h, V3-5) two writes of the same record never share a DEK or a nonce", async () => {
    const network = new FakeOwnerNetwork();
    const key = await agentKey();
    const seals = await Promise.all([0, 1, 2].map(() => sealAgentRecord({ plaintext, ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network, agentKey: key })));
    const deks = await Promise.all(seals.map(async (stored) => toBase64Url(await network.unwrap(stored.wrapOwner, agentRecordBinding({ ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID })))));
    expect(new Set(deks).size).toBe(3);
    const nonces = seals.flatMap((stored) => [stored.ct, stored.wrapAgent!].map((value) => toBase64Url(fromBase64Url(value).subarray(0, 12))));
    expect(new Set(nonces).size).toBe(6);
  });

  test("(i, V3-6) without a local private key the record is owner-readable only; KEK and kid are per key", async () => {
    const { stored, network } = await seal(new FakeOwnerNetwork(), { withAgentKey: false });
    expect(stored.hdr.kid).toBeNull();
    expect(stored.wrapAgent).toBeNull();
    expect(new TextDecoder().decode(await openAgentRecordAsOwner(stored, location, network))).toContain("s1");
    expect(await reason(openAgentRecordAsAgent(stored, location, await agentKey()))).toBe("decrypt");
    const a = await agentKey(new Uint8Array(32).fill(1));
    const b = await agentKey(new Uint8Array(32).fill(2));
    expect(a.kid).not.toBe(b.kid);
    expect((await agentKey(new Uint8Array(32).fill(1))).kid).toBe(a.kid);
    await expect(sealAgentRecord({ plaintext, ...location, agentDid: newKey().did, ownerNetworkId: NETWORK_ID, ownerWrap: network, agentKey: a })).rejects.toThrow("agent key does not belong");
  });

  test("the header is checked before any crypto: size, exact fields, owner network, newer recordV", async () => {
    const { stored } = await seal();
    const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
    const parse = (value: unknown) => { try { parseStoredAgentRecord(bytes(value), { ownerNetworkId: NETWORK_ID }); return "ok"; } catch (error) { return (error as AgentRecordError).reason; } };
    expect(parse(stored)).toBe("ok");
    expect(parse({ ...stored, extra: 1 })).toBe("shape");
    expect(parse({ ...stored, hdr: { ...stored.hdr, extra: 1 } })).toBe("header");
    expect(parse({ ...stored, hdr: { ...stored.hdr, ownerNetworkId: "urn:other" } })).toBe("header");
    expect(parse({ ...stored, hdr: { ...stored.hdr, recordV: 2 } })).toBe("newer");
    expect(parse({ ...stored, pad: "x".repeat(33 * 1024) })).toBe("size");
    // The owner network id is compared spelling-insensitively (checksummed vs lowercase address).
    expect(parse({ ...stored, hdr: { ...stored.hdr, ownerNetworkId: NETWORK_ID.toLowerCase() } })).toBe("ok");
  });

  test("the size cap is MAX_AGENT_RECORD_BYTES: exactly at the cap is accepted, one byte over is refused", async () => {
    const { stored } = await seal();
    const sized = (bytes: number) => {
      const base = encoder.encode(JSON.stringify({ ...stored, wrapOwner: { ...stored.wrapOwner, pad: "" } })).length;
      return encoder.encode(JSON.stringify({ ...stored, wrapOwner: { ...stored.wrapOwner, pad: "x".repeat(bytes - base) } }));
    };
    expect(MAX_AGENT_RECORD_BYTES).toBe(32 * 1024);
    expect(sized(MAX_AGENT_RECORD_BYTES).length).toBe(MAX_AGENT_RECORD_BYTES);
    expect(parseStoredAgentRecord(sized(MAX_AGENT_RECORD_BYTES), { ownerNetworkId: NETWORK_ID }).hdr.agentDid).toBe(agent.did);
    expect(() => parseStoredAgentRecord(sized(MAX_AGENT_RECORD_BYTES + 1), { ownerNetworkId: NETWORK_ID })).toThrow(new AgentRecordError("size"));
  });
});
