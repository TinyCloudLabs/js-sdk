export const LINK_TYPES = ["openkey-login", "courier", "share"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/**
 * The one limit on a sealed body, in bytes, for every link type: a stored
 * record, a full link and a read all obey it.
 */
export const MAX_LINK_BODY_BYTES = 65_536;

/**
 * The largest create request, in bytes: the body in base64url plus room for the
 * header and signature. A full link carries the same record.
 */
export const MAX_LINK_REQUEST_BYTES = Math.ceil((MAX_LINK_BODY_BYTES * 4) / 3) + 3072;

export interface LinkTypeSpec {
  /** Largest `expiresAt - issuedAt`, in seconds. */
  readonly maxLifeSeconds: number;
  readonly defaultLifeSeconds: number;
  /** Path letter of the short link. */
  readonly pathLetter: "l" | "c" | "s";
  /** Read once, by an explicit `take`. */
  readonly readOnce: boolean;
}

export const LINK_TYPE_SPECS: Readonly<Record<LinkType, LinkTypeSpec>> = {
  "openkey-login": { maxLifeSeconds: 600, defaultLifeSeconds: 600, pathLetter: "l", readOnce: true },
  courier: { maxLifeSeconds: 604_800, defaultLifeSeconds: 86_400, pathLetter: "c", readOnce: false },
  share: { maxLifeSeconds: 2_592_000, defaultLifeSeconds: 2_592_000, pathLetter: "s", readOnce: false },
};

/** Signing domain of a create header. Ends with one NUL byte. */
export const LINK_HEADER_DOMAIN = "xyz.tinycloud.links/header/v1\0";
/** Signing domain of a delete request. Ends with one NUL byte. */
export const LINK_DELETE_DOMAIN = "xyz.tinycloud.links/delete/v1\0";

/** `issuedAt` must be within this many seconds of the service clock. */
export const LINK_WINDOW_SECONDS = 120;
export const LINK_MIN_LIFE_SECONDS = 120;
/** Version byte, nonce, tag and one byte of ciphertext. */
export const LINK_MIN_BODY_BYTES = 30;
/**
 * Bytes a sealed body adds to its plaintext: version byte (1), nonce (12) and
 * tag (16). The sealed size of a plaintext is `length + LINK_SEAL_OVERHEAD_BYTES`,
 * so a publisher can check a plaintext against `MAX_LINK_BODY_BYTES` before it
 * seals.
 */
export const LINK_SEAL_OVERHEAD_BYTES = 29;
/** Largest `X-Link-Record` response header a reader accepts. */
export const LINK_MAX_RECORD_HEADER_BYTES = 2048;

/** Default API origin; a self-hosted deployment supplies its own. */
export const DEFAULT_LINKS_API_ORIGIN = "https://api.tinycloud.xyz";
/** Path of the full form, which carries the whole record in the fragment. */
export const FULL_LINK_PATH = "/s/full";
export const LINK_ID_PATTERN = /^[a-z2-7]{26}$/;
