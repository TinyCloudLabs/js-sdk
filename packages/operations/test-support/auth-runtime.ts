import {
  additionalDelegationsPath,
  profileConfigPath,
  sessionPath,
  writeJsonAtomic,
} from "../src/state.js";
import type { PermissionEntry } from "@tinycloud/sdk-core";

export interface StoredRuntimeDelegation {
  readonly cid: string;
  readonly spaceId: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly ownerAddress: string;
  readonly chainId: number;
  readonly expiry: Date;
  readonly delegateDID: string;
  readonly delegationHeader: { readonly Authorization: string };
  readonly host?: string;
}

interface HermeticEncryptedNode {
  readonly host: string;
  readonly restorableSession: {
    readonly chainId: number;
    readonly spaceId: string;
    readonly verificationMethod: string;
  } & Record<string, unknown>;
  readonly permissions: readonly PermissionEntry[];
  readonly unrelatedAudience: string;
  mintDelegation(): Promise<StoredRuntimeDelegation>;
  mintDelegationWithPermissions(permissions: PermissionEntry[]): Promise<StoredRuntimeDelegation>;
  readAndDecrypt(node: unknown, delegation: unknown): Promise<void>;
  assertNarrowDelegatedReadAndDecrypt(delegation: unknown, expectedSigningIssuer?: string): void;
  stop(): void;
}

export interface AuthRuntimeFixtureOptions {
  readonly delegateBasePermissions?: boolean;
  readonly secretPayloadValue?: string;
  readonly secretPresent?: boolean;
}

export interface AuthRuntimeFixture {
  readonly profile: string;
  readonly sessionDid: string;
  readonly hermetic: HermeticEncryptedNode;
}

/**
 * Persists a real node-sdk session so operations tests exercise the same
 * fresh-runtime restore path used after a process restart.
 */
export async function createAuthRuntimeFixture(
  options: AuthRuntimeFixtureOptions = {},
): Promise<AuthRuntimeFixture> {
  const moduleUrl = new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts",
    import.meta.url,
  ).href;
  const module = await import(moduleUrl) as {
    createHermeticEncryptedNode(
      options?: AuthRuntimeFixtureOptions,
    ): Promise<HermeticEncryptedNode>;
  };
  const hermetic = await module.createHermeticEncryptedNode(options);
  const profile = "delegate";
  const sessionDid = hermetic.restorableSession.verificationMethod.split("#", 1)[0]!;

  try {
    await writeJsonAtomic(profileConfigPath(profile), {
      name: profile,
      host: hermetic.host,
      chainId: hermetic.restorableSession.chainId,
      spaceName: "secrets",
      spaceId: hermetic.restorableSession.spaceId,
      did: sessionDid,
      sessionDid,
      posture: "delegate-session",
      operatorType: "agent",
      authMethod: "openkey",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(profile), hermetic.restorableSession);
  } catch (error) {
    hermetic.stop();
    throw error;
  }

  return { profile, sessionDid, hermetic };
}

/** Persist only real compact delegations; display metadata is deliberately not authority. */
export async function persistRuntimeDelegations(
  fixture: AuthRuntimeFixture,
  delegations: readonly StoredRuntimeDelegation[],
): Promise<void> {
  await writeJsonAtomic(
    additionalDelegationsPath(fixture.profile),
    delegations.map((delegation) => ({
      delegation,
      permissions: [{
        service: "tinycloud.kv",
        path: "display-only",
        actions: ["tinycloud.kv/*"],
      }],
    })),
  );
}
