import { ArtifactError } from "@tinycloud/share-sdk/artifact";
import { SharePublishAuthorityError } from "./errors.js";

/**
 * A node with no row for the space answers a write with `404 - Space not
 * found`. A write never reports a missing key, so this is the only 404 a
 * share upload gets. Other 404s (an unknown share, a missing key on a read)
 * do not match and keep their own mapping.
 */
export function isSpaceNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (!/space not found/i.test(message)) return false;
  const meta = "meta" in error && typeof error.meta === "object" && error.meta !== null ? error.meta : undefined;
  const status = meta !== undefined && "status" in meta ? meta.status : undefined;
  return status === 404 || /\b404\b/.test(message);
}

/** The typed failure for a share upload the node answered 404 Space not found. The node's error rides on `cause`. */
export function spaceNotReadyFailure(cause: unknown): SharePublishAuthorityError {
  return new SharePublishAuthorityError({ kind: "space-not-ready" }, { cause });
}

/** Throw {@link spaceNotReadyFailure} when a KV write result is the space-not-found 404; otherwise do nothing. */
export function failIfSpaceNotReady(result: { readonly ok: boolean; readonly error?: unknown }): void {
  if (!result.ok && isSpaceNotFound(result.error)) throw spaceNotReadyFailure(result.error);
}

/** An artifact store failure whose cause is the space-not-found 404, as the typed failure; any other error is returned as is. */
export function artifactSpaceNotReady(error: unknown): unknown {
  return error instanceof ArtifactError && isSpaceNotFound(error.cause) ? spaceNotReadyFailure(error.cause) : error;
}
