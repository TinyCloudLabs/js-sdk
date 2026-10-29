import { expect, test } from "bun:test";
import { feedResourceNames } from "./index";
import { unwrap } from "./sqlite.test-helper";

test("per-agent SQL resources have distinct final path segments and preserve full authorization paths", () => {
  const first = unwrap(feedResourceNames("xyz.tinycloud.tinychat", "agent_one"));
  const second = unwrap(feedResourceNames("xyz.tinycloud.tinychat", "agent_two"));
  expect(first).toEqual({
    outputResource: "xyz.tinycloud.tinychat/feed_output_agent_one",
    responseResource: "xyz.tinycloud.tinychat/feed_responses_agent_one",
  });
  const basenames = [first.outputResource, first.responseResource, second.outputResource, second.responseResource]
    .map((resource) => resource.split("/").at(-1));
  expect(new Set(basenames).size).toBe(4);
});

test("resource naming refuses path-like agent tokens rather than collapsing identities", () => {
  for (const token of ["", "a/b", "../agent", "agent%2Fone", " agent", "agent.one"]) {
    expect(feedResourceNames("xyz.tinycloud.tinychat", token).ok).toBe(false);
  }
});
