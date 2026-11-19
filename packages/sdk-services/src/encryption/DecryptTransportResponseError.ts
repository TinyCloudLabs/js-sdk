import type { PermissionHint } from "../types";

/** A reachable node returned an HTTP failure for a decrypt request. */
export class DecryptTransportResponseError extends Error {
  constructor(
    readonly status: number,
    readonly permissionHint?: PermissionHint,
    /** Caller-supplied advice for a 404 on the owner's own network. */
    readonly notFoundMessage?: string,
  ) {
    super("Node decrypt request failed");
    this.name = "DecryptTransportResponseError";
  }
}
