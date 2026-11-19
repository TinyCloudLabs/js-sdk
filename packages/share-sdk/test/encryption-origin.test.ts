import { describe, expect, it } from "bun:test";
import { createDelegatedShareKey } from "../src/index.js";
import { encryptionNodeOrigin } from "../src/encryption-origin.js";
import { NETWORK_CREATE_ABILITY, lookupShareNetwork, retireShareNetwork, sendNetworkAdmin } from "../src/share-network.js";

// TC-2923: share encryption-network traffic for the production node uses only
// its TEE-terminated origin.
const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const NETWORK = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:share-0123456789abcdef0123456789abcdef";
const NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";

function recordingFetch() {
  const requests: { origin: string; redirect: RequestRedirect | undefined }[] = [];
  const fetch = async (input: URL, init?: RequestInit) => {
    requests.push({ origin: input.origin, redirect: init?.redirect });
    return new Response(null, { status: 404 });
  };
  return { requests, fetch };
}

describe("share encryption origin", () => {
  it("maps only the two exact production names", () => {
    expect(encryptionNodeOrigin(PROXIED)).toBe(TEE);
    expect(encryptionNodeOrigin(TEE)).toBe(TEE);
    for (const other of ["https://node.example", "https://evilnode.tinycloud.xyz", "https://node.tinycloud.xyz.evil.example", "http://node.tinycloud.xyz", "https://node.tinycloud.xyz:444", `${PROXIED}/`]) {
      expect(encryptionNodeOrigin(other)).toBe(other);
    }
  });

  it("descriptor lookup, network create and retire for the proxied name reach only the TEE origin", async () => {
    const { requests, fetch } = recordingFetch();
    const signer = await createDelegatedShareKey({ extractable: false });
    expect(await lookupShareNetwork(PROXIED, NETWORK, fetch)).toEqual({ state: "absent" });
    await sendNetworkAdmin({ nodeOrigin: PROXIED, nodeDid: NODE_DID, networkId: NETWORK, action: NETWORK_CREATE_ABILITY, signer, proof: "bafy-proof", fetch });
    expect(await retireShareNetwork({ nodeOrigin: PROXIED, nodeDid: NODE_DID, networkId: NETWORK, signer, proof: "bafy-proof", fetch })).toBe("absent");
    expect(requests.map(({ origin }) => origin)).toEqual([TEE, TEE, TEE, TEE]);
    expect(requests.every(({ redirect }) => redirect === "error")).toBe(true);
  });

  it("a self-hosted node keeps its own origin", async () => {
    const { requests, fetch } = recordingFetch();
    await lookupShareNetwork("https://node.example", NETWORK, fetch);
    expect(requests.map(({ origin }) => origin)).toEqual(["https://node.example"]);
  });
});
