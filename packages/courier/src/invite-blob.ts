import { randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { base32 } from './invite-link.js';
import {
  inviteFolder,
  parseHello,
  parseInviteBlob,
  type OneTimeKey,
  type Permissions,
  type RequestedTier,
} from './invite-schema.js';
import type { PairArtifact } from './pairing.js';

/** A fresh 128-bit invite id: 26 lowercase base32 characters, the shape `INVITE_ID` accepts. */
export function newInviteId(): string {
  return base32(randomBytes(16));
}

export interface InviteBlobInput {
  inviteId: string;
  host: string;
  spaceId: string;
  oneTimeKey: OneTimeKey;
  permissions: Permissions;
  artifactA: PairArtifact;
  expiresAt: Date;
  expectEmail: string;
  /** Owner DID the invitee must match, or null for any owner. */
  expectOwner: string | null;
  /** Requested tier. The owner confirms trusted by hand; a self-service invite never grants it. */
  tier: RequestedTier;
}

/** Canonical JSON text of the sealed invitation. Self-checked against the strict parser before it is returned. */
export function buildInviteBlob(input: InviteBlobInput): string {
  const folder = inviteFolder(input.inviteId);
  const text = canonicalJson({
    v: 1,
    inviteId: input.inviteId,
    host: input.host,
    spaceId: input.spaceId,
    folder,
    helloKey: `${folder}in/hello.json`,
    outPrefix: `${folder}out/`,
    oneTimeKey: input.oneTimeKey,
    permissions: input.permissions,
    artifactA: input.artifactA,
    expiresAt: input.expiresAt.toISOString(),
    expectEmail: input.expectEmail,
    expectOwner: input.expectOwner,
    tier: input.tier,
  });
  parseInviteBlob(text);
  return text;
}

export interface HelloInput {
  inviteId: string;
  artifactB: PairArtifact;
  claimedLabel: string;
  credential?: string;
  possession?: string;
  sentAt: Date;
}

/** Canonical JSON text of the hello written to `in/hello.json`. Self-checked against the strict parser. */
export function buildHello(input: HelloInput): string {
  const hello: Record<string, unknown> = {
    v: 1,
    inviteId: input.inviteId,
    artifactB: input.artifactB,
    claimedLabel: input.claimedLabel,
    sentAt: input.sentAt.toISOString(),
  };
  if (input.credential !== undefined) hello.credential = input.credential;
  if (input.possession !== undefined) hello.possession = input.possession;
  const text = canonicalJson(hello);
  parseHello(text);
  return text;
}
