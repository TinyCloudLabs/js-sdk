import type { ReplicationIdentity } from "./types";

const SPACE_ID = /^(tinycloud:pkh:eip155:\d+:)([^:]+)(:.+)$/;
const PRINCIPAL_DID = /^(did:pkh:eip155:\d+:)([^:]+)$/;

/**
 * Pure canonicalization: lower-cases only EIP-155 address segments and preserves all other
 * space/principal bytes. Rejects non-HTTP(S) hosts, credentials, query/fragment, and non-full
 * TinyCloud space ids or non-pkh principals.
 */
export function canonicalReplicationIdentity(
  raw: ReplicationIdentity,
): ReplicationIdentity {
  if (
    !raw ||
    typeof raw.host !== "string" ||
    typeof raw.space !== "string" ||
    typeof raw.principal !== "string"
  ) {
    throw new TypeError(
      "Replication identity host, space, and principal must be strings",
    );
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(raw.host)?.[1];
  let url: URL;
  try {
    url = new URL(raw.host);
  } catch {
    throw new TypeError(
      "Replication identity host must be an absolute HTTP(S) URL",
    );
  }
  if (
    !authority ||
    authority.includes("@") ||
    raw.host.includes("?") ||
    raw.host.includes("#") ||
    url.username ||
    url.password
  ) {
    throw new TypeError(
      "Replication identity host must be HTTP(S) without credentials, query, or fragment",
    );
  }
  const space = SPACE_ID.exec(raw.space);
  const principal = PRINCIPAL_DID.exec(raw.principal);
  if (!space || !principal) {
    throw new TypeError(
      "Replication identity requires a full TinyCloud space id and a pkh principal DID",
    );
  }
  return {
    host: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    space: `${space[1]}${space[2]!.toLowerCase()}${space[3]}`,
    principal: `${principal[1]}${principal[2]!.toLowerCase()}`,
  };
}

/** Stable in-memory key; durable adapters hash its UTF-8 bytes with their platform crypto. */
export function replicationIdentityKey(id: ReplicationIdentity): string {
  const canonical = canonicalReplicationIdentity(id);
  return `tc-replication/v1\n${canonical.host}\n${canonical.space}\n${canonical.principal}`;
}
