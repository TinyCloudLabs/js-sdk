import { expect, test } from "bun:test";
import { AccountSetupRequiredError, REGISTRY_NOT_FOUND_BODY, composeManifestRequest } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";

test("public preparation checks account registration before creating SIWE without named keys or fallback", async () => {
  const previousFetch = globalThis.fetch;
  let registryReads = 0;
  let preparations = 0;
  const wasm = new NodeWasmBindings();
  const prepare = wasm.prepareSession.bind(wasm);
  wasm.prepareSession = (input) => { preparations++; return prepare(input); };
  globalThis.fetch = async (input) => {
    expect(String(input)).toStartWith("https://registry.account-setup.test/");
    registryReads++;
    return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
  };
  try {
    const auth = new NodeUserAuthorization({
      signer: new PrivateKeySigner("1".padStart(64, "0")), wasmBindings: wasm,
      signStrategy: { type: "auto-sign" }, domain: "notes.example", requireExistingAccount: true,
      newUserHost: null, autoDiscoverLocalNode: false, tinycloudRegistryUrl: "https://registry.account-setup.test",
      capabilityRequest: composeManifestRequest([{ app_id: "notes", name: "Notes", permissions: [{ service: "tinycloud.kv", path: "notes/", actions: ["get"] }] }], { includeAccountRegistryPermissions: false, includeImplicitCapabilitiesRead: false }),
    });
    await expect(auth.prepareSessionForSigning()).rejects.toBeInstanceOf(AccountSetupRequiredError);
    await expect(auth.prepareSessionForSigning()).rejects.toBeInstanceOf(AccountSetupRequiredError);
    expect(registryReads).toBeGreaterThan(0);
    expect(preparations).toBe(0);
  } finally { globalThis.fetch = previousFetch; }
});
