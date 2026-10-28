import type { PermissionEntry, PortableDelegation } from "@tinycloud/node-sdk";

export interface HermeticEncryptedNode {
  readonly host: string;
  readonly ownerDid: string;
  readonly applicationsSpaceId: string;
  configureKv(spaceId: string, entries: Record<string, unknown>): void;
  mintDelegationForAudienceWithPermissions(
    audience: string,
    permissions: PermissionEntry[],
    options?: { expiry?: string | number },
  ): Promise<PortableDelegation>;
  invocations(): readonly { service: string; action: string; path: string }[];
  stop(): void;
}

export function createHermeticEncryptedNode(options?: {
  ownerConnectorCapabilities?: boolean;
}): Promise<HermeticEncryptedNode>;
