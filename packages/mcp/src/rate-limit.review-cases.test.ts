import { describe, expect, test } from "bun:test";

import {
  createRateLimits,
  DEFAULT_RATE_LIMITS,
  refuseAuthenticated,
  refuseTool,
} from "./rate-limit.js";

// The default limits must not trip the eight OpenAI review cases (P01-P05, N01-N03). Tool calls per case
// follow packages/mcp/plugin/review-evidence.json, rounded up; each tool call is charged six authenticated
// /mcp requests (initialize, initialized, tools/list, the call, and slack for a token refresh).
const REQUESTS_PER_CALL = 6;

type Tool = "tinycloud_connect" | "tinycloud_apps_context" | "tinycloud_apps_read" | "tinycloud_apps_write" | "tinycloud_apps_query";
const call = (name: Tool, times = 1): Tool[] => Array.from({ length: times }, () => name);

const CASES: Record<string, Tool[]> = {
  P01: [...call("tinycloud_connect"), ...call("tinycloud_apps_context", 2), ...call("tinycloud_apps_read", 3)],
  P02: [...call("tinycloud_connect"), ...call("tinycloud_apps_context"), ...call("tinycloud_apps_write"), ...call("tinycloud_apps_read", 2)],
  P03: [...call("tinycloud_connect"), ...call("tinycloud_apps_context"), ...call("tinycloud_apps_read", 2), ...call("tinycloud_apps_write"), ...call("tinycloud_apps_read", 2)],
  P04: [...call("tinycloud_connect"), ...call("tinycloud_apps_context"), ...call("tinycloud_apps_write"), ...call("tinycloud_apps_read", 3)],
  P05: [...call("tinycloud_connect"), ...call("tinycloud_apps_context"), ...call("tinycloud_apps_query", 3), ...call("tinycloud_apps_write", 2)],
  N01: [...call("tinycloud_connect"), ...call("tinycloud_apps_context")],
  N02: [...call("tinycloud_connect"), ...call("tinycloud_apps_read")],
  N03: call("tinycloud_connect"),
};

function replay(secondsBetweenCalls: number) {
  let now = 1_000_000;
  const limits = createRateLimits({ ...DEFAULT_RATE_LIMITS, now: () => now });
  const refused: string[] = [];
  let calls = 0;
  for (const [id, tools] of Object.entries(CASES)) {
    for (const tool of tools) {
      calls += 1;
      for (let request = 0; request < REQUESTS_PER_CALL; request += 1) {
        if (refuseAuthenticated(limits, "chatgpt", "review-account") !== undefined) refused.push(`${id} ${tool} request`);
      }
      if (refuseTool(limits, "review-account", tool, tool === "tinycloud_apps_write") !== undefined) refused.push(`${id} ${tool}`);
      now += secondsBetweenCalls * 1000;
    }
  }
  return { refused, calls };
}

describe("default rate limits against the eight review cases", () => {
  test("one reviewer running all eight cases back to back, a call every 3 seconds, is never refused", () => {
    const { refused, calls } = replay(3);
    expect(calls).toBeGreaterThan(30);
    expect(refused).toEqual([]);
  });

  // The subject ceiling (240 requests a minute) is the binding one: at six requests a call it allows a call
  // about every 1.5 seconds sustained. A model-driven chat turn takes longer than that.
  test("a call every 2 seconds still passes; faster than 1.5 seconds sustained, and a tight loop, do not (the limit is live)", () => {
    expect(replay(2).refused).toEqual([]);
    expect(replay(1).refused.length).toBeGreaterThan(0);
    expect(replay(0).refused.length).toBeGreaterThan(0);
  });
});
