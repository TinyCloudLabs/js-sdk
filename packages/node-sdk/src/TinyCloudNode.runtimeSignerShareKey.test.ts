import { expect, test } from "bun:test";
import { createHermeticEncryptedNode, type HermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

// A runtime signer (`grantRuntimePermissions({ signMessage })`) replaces the connected signer's
// `signMessage` for the grant. It must not bypass the exact Share-key session-key fence.

const TIMEOUT_MS = 15_000;

function setup(fixture: HermeticEncryptedNode, name: string) {
  const ownerSigner = Reflect.get(fixture.owner, "signer") as { signMessage(message: string): Promise<string> };
  const realSign = ownerSigner.signMessage.bind(ownerSigner);
  let ownerSigns = 0;
  ownerSigner.signMessage = async (message: string) => { ownerSigns++; return realSign(message); };
  let customSigns = 0;
  const entry = {
    service: "tinycloud.encryption",
    path: `urn:tinycloud:encryption:${fixture.ownerDid}:default/share/${name}`,
    actions: ["tinycloud.encryption/key.create"],
  };
  const activations = () => fixture.requests().filter((r) => r.path === "/delegate").length;
  return {
    entry,
    realSign,
    activations,
    ownerSigns: () => ownerSigns,
    customSigns: () => customSigns,
    signer: (before?: () => void) => async (message: string) => { customSigns++; before?.(); return realSign(message); },
  };
}

test("exact Share-key grant with a runtime signer signs once through it and never through the owner signer", async () => {
  const fixture = await createHermeticEncryptedNode();
  try {
    const t = setup(fixture, "runtime-signer");
    const before = t.activations();
    const delegations = await fixture.owner.grantRuntimePermissions([t.entry], { signMessage: t.signer() });
    expect(delegations).toHaveLength(1);
    expect(t.customSigns()).toBe(1);
    expect(t.ownerSigns()).toBe(0);
    expect(t.activations()).toBe(before + 1);
  } finally { fixture.stop(); }
}, TIMEOUT_MS);

test("a runtime signer cannot get a foreign key signed: JWK and verificationMethod swapped together are refused before it is called", async () => {
  const fixture = await createHermeticEncryptedNode();
  const session = fixture.owner.restorableSession!;
  const original = { jwk: session.jwk, verificationMethod: session.verificationMethod };
  try {
    const t = setup(fixture, "runtime-signer-swap");
    const before = t.activations();
    const foreign = fixture.delegate.restorableSession!;
    session.jwk = foreign.jwk;
    session.verificationMethod = foreign.verificationMethod;
    await expect(fixture.owner.grantRuntimePermissions([t.entry], { signMessage: t.signer() }))
      .rejects.toThrow(/session key/i);
    expect(t.customSigns()).toBe(0);
    expect(t.ownerSigns()).toBe(0);
    expect(t.activations()).toBe(before);
    expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
  } finally {
    session.jwk = original.jwk;
    session.verificationMethod = original.verificationMethod;
    fixture.stop();
  }
}, TIMEOUT_MS);

test("a session key swapped while the runtime signer signs is refused before activation and installs no grant", async () => {
  const fixture = await createHermeticEncryptedNode();
  const session = fixture.owner.restorableSession!;
  const originalJwk = session.jwk;
  try {
    const t = setup(fixture, "runtime-signer-swap-while-signing");
    const before = t.activations();
    const foreign = fixture.delegate.restorableSession!.jwk;
    await expect(fixture.owner.grantRuntimePermissions([t.entry], {
      signMessage: t.signer(() => { session.jwk = foreign; }),
    })).rejects.toThrow(/session key/i);
    expect(t.customSigns()).toBe(1);
    expect(t.activations()).toBe(before);
    expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
  } finally {
    session.jwk = originalJwk;
    fixture.stop();
  }
}, TIMEOUT_MS);
