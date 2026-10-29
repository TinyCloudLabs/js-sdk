import { expect, spyOn, test } from "bun:test";
import { SiweMessage } from "siwe";
import { principalDidEquals } from "@tinycloud/sdk-core";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("exact Share-key grant refuses a live JWK that differs from the signed session identity", async () => {
  const fixture = await createHermeticEncryptedNode();
  const signer = Reflect.get(fixture.owner, "signer") as { signMessage(message: string): Promise<string> };
  const signing = spyOn(signer, "signMessage");
  try {
    const before = fixture.requests().filter((r) => r.path === "/delegate").length;
    fixture.owner.restorableSession!.jwk = fixture.delegate.restorableSession!.jwk;
    await expect(fixture.owner.grantRuntimePermissions([{
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${fixture.ownerDid}:default/share/wrong-live-key`,
      actions: ["tinycloud.encryption/key.create"],
    }])).rejects.toThrow();
    expect(signing).not.toHaveBeenCalled();
    expect(fixture.requests().filter((r) => r.path === "/delegate").length).toBe(before);
    expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
  } finally { signing.mockRestore(); fixture.stop(); }
});

test("a key change while the wallet signs cannot retarget or activate the captured request", async () => {
  const fixture = await createHermeticEncryptedNode();
  const signer = Reflect.get(fixture.owner, "signer") as { signMessage(message: string): Promise<string> };
  const realSign = signer.signMessage.bind(signer);
  const started = deferred<string>();
  const finish = deferred<void>();
  const signing = spyOn(signer, "signMessage").mockImplementation(async (message: string) => {
    started.resolve(new SiweMessage(message).uri);
    await finish.promise;
    return realSign(message);
  });
  try {
    const before = fixture.requests().filter((r) => r.path === "/delegate").length;
    const capturedDid = fixture.owner.sessionDid;
    const capturedKey = Object.freeze({ ...fixture.owner.restorableSession!.jwk });
    const pending = fixture.owner.grantRuntimePermissions([{
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${fixture.ownerDid}:default/share/wallet-pending`,
      actions: ["tinycloud.encryption/key.create"],
    }], { expectedSessionKey: capturedKey });
    const audience = await Promise.race([started.promise, pending.then(() => { throw new Error("grant completed without wallet signing"); })]);
    expect(principalDidEquals(audience, capturedDid)).toBe(true);
    fixture.owner.restorableSession!.jwk = fixture.delegate.restorableSession!.jwk;
    finish.resolve();
    await expect(pending).rejects.toThrow();
    expect(fixture.requests().filter((r) => r.path === "/delegate").length).toBe(before);
    expect(fixture.owner.getRuntimePermissionDelegations()).toEqual([]);
  } finally { finish.resolve(); signing.mockRestore(); fixture.stop(); }
});
