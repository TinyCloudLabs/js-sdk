import { describe, expect, test } from "bun:test";

import type { PermissionEntry } from "@tinycloud/sdk-core";

import { activateValidatedRuntimeDelegation } from "./delegation";
import {
  activateValidatedRuntimeDelegation as publicActivateValidatedRuntimeDelegation,
} from "./index";
import {
  createHermeticEncryptedNode,
  type HermeticEncryptedNode,
} from "./test-support/hermetic-encrypted-node";

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
      expect(activated.expiry.getTime()).toBe(delegation.expiry.getTime());
      expect(activated.delegation).not.toHaveProperty("permissions");

      await fixture.readAndDecrypt(fixture.delegate, activated);
      fixture.assertNarrowDelegatedReadAndDecrypt(activated);
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
});
