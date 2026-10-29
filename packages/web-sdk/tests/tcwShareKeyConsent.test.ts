import "./support/browserGlobalsShim";
import { describe, expect, spyOn, test } from "bun:test";
import {
  extractImmutableSiweFields,
  extractRecapAttenuations,
  principalDidEquals,
  verifyEip191MessageSignature,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { createHermeticEncryptedNode, type HermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

// Avoid process-wide source-module mocks installed by other Web tests.
const { TinyCloudWeb } = require("../dist/index.cjs") as { TinyCloudWeb: typeof TinyCloudWebType };
const manifest = { app_id: "test.web.exact-key", name: "Web exact Share-key", permissions: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function consumer(fixture: HermeticEncryptedNode, platform: "web" | "native" = "web") {
  const opened = deferred<void>();
  const consent = deferred<{ approved: boolean }>();
  let modalCount = 0;
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  Object.assign(tcw, {
    _manifest: structuredClone(manifest),
    _node: fixture.owner,
    config: { ui: { platform } },
    signOutCount: 0,
    signOutInFlight: 0,
    session: () => fixture.owner.session,
    _testHooks: {
      showModal: async () => {
        modalCount++;
        opened.resolve();
        return consent.promise;
      },
    },
  });
  const entry: PermissionEntry = {
    service: "tinycloud.encryption",
    path: `urn:tinycloud:encryption:${fixture.ownerDid}:default/share/web-consent`,
    actions: ["tinycloud.encryption/key.create"],
  };
  const signer = Reflect.get(fixture.owner, "signer") as { signMessage(message: string): Promise<string> };
  const signing = spyOn(signer, "signMessage"); // calls the real signer
  const activationCount = () => fixture.requests().filter((r) => r.path === "/delegate").length;
  return { tcw, entry, opened, consent, signing, activationCount, modalCount: () => modalCount };
}

async function awaitModal(opened: Promise<void>, pending: Promise<unknown>) {
  // An early validation failure must fail the assertion, not leave a hung test.
  await Promise.race([opened, pending.then(() => {
    throw new Error("request completed before consent opened");
  })]);
}

describe("TinyCloudWeb exact Share-key consumer transition", () => {
  test("fresh owner awaits consent, signs and activates only the exact resource", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const c = consumer(fixture);
      const baseline = c.activationCount();
      const baseExpiry = Date.parse(extractImmutableSiweFields(fixture.ownerRestorableSession.siwe).expirationTime!);
      const pending = c.tcw.requestPermissions([c.entry], { expiryMs: 60_000 });
      await awaitModal(c.opened.promise, pending);
      expect(c.signing).not.toHaveBeenCalled();
      expect(c.activationCount()).toBe(baseline);
      c.consent.resolve({ approved: true });
      const result = await pending;
      expect(result.approved).toBe(true);
      expect(c.signing).toHaveBeenCalledTimes(1);
      expect(c.activationCount()).toBe(baseline + 1);
      expect(result.delegations).toHaveLength(1);
      const delegation = result.delegations![0]!;
      const proof = delegation.siweProof!;
      expect(await verifyEip191MessageSignature(proof.siwe, proof.signature, fixture.owner.address!)).toBe(true);
      expect(principalDidEquals(delegation.delegateDID, fixture.owner.sessionDid)).toBe(true);
      const signedFields = extractImmutableSiweFields(proof.siwe);
      expect(principalDidEquals(signedFields.uri!, fixture.owner.sessionDid)).toBe(true);
      expect(Date.parse(signedFields.expirationTime!)).toBeLessThanOrEqual(baseExpiry);
      expect(new Date(delegation.expiry).getTime()).toBeLessThanOrEqual(baseExpiry);
      expect(extractRecapAttenuations(proof.siwe)).toEqual({
        [c.entry.path]: { "tinycloud.encryption/key.create": [{}] },
      });
      expect(fixture.owner.hasRuntimePermissions([c.entry])).toBe(true);
      expect(fixture.owner.hasRuntimePermissions([{ ...c.entry, path: `${c.entry.path}-sibling` }])).toBe(false);
      expect(c.tcw.getManifest()).toEqual(manifest);
      const repeated = await c.tcw.requestPermissions([c.entry]);
      expect(repeated.approved).toBe(true);
      expect(c.modalCount()).toBe(1);
      expect(c.signing).toHaveBeenCalledTimes(1);
      expect(c.activationCount()).toBe(baseline + 1);
    } finally { fixture.stop(); }
  });

  test("decline creates no signature or activation", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const c = consumer(fixture);
      const baseline = c.activationCount();
      const pending = c.tcw.requestPermissions([c.entry]);
      await awaitModal(c.opened.promise, pending);
      c.consent.resolve({ approved: false });
      expect(await pending).toEqual({ approved: false });
      expect(c.signing).not.toHaveBeenCalled();
      expect(c.activationCount()).toBe(baseline);
      expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
    } finally { fixture.stop(); }
  });

  test("foreign owner is rejected without opening consent or signing", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const c = consumer(fixture);
      const baseline = c.activationCount();
      const foreign = { ...c.entry, path: c.entry.path.replace(fixture.ownerDid, "did:pkh:eip155:1:0x0000000000000000000000000000000000000001") };
      await expect(c.tcw.requestPermissions([foreign])).rejects.toThrow();
      expect(c.modalCount()).toBe(0);
      expect(c.signing).not.toHaveBeenCalled();
      expect(c.activationCount()).toBe(baseline);
    } finally { fixture.stop(); }
  });

  for (const change of ["signed session", "node", "sign-out", "sign-out in flight"] as const) {
    test(`${change} replacement during consent refuses before signing or activation`, async () => {
      const fixture = await createHermeticEncryptedNode();
      try {
        const c = consumer(fixture);
        const pending = c.tcw.requestPermissions([c.entry]);
        await awaitModal(c.opened.promise, pending);
        if (change === "signed session") await fixture.owner.restoreSession(fixture.restorableSession);
        if (change === "node") Reflect.set(c.tcw, "_node", fixture.delegate);
        if (change === "sign-out") Reflect.set(c.tcw, "signOutCount", 1);
        if (change === "sign-out in flight") Reflect.set(c.tcw, "signOutInFlight", 1);
        const baseline = c.activationCount();
        c.signing.mockClear();
        c.consent.resolve({ approved: true });
        await expect(pending).rejects.toThrow(/session|sign.out|cancel/i);
        expect(c.signing).not.toHaveBeenCalled();
        expect(c.activationCount()).toBe(baseline);
        expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
        expect(fixture.delegate.getRuntimePermissionDelegations()).toEqual([]);
      } finally { fixture.stop(); }
    });
  }

  test("native platform refuses the bounded path without falling back to a web signer", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const c = consumer(fixture, "native");
      const baseline = c.activationCount();
      await expect(c.tcw.requestPermissions([c.entry])).rejects.toThrow(/native|unsupported/i);
      expect(c.modalCount()).toBe(0);
      expect(c.signing).not.toHaveBeenCalled();
      expect(c.activationCount()).toBe(baseline);
    } finally { fixture.stop(); }
  });
});
