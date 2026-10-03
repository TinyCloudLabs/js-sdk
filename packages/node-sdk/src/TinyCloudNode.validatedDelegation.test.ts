import { describe, expect, test } from "bun:test";

import type { PermissionEntry } from "@tinycloud/sdk-core";

import { activateValidatedRuntimeDelegation, siweRuntimeDelegation } from "./delegation";
import type { PortableDelegation } from "./delegation";
import {
  activateValidatedRuntimeDelegation as publicActivateValidatedRuntimeDelegation,
} from "./index";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import {
  createHermeticEncryptedNode,
  type HermeticEncryptedNode,
} from "./test-support/hermetic-encrypted-node";

/** An OpenKey-style signed-login (CACAO) delegation to `jwk`'s session key. */
async function signedLoginDelegation(
  ownerPrivateKey: string,
  jwk: object,
  abilities: Record<string, Record<string, string[]>>,
) {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(ownerPrivateKey);
  const address = await signer.getAddress();
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities,
    address,
    chainId: 1,
    domain: "openkey.test",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60 * 60_000).toISOString(),
    spaceId: wasm.makeSpaceId(address, 1, "applications"),
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    authorization: session.delegationHeader.Authorization,
    cid: session.delegationCid,
    spaceId: prepared.spaceId,
    ownerAddress: address,
    chainId: 1,
    siwe: prepared.siwe,
    signature,
  };
}

function cloneDelegation(
  delegation: Awaited<ReturnType<HermeticEncryptedNode["mintDelegation"]>>,
  overrides: Record<string, unknown>,
) {
  return {
    ...delegation,
    delegationHeader: { ...delegation.delegationHeader },
    actions: [...delegation.actions],
    resources: delegation.resources?.map((resource) => ({
      ...resource,
      actions: [...resource.actions],
    })),
    ...overrides,
  };
}

function signedProvenance(authorization: string): {
  issuer: string;
  proofs: string[];
  remainingRedelegationDepth?: number;
} {
  const compact = authorization.replace(/^Bearer /i, "");
  const payload = JSON.parse(
    Buffer.from(compact.split(".")[1]!, "base64url").toString("utf8"),
  ) as {
    iss: string;
    prf: string[];
    fct?: Array<{ remainingRedelegationDepth?: number }>;
  };
  return {
    issuer: payload.iss,
    proofs: payload.prf,
    ...(payload.fct?.[0]?.remainingRedelegationDepth === undefined
      ? {}
      : { remainingRedelegationDepth: payload.fct[0].remainingRedelegationDepth }),
  };
}

describe("activateValidatedRuntimeDelegation", () => {
  test("exports the validated activation helper from the node-sdk entrypoint", () => {
    expect(publicActivateValidatedRuntimeDelegation).toBe(
      activateValidatedRuntimeDelegation,
    );
  });

  test("CID-binds a real WASM delegation, installs it, and exercises narrow encrypted KV read/decrypt", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const delegation = await fixture.mintDelegation();
      const activated = await activateValidatedRuntimeDelegation(
        fixture.delegate,
        delegation,
        { host: fixture.host },
      );

      expect(activated.cid).toBe(delegation.cid);
      expect(activated.delegation).toBe(
        fixture.delegate
          .getRuntimePermissionDelegations()
          .find((installed) => installed.cid === delegation.cid),
      );
      expect(activated.audience).toBe(fixture.delegate.sessionDid.split("#", 1)[0]);
      expect(activated.host).toBe(fixture.host);
      expect(activated.effectivePermissions).toEqual(fixture.permissions);
      expect(fixture.delegate.getEffectiveRuntimePermissionEntries()).toEqual(
        fixture.permissions,
      );
      expect(activated.expiry.getTime()).toBe(delegation.expiry.getTime());
      expect(activated.delegation).not.toHaveProperty("permissions");

      await fixture.readAndDecrypt(fixture.delegate, activated);
      fixture.assertNarrowDelegatedReadAndDecrypt(activated);
    } finally {
      fixture.stop();
    }
  });

  test("derives installed provenance from signed authority instead of transport metadata", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const delegation = await fixture.mintDelegation();
      const provenance = signedProvenance(
        delegation.delegationHeader.Authorization,
      );
      const annotated = cloneDelegation(delegation, {
        delegatorDID: "did:key:spoofed-delegator",
        parentCid: "bafy-spoofed-parent",
        allowSubDelegation: provenance.remainingRedelegationDepth === 0,
        disableSubDelegation: provenance.remainingRedelegationDepth !== 0,
        authHeader: "spoofed-authorization",
      });
      const activated = await activateValidatedRuntimeDelegation(
        fixture.delegate,
        annotated,
        { host: fixture.host },
      );

      expect(activated.delegation.delegatorDID).toBe(provenance.issuer);
      expect(activated.delegation.parentCid).toBe(
        provenance.proofs.length === 1 ? provenance.proofs[0] : undefined,
      );
      if (provenance.remainingRedelegationDepth !== undefined) {
        expect(activated.delegation.allowSubDelegation).toBe(
          provenance.remainingRedelegationDepth > 0,
        );
        expect(activated.delegation.disableSubDelegation).toBe(
          provenance.remainingRedelegationDepth === 0,
        );
      }
      expect(activated.delegation.authHeader).toBe(
        delegation.delegationHeader.Authorization,
      );
    } finally {
      fixture.stop();
    }
  });

  test("rejects an altered artifact audience, CID, or authorization bytes before activation", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const delegation = await fixture.mintDelegation();
      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, {
            delegateDID: fixture.unrelatedAudience,
          }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/audience does not match signed authority/);

      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, { cid: `${delegation.cid}altered` }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/CID does not match authorization bytes/);

      const authorization = delegation.delegationHeader.Authorization;
      const replacement = authorization.endsWith("A") ? "B" : "A";
      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, {
            delegationHeader: {
              Authorization: `${authorization.slice(0, -1)}${replacement}`,
            },
          }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/CID does not match authorization bytes/);
    } finally {
      fixture.stop();
    }
  });

  test("rejects wrong signed audience, wrong host, and expiry", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const wrongAudience = await fixture.mintDelegationForAudience(
        fixture.unrelatedAudience,
      );
      await expect(
        activateValidatedRuntimeDelegation(fixture.delegate, wrongAudience, {
          host: fixture.host,
        }),
      ).rejects.toThrow(/targets .* but this session is/);

      const delegation = await fixture.mintDelegation();
      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, { host: "http://wrong-loopback.invalid" }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/host .* does not match/);

      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, { expiry: new Date(Date.now() - 1) }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/expired/);

      await expect(
        activateValidatedRuntimeDelegation(
          fixture.delegate,
          cloneDelegation(delegation, {
            expiry: new Date(delegation.expiry.getTime() - 1_000),
          }),
          { host: fixture.host },
        ),
      ).rejects.toThrow(/expiry does not match signed authority/);
    } finally {
      fixture.stop();
    }
  });

  test("rejects a real but transport-unrecognized delegation chain", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const untrusted = await fixture.mintUntrustedDelegation();
      await expect(
        activateValidatedRuntimeDelegation(fixture.delegate, untrusted, {
          host: fixture.host,
        }),
      ).rejects.toThrow(/Failed to activate runtime permission delegation/);
    } finally {
      fixture.stop();
    }
  });

  test("derives signed effective permissions, ignores artifact display permissions, and rejects broadening", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const delegation = await fixture.mintDelegation();
      const artifactWithBroadDisplayPermissions = {
        ...delegation,
        permissions: [
          {
            service: "tinycloud.kv",
            space: delegation.spaceId,
            path: "",
            actions: ["tinycloud.kv/*"],
          },
        ] satisfies PermissionEntry[],
      };
      const activated = await activateValidatedRuntimeDelegation(
        fixture.delegate,
        artifactWithBroadDisplayPermissions,
        { host: fixture.host },
      );
      expect(activated.effectivePermissions).toEqual(fixture.permissions);

      const broadened = cloneDelegation(delegation, {
        resources: delegation.resources?.map((resource) =>
          resource.service === "kv"
            ? {
                ...resource,
                actions: [...resource.actions, "tinycloud.kv/put"],
              }
            : resource,
        ),
      });
      await expect(
        activateValidatedRuntimeDelegation(fixture.delegate, broadened, {
          host: fixture.host,
        }),
      ).rejects.toThrow(/do not match signed authority/);
    } finally {
      fixture.stop();
    }
  });

  test("preserves a signed ReCap caveat through activation and installed resources", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const node = fixture.delegate as unknown as {
        readonly wasmBindings: {
          invokeAny(session: unknown, entries: readonly Record<string, unknown>[]): { Authorization: string };
        };
        currentTinyCloudSession(): unknown;
        readonly sessionDid: string;
        computeDelegationCid(authorization: string): string;
        useRuntimeDelegation(delegation: PortableDelegation): Promise<void>;
        getRuntimePermissionDelegations(): PortableDelegation[];
      };
      const permission = fixture.permissions.find((entry) => entry.service === "tinycloud.kv");
      if (permission?.space === undefined) throw new Error("expected a space-scoped permission");
      const caveat = { tenant: "alpha", nested: { region: "us-east-1" } };
      const authorization = node.wasmBindings.invokeAny(node.currentTinyCloudSession(), [{
        spaceId: permission.space,
        service: "kv",
        path: permission.path,
        action: "tinycloud.kv/get",
        caveats: [caveat],
      }]).Authorization;
      const payload = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString()) as {
        exp: number;
      };
      const cid = node.computeDelegationCid(authorization);
      const delegation = {
        cid,
        delegationHeader: { Authorization: authorization },
        ownerAddress: fixture.restorableSession.address,
        chainId: fixture.restorableSession.chainId,
        spaceId: permission.space,
        path: permission.path,
        actions: ["tinycloud.kv/get"],
        caveats: [caveat],
        resources: [{
          service: "kv",
          space: permission.space,
          path: permission.path,
          actions: ["tinycloud.kv/get"],
          caveats: [caveat],
        }],
        expiry: new Date(payload.exp * 1000),
        delegateDID: node.sessionDid,
        host: fixture.host,
      };
      const activated = await activateValidatedRuntimeDelegation(
        node,
        delegation,
        { host: fixture.host },
      );

      expect(activated.effectivePermissions).toEqual([{
        service: "tinycloud.kv",
        space: permission.space,
        path: permission.path,
        actions: ["tinycloud.kv/get"],
        caveats: [caveat],
      }]);
      expect(activated.delegation.resources?.[0]?.caveats).toEqual([caveat]);
      expect(fixture.delegate.getEffectiveRuntimePermissionEntries()).toEqual([{
        service: "tinycloud.kv",
        space: permission.space,
        path: permission.path,
        actions: ["tinycloud.kv/get"],
        caveats: [caveat],
      }]);
    } finally {
      fixture.stop();
    }
  });

  test("allows idempotent activation only for the same validated CID and contents", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const delegation = await fixture.mintDelegation();
      const first = await activateValidatedRuntimeDelegation(
        fixture.delegate,
        delegation,
        { host: fixture.host },
      );
      const second = await activateValidatedRuntimeDelegation(
        fixture.delegate,
        delegation,
        { host: fixture.host },
      );

      expect(second).toEqual(first);
      expect(
        fixture.delegate
          .getRuntimePermissionDelegations()
          .filter((installed) => installed.cid === delegation.cid),
      ).toHaveLength(1);

      second.delegation.delegationHeader.Authorization = "different-installed-content";
      await expect(
        activateValidatedRuntimeDelegation(fixture.delegate, delegation, {
          host: fixture.host,
        }),
      ).rejects.toThrow(/different authorization is already installed/);
    } finally {
      fixture.stop();
    }
  });

  test("activates a signed-login (CACAO) delegation from its verified SIWE and replays it after restore", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const signed = await signedLoginDelegation(
        fixture.ownerPrivateKey,
        fixture.restorableSession.jwk,
        { kv: { "agents/demo/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
      );
      const delegation = siweRuntimeDelegation(fixture.delegate, { ...signed, host: fixture.host });
      const activated = await activateValidatedRuntimeDelegation(fixture.delegate, delegation, {
        host: fixture.host,
      });
      // The verifier's per-action entries come back as one grouped grant.
      expect(activated.effectivePermissions).toEqual([{
        service: "tinycloud.kv",
        space: signed.spaceId,
        path: "agents/demo/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      }]);
      expect(activated.audience).toBe(fixture.delegate.sessionDid);
      expect(activated.delegation.delegatorDID).toBe(`did:pkh:eip155:1:${signed.ownerAddress}`);
      expect(activated.expiry.toISOString()).toBe(delegation.expiry.toISOString());

      // Runtime replay: the persisted record activates again on a fresh restore.
      const persisted = JSON.parse(JSON.stringify(activated.delegation)) as PortableDelegation;
      const restored = fixture.createRestoredDelegate();
      await restored.restoreSession(fixture.restorableSession);
      const replayed = await activateValidatedRuntimeDelegation(
        restored,
        { ...persisted, expiry: new Date(persisted.expiry) },
        { host: fixture.host },
      );
      expect(replayed.effectivePermissions).toEqual(activated.effectivePermissions);
    } finally {
      fixture.stop();
    }
  });

  test("refuses signed-login delegations that are not exactly what the owner signed for this key", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const abilities = { kv: { "agents/demo/profile": ["tinycloud.kv/get"] } };
      const signed = await signedLoginDelegation(fixture.ownerPrivateKey, fixture.restorableSession.jwk, abilities);
      const delegation = siweRuntimeDelegation(fixture.delegate, { ...signed, host: fixture.host });
      const activate = (candidate: PortableDelegation) =>
        activateValidatedRuntimeDelegation(fixture.delegate, candidate, { host: fixture.host });

      // Addressed to a different session key.
      const elsewhere = await signedLoginDelegation(
        fixture.ownerPrivateKey,
        JSON.parse(new NodeWasmBindings().createSessionManager().jwk("default")!),
        abilities,
      );
      expect(() => siweRuntimeDelegation(fixture.delegate, { ...elsewhere, host: fixture.host })).toThrow();
      // Declared resources broader than the signed ReCap.
      await expect(activate({
        ...delegation,
        resources: delegation.resources!.map((resource) => ({ ...resource, path: "agents/" })),
      })).rejects.toThrow(/resources do not match/);
      // A proof that is not the SIWE behind these CACAO bytes.
      const other = await signedLoginDelegation(fixture.ownerPrivateKey, fixture.restorableSession.jwk, abilities);
      await expect(activate({
        ...delegation,
        siweProof: { siwe: other.siwe, signature: other.signature },
      })).rejects.toThrow();
      // A claimed owner other than the signer.
      await expect(activate({
        ...delegation,
        ownerAddress: await new PrivateKeySigner("4".padStart(64, "0")).getAddress(),
      })).rejects.toThrow();
      // Without its proof the CACAO is still refused, as before.
      await expect(activate({ ...delegation, siweProof: undefined }))
        .rejects.toThrow(/compact UCAN/);
      expect(fixture.delegate.getRuntimePermissionDelegations()).toEqual([]);
    } finally {
      fixture.stop();
    }
  });
});
