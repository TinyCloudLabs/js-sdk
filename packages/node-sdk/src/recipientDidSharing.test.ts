import { describe, expect, mock, test } from "bun:test";
import type {
  IWasmBindings,
  ISessionManager,
  RecipientDidDelegationBundleV2,
  TinyCloudSession,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import {
  RecipientDidSharingError,
  type SignShareEnvelopeV2Input,
} from "./recipientDidSharing";
import vector from "./test-fixtures/recipient-did-v2.json";

const accepted = vector.envelope;
const grantJwt = accepted.delegation.grant.value;
const grantHeader = JSON.parse(
  Buffer.from(grantJwt.split(".")[0], "base64url").toString("utf8"),
) as { jwk: Record<string, string> };
const sessionJwk = {
  ...grantHeader.jwk,
  d: vector.currentSdkFixture.sessionJwkD,
};
const rootProof = accepted.delegation.issuerProofs[0];

function sessionManager(): ISessionManager {
  let exists = false;
  return {
    createSessionKey(id) {
      exists = true;
      return id;
    },
    renameSessionKeyId() {},
    getDID() {
      return accepted.signature.signerDid;
    },
    jwk() {
      return exists ? JSON.stringify(sessionJwk) : undefined;
    },
  };
}

function wasm(overrides: Partial<IWasmBindings> = {}): IWasmBindings {
  const rootBytes = Buffer.from(rootProof.value, "base64url");
  return {
    invoke: mock(() => Promise.resolve({} as never)) as never,
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    computeCid(data) {
      if (Buffer.from(data).equals(rootBytes)) return rootProof.cid;
      if (new TextDecoder().decode(data).split(".").length === 3) {
        return accepted.delegation.grant.cid;
      }
      throw new Error("unexpected CID preimage");
    },
    ensureEip55: (address) => address,
    makeSpaceId: (address, chainId, prefix) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: mock(() => ({})),
    parseRecapFromSiwe: mock(() => []),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(),
      privateKey: new Uint8Array(),
    })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: sessionManager,
    ...overrides,
  };
}

function activeSession(): TinyCloudSession {
  const grantPayload = JSON.parse(
    Buffer.from(grantJwt.split(".")[1], "base64url").toString("utf8"),
  ) as { iss: string };
  const address = accepted.target.spaceId.split(":")[4];
  return {
    address,
    chainId: 1,
    sessionKey: "default",
    spaceId: accepted.target.spaceId,
    delegationCid: rootProof.cid,
    delegationHeader: { Authorization: rootProof.value },
    verificationMethod: grantPayload.iss,
    jwk: sessionJwk,
    siwe: "fixture SIWE",
    signature: "fixture wallet signature",
  };
}

function input(): SignShareEnvelopeV2Input {
  const address = accepted.target.spaceId.split(":")[4];
  return {
    version: 2,
    shareId: accepted.shareId,
    delegation: {
      routing: accepted.delegation.routing,
      grant: {
        cid: accepted.delegation.grant.cid,
        delegationHeader: { Authorization: grantJwt },
        spaceId: accepted.target.spaceId,
        path: accepted.target.resource.path,
        actions: [...accepted.target.actions],
        expiry: new Date(accepted.expiry),
        delegateDID: accepted.authorizationTarget.did,
        ownerAddress: address,
        chainId: 1,
        host: accepted.target.origin,
      },
    },
    authorizationTarget: accepted.authorizationTarget,
    target: accepted.target,
    display: accepted.display,
    expiry: accepted.expiry,
  };
}

function nodeWithSession(
  bindings = wasm(),
  session = activeSession(),
): TinyCloudNode {
  const node = new TinyCloudNode({ wasmBindings: bindings });
  (node as unknown as { auth: { tinyCloudSession: TinyCloudSession } }).auth = {
    tinyCloudSession: session,
  };
  return node;
}

const nativeRuntime = await import("@tinycloud/node-sdk-wasm").catch(
  () => undefined,
);
const nativeVerifierAvailable =
  typeof nativeRuntime?.verifyRecipientDidDelegationBundleV2 === "function";
const nativeVerifierRequired =
  process.env.TINYCLOUD_REQUIRE_RECIPIENT_DID_NATIVE_VERIFIER === "1";
const nativeVerifierTest = test.skipIf(!nativeVerifierAvailable);

async function realNativeBindings(): Promise<IWasmBindings> {
  if (!nativeVerifierAvailable) {
    throw new Error("Native recipient-DID verifier test was not skipped");
  }
  const { NodeWasmBindings } = await import("./NodeWasmBindings");
  return new NodeWasmBindings();
}

describe("recipient-DID share envelope v2 SDK seam", () => {
  test("matches the Stage 0A genuine SDK golden signature", async () => {
    const node = nodeWithSession();
    const result = await node.signShareEnvelopeV2(input());

    expect(result.envelope).toEqual(accepted);
    expect(result.signature).toBe(accepted.signature.value);
    expect(result.signerDid).toBe(accepted.signature.signerDid);
    expect(result.issuerProofs).toEqual(accepted.delegation.issuerProofs);
    expect(JSON.stringify(result)).not.toContain(
      vector.currentSdkFixture.sessionJwkD,
    );
    expect("jwk" in result).toBe(false);
    expect(
      (node as unknown as Record<string, unknown>).signBytes,
    ).toBeUndefined();
  });

  test("reconstructs the signed projection instead of signing caller extras", async () => {
    const draft = input() as SignShareEnvelopeV2Input & {
      unsignedExtension: string;
      signature: { signerDid: string; algorithm: string };
    };
    draft.unsignedExtension = "must-not-be-signed";
    draft.signature = { signerDid: "did:key:attacker", algorithm: "arbitrary" };

    const result = await nodeWithSession().signShareEnvelopeV2(draft);

    expect(result.envelope).toEqual(accepted);
    expect("unsignedExtension" in result.envelope).toBe(false);
    expect(result.envelope.signature.signerDid).toBe(
      accepted.signature.signerDid,
    );
  });

  test("rejects non-string and empty share IDs before signing", async () => {
    for (const shareId of [42, {}, [], ""]) {
      const draft = input();
      Object.defineProperty(draft, "shareId", { value: shareId });

      await expect(
        nodeWithSession().signShareEnvelopeV2(draft),
      ).rejects.toMatchObject({
        name: "RecipientDidSharingError",
        code: "INVALID_INPUT",
      });
    }
  });

  test("rejects a grant not directly parented by the active owner Cacao", async () => {
    const session = activeSession();
    session.delegationCid = "bafkr4i-different-active-owner-cacao";
    const bindings = wasm({
      computeCid(data) {
        return new TextDecoder().decode(data).split(".").length === 3
          ? accepted.delegation.grant.cid
          : session.delegationCid;
      },
    });

    await expect(
      nodeWithSession(bindings, session).signShareEnvelopeV2(input()),
    ).rejects.toMatchObject({
      name: "RecipientDidSharingError",
      code: "SESSION_NOT_OWNER_ROOT",
    });
  });

  test("rejects a tampered recipient UCAN signature", async () => {
    const draft = input();
    const segments =
      draft.delegation.grant.delegationHeader.Authorization.split(".");
    segments[2] = `${segments[2].slice(0, -1)}${segments[2].endsWith("A") ? "B" : "A"}`;
    (
      draft.delegation.grant.delegationHeader as { Authorization: string }
    ).Authorization = segments.join(".");

    await expect(
      nodeWithSession().signShareEnvelopeV2(draft),
    ).rejects.toBeInstanceOf(RecipientDidSharingError);
  });

  test("keeps the optional native boundary compatible and fails closed when absent", () => {
    const node = nodeWithSession();
    expect(() =>
      node.verifyRecipientDidDelegationBundleV2(
        accepted.delegation as RecipientDidDelegationBundleV2,
      ),
    ).toThrow("does not provide atomic recipient-DID delegation verification");
  });

  test("passes the complete bundle and deterministic epoch to the native verifier", () => {
    const verify = mock(() => vector.nativeVerified);
    const node = nodeWithSession(
      wasm({
        verifyRecipientDidDelegationBundleV2: verify,
      }),
    );
    const now = new Date("2030-01-01T00:00:00.999Z");

    const result = node.verifyRecipientDidDelegationBundleV2(
      accepted.delegation as RecipientDidDelegationBundleV2,
      now,
    );

    expect(result).toEqual(vector.nativeVerified);
    expect(verify).toHaveBeenCalledWith(accepted.delegation, 1_893_456_000n);
  });

  test.skipIf(!nativeVerifierRequired)(
    "release gate requires the native recipient-DID verifier symbol",
    () => {
      expect(nativeVerifierAvailable).toBe(true);
    },
  );

  nativeVerifierTest(
    "verifies the genuine direct vector through built Node WASM (skipped when the pinned runtime lacks the native verifier)",
    async () => {
      const bindings = await realNativeBindings();

      const verified = nodeWithSession(
        bindings,
      ).verifyRecipientDidDelegationBundleV2(
        accepted.delegation as RecipientDidDelegationBundleV2,
        new Date("2029-01-01T00:00:00.000Z"),
      );

      expect(verified).toEqual(vector.nativeVerified);
    },
  );

  nativeVerifierTest(
    "verifies a genuine intermediate UCAN chain through built Node WASM (skipped when the pinned runtime lacks the native verifier)",
    async () => {
      const bindings = await realNativeBindings();

      const sessionTwoManager = bindings.createSessionManager();
      sessionTwoManager.createSessionKey("intermediate");
      const sessionTwoVerificationMethod =
        sessionTwoManager.getDID("intermediate");
      const sessionTwoDid = sessionTwoVerificationMethod.split("#", 1)[0];
      const sessionTwoJwk = {
        ...(JSON.parse(
          sessionTwoManager.jwk("intermediate") as string,
        ) as object),
        alg: "EdDSA",
      };
      const abilities = {
        kv: { [accepted.target.resource.path]: ["tinycloud.kv/get"] },
      };
      const intermediate = bindings.createDelegation(
        {
          delegationHeader: { Authorization: rootProof.value },
          delegationCid: rootProof.cid,
          jwk: sessionJwk,
          spaceId: accepted.target.spaceId,
          verificationMethod: activeSession().verificationMethod,
        },
        sessionTwoDid,
        accepted.target.spaceId,
        abilities,
        4_100_000_000,
        undefined,
      ) as { cid: string; delegation: string };
      const grant = bindings.createDelegation(
        {
          delegationHeader: { Authorization: intermediate.delegation },
          delegationCid: intermediate.cid,
          jwk: sessionTwoJwk,
          spaceId: accepted.target.spaceId,
          verificationMethod: sessionTwoVerificationMethod,
        },
        accepted.authorizationTarget.did,
        accepted.target.spaceId,
        abilities,
        4_000_000_000,
        undefined,
      ) as { cid: string; delegation: string };
      const bundle: RecipientDidDelegationBundleV2 = {
        ...accepted.delegation,
        grant: {
          kind: "ucan",
          cid: grant.cid,
          encoding: "jwt",
          value: grant.delegation,
        },
        issuerProofs: [
          rootProof,
          {
            kind: "ucan",
            cid: intermediate.cid,
            encoding: "jwt",
            value: intermediate.delegation,
          },
        ],
      };

      const verified = nodeWithSession(
        bindings,
      ).verifyRecipientDidDelegationBundleV2(
        bundle,
        new Date("2029-01-01T00:00:00.000Z"),
      );

      expect(verified.sessionPrincipalDid).toBe(sessionTwoDid);
      expect(verified.grantCid).toBe(grant.cid);
      expect(verified.proofCids).toEqual([rootProof.cid, intermediate.cid]);
      expect(verified.scope).toEqual(vector.nativeVerified.scope);
    },
  );

  test("normalizes envelope expiry to the grant's whole epoch second", async () => {
    const draft = input() as { expiry: string } & SignShareEnvelopeV2Input;
    draft.expiry = draft.expiry.replace(".000Z", ".999Z");

    const result = await nodeWithSession().signShareEnvelopeV2(draft);

    expect(result.envelope.expiry).toBe(accepted.expiry);
    expect(result.envelope).toEqual(accepted);
  });
});
