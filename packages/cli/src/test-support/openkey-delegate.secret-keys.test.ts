import { expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "./openkey-delegate.js";

// The OpenKey stand-in mirrors #696 (TC-3800): one secret's exact key may be granted decrypt and key.create; the
// `secrets/` prefix, a scope folder, a malformed key and a lowercase owner on a named key are refused (TC-3802 ruling 2).

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner(`0x${"11".repeat(32)}`);
const manager = wasm.createSessionManager();
const sessionKey = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");
const owner = `did:pkh:eip155:1:${await signer.getAddress()}`;
const network = `urn:tinycloud:encryption:${owner}:default`;

const raw = (path: string, actions = ["tinycloud.encryption/decrypt"]): PermissionEntry =>
  ({ service: "tinycloud.encryption", path, actions } as PermissionEntry);

// Every CLI request carries a space entry; the stand-in refuses one with none.
const ANCHOR = { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["tinycloud.capabilities/read"] } as PermissionEntry;

async function refusal(permissions: PermissionEntry[]): Promise<string | undefined> {
  const openKey = openKeyDelegate({ wasm, signer, sessionKey, sessionDid });
  try {
    await openKey.delegate(sessionDid, { permissions: [ANCHOR, ...permissions] });
  } catch {
    return openKey.refusals[0]?.message ?? "refused without a reason";
  }
  return undefined;
}

test("one secret's exact key is signed with decrypt and key.create", async () => {
  expect(await refusal([raw(`${network}/secrets/openai_api_key`, ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"])])).toBeUndefined();
  expect(await refusal([raw(`${network}/secrets/scoped/my-app/other_key`)])).toBeUndefined();
});

test("the secrets/ prefix, a scope folder and a malformed key are refused", async () => {
  for (const tail of ["secrets/", "secrets/scoped/x/", "secrets/scoped/x", "secrets/OPENAI_API_KEY", "secrets/a/b"]) {
    expect(await refusal([raw(`${network}/${tail}`)])).toContain("invalid secret key");
  }
});

test("a named secret key needs the canonical owner; key.create stays refused on a network", async () => {
  expect(await refusal([raw(`${network.toLowerCase()}/secrets/openai_api_key`)])).toContain("canonical owner DID");
  expect(await refusal([raw(network, ["tinycloud.encryption/key.create"])])).toContain("actions must be");
});
