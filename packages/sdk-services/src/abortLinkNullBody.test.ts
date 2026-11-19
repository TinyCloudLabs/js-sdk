/**
 * TC-2427: browsers give a 204/205/304 response a body object, but a Response cannot be built over one
 * ("Response with null body status cannot have body"). `releaseWithBody` must release at once and return the
 * response itself for those statuses. Node-runnable (node:test); Bun runs it through `bun test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { releaseWithBody } from "./abortLink";

/** A response the way a browser reports it: a null-body status with a (empty) body stream. */
class BrowserResponse extends Response {
  constructor(status: number) {
    super(null, { status });
  }
  get body(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  }
}

describe("releaseWithBody with a null-body status", () => {
  for (const status of [204, 205, 304]) {
    test(`${status} releases at once and returns the response itself`, () => {
      let released = 0;
      const response = new BrowserResponse(status);
      const result = releaseWithBody(response, () => void (released += 1));
      assert.equal(result, response);
      assert.equal(released, 1);
    });
  }
});
