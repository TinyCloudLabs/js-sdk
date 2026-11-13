import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { signedRestorableSession } from "../../../node-sdk/src/test-support/signed-restorable-session";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://fixture.example" });
for (const key of ["window", "document", "HTMLElement", "customElements", "localStorage", "navigator"] as const) Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
const { TinyCloudWeb } = await import("../../src/modules/tcw");
const { BrowserSessionStorage } = await import("../../src/adapters/BrowserSessionStorage");
const { SessionAccountMismatchError } = await import("../../src/modules/restoreAccount");
const proof = await signedRestorableSession();
const wrong = "0x1111111111111111111111111111111111111111";
const record = { address: proof.address, chainId: proof.chainId, sessionKey: JSON.stringify(proof.jwk), siwe: proof.siwe, signature: proof.signature, tinycloudSession: { delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid, spaceId: proof.spaceId, verificationMethod: proof.verificationMethod }, expiresAt: proof.expiresAt, createdAt: new Date().toISOString(), version: "1.0" };
let calls = 0;
globalThis.fetch = async () => { calls++; return Response.json({ error: "location record not found" }, { status: 404 }); };
for (const scenario of [
  { label: "custom storage wrong slot", requested: wrong, slot: wrong, refused: true, custom: true },
  { label: "ordinary wrong slot", requested: wrong, slot: wrong, refused: true },
  { label: "renewal wrong slot", requested: wrong, slot: wrong, refused: true, renewal: true },
  { label: "ordinary same account", requested: proof.address, slot: proof.address },
  { label: "mixed case", requested: proof.address.toLowerCase(), slot: proof.address },
  { label: "DID same account", requested: `did:pkh:eip155:1:${proof.address}`, slot: proof.address },
  { label: "CAIP chain mismatch", requested: `eip155:137:${proof.address}`, slot: proof.address, refused: true },
  { label: "space owner mismatch", requested: proof.address, slot: proof.address, refused: true, wrongSpace: true },
]) {
  localStorage.clear();
  const data = structuredClone(record);
  if (scenario.renewal) data.expiresAt = new Date(Date.now() - 1).toISOString();
  if (scenario.wrongSpace) data.tinycloudSession.spaceId = data.tinycloudSession.spaceId.replace(proof.address, wrong);
  const key = `tinycloud:session:${scenario.slot.toLowerCase()}`;
  localStorage.setItem(key, JSON.stringify(data));
  const unrelatedKey = "unrelated-session";
  localStorage.setItem(unrelatedKey, "preserved");
  const storage = scenario.custom ? { load: async () => data, save: async () => {}, clear: async () => { localStorage.removeItem(key); } } : new BrowserSessionStorage({ storage: localStorage });
  const app = new TinyCloudWeb({ ui: false, sessionStorage: storage, newUserHost: null, autoDiscoverLocalNode: false, tinycloudRegistryUrl: "http://127.0.0.1:1" });
  const before = calls;
  const result = scenario.renewal ? await app.restoreSessionWithRenewal("unneeded-before-account-refusal", scenario.requested) : await app.restoreSession(scenario.requested);
  if (scenario.refused) {
    assert.equal(result.status, "restore-failed", scenario.label);
    assert(result.error instanceof SessionAccountMismatchError, scenario.label);
    assert.equal(result.error.code, "ACCOUNT_MISMATCH");
    assert.equal(localStorage.getItem(key), null);
    assert.equal(calls, before, "account refusal precedes network/activation");
    assert.equal(result.session, undefined);
    assert.equal(localStorage.getItem(unrelatedKey), "preserved");
    assert(!result.error.message.includes(proof.address));
  } else assert.equal(result.status, "restored", `${scenario.label}: ${result.error?.message}`);
  app.cleanup();
  console.log(JSON.stringify({ label: scenario.label, status: result.status }));
}
process.exit(0);
