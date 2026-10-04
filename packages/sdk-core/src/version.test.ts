import { describe, expect, it } from "bun:test";
import { authorizationVerdictOf } from "@tinycloud/sdk-services";
import { checkNodeInfo, VersionCheckError } from "./version";

const HTTP_FAILURES = [
  [401, "", "unauthenticated"],
  [401, "Forbidden", "unauthenticated"],
  [401, "Unauthorized Action: host", "unauthenticated"],
  [401, "session expired", "unauthenticated"],
  [403, "", "forbidden"],
  [403, "Forbidden", "forbidden"],
  [403, "Unauthorized Action: host", "forbidden"],
  [403, "session expired", "forbidden"],
  [404, "session expired", "other"],
  [408, "Forbidden", "other"],
  [429, "Unauthorized Action: host", "other"],
  [500, "session expired", "other"],
] as const;

describe("checkNodeInfo HTTP failures", () => {
  it("preserves the version error and classifies HTTP status rather than body text", async () => {
    const host = "https://node.example";
    for (const [status, body, verdict] of HTTP_FAILURES) {
      const fetchFn = (async () => new Response(body, { status })) as unknown as typeof fetch;
      const error: unknown = await checkNodeInfo(host, 1, fetchFn)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(VersionCheckError);
      expect(error).toMatchObject({
        message: `Failed to fetch node info at ${host}. Ensure the node is running and the /info endpoint is accessible.`,
        cause: { status },
      });
      if (body) expect((error as VersionCheckError).cause?.message).toContain(body);
      expect(authorizationVerdictOf(error)).toBe(verdict);
    }
  });
});
