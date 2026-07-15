/** A reachable node returned an HTTP failure for a decrypt request. */
export class DecryptTransportResponseError extends Error {
  constructor(readonly status: number) {
    super("Node decrypt request failed");
    this.name = "DecryptTransportResponseError";
  }
}
