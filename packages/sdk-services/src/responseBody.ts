import type { FetchResponse } from "./types";

/** Release a response the SDK owns but does not return to its caller. */
export async function discardResponse(response: FetchResponse): Promise<void> {
  try {
    const body = response.body as { cancel?: () => Promise<void> } | null | undefined;
    if (typeof body?.cancel === "function") await body.cancel();
    else await response.text();
  } catch {
    // Acknowledged writes keep their result if secondary cleanup fails.
  }
}
