import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { kvSpaceProbe } from "../auth/space-setup.js";
import type { ProfileSessionRestore } from "../lib/sdk.js";
import { ONBOARD_STEPS, onboardPlan } from "./onboard.js";

describe("onboard --for feed", () => {
  test("asks one approval for the feed set only: no kv, no account space, no whole-space sql", () => {
    const plan = onboardPlan("feed", undefined);
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step!.space).toBe("applications");
    expect(step!.permissions.map(({ service, space, path, actions }) => [service, space, path, actions])).toEqual([
      ["tinycloud.sql", "applications", "xyz.tinycloud.tinychat/home_feed", ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]],
      ["tinycloud.sql", "applications", "xyz.tinycloud.tinychat/feed/", ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]],
      ["tinycloud.hooks", "applications", "sql/xyz.tinycloud.tinychat/feed/", ["tinycloud.hooks/subscribe"]],
    ]);
    expect(plan.steps.some((entry) => entry.space === "account")).toBe(false);
  });

  test("lasts 7 days unless --expiry says otherwise, and says so in the owner's words", () => {
    expect(onboardPlan("feed", undefined)).toMatchObject({ expiry: "7d" });
    expect(onboardPlan("feed", undefined).steps[0]!.asks).toContain("for 7 days.");
    expect(onboardPlan("feed", "12h")).toMatchObject({ expiry: "12h" });
    expect(onboardPlan("feed", "12h").steps[0]!.asks).toContain("for 12 hours.");
    expect(onboardPlan("feed", "1d").steps[0]!.asks).toContain("for 1 day.");
    expect(onboardPlan("feed", "2w")).toMatchObject({ expiry: "2w" });
    expect(onboardPlan("feed", "30d")).toMatchObject({ expiry: "30d" });
  });

  test("a lifetime over OpenKey's 30 days, or not a number and a unit, is refused before anything is created", () => {
    for (const bad of ["31d", "5w", "721h", "0d", "-1d", "7", "d", "1.5d", "tomorrow", "2026-12-01", ""]) {
      expect(() => onboardPlan("feed", bad)).toThrow(/--expiry/);
    }
    expect(() => onboardPlan(undefined, "31d")).toThrow(/at most 30 days/);
  });

  test("a goal other than feed is refused and names the one that exists", () => {
    expect(() => onboardPlan("everything", undefined)).toThrow(/takes "feed"/);
  });
});

describe("onboard without --for", () => {
  test("asks for the starting grant, both spaces, for 30 days, exactly as before", () => {
    const plan = onboardPlan(undefined, undefined);
    expect(plan.expiry).toBe("30d");
    expect(plan.steps).toEqual([...ONBOARD_STEPS]);
  });

  test("--expiry changes the lifetime in each step's words", () => {
    const plan = onboardPlan(undefined, "7d");
    expect(plan.expiry).toBe("7d");
    expect(plan.steps.map((step) => step.asks)).toEqual([
      "Read, change and delete your apps' data for 7 days.",
      "See which spaces and apps you have, read-only, for 7 days.",
    ]);
    expect(plan.steps.map((step) => step.permissions)).toEqual(ONBOARD_STEPS.map((step) => step.permissions));
  });
});

describe("the space-setup wait with a sql-only first approval", () => {
  const feed = onboardPlan("feed", undefined).steps[0]!.permissions as PermissionEntry[];
  const answering = (reply: unknown): (() => Promise<ProfileSessionRestore>) => async () => ({
    node: { sql: { db: () => ({ query: async () => reply }) }, kv: { list: async () => { throw new Error("kv must not be read"); }, get: async () => { throw new Error("kv must not be read"); } } },
  }) as unknown as ProfileSessionRestore;
  const failure = (status: number, message: string, code = "SQL_ERROR") => ({ ok: false, error: { code, message, meta: { status } } });

  test("reads the registry database to learn whether the space is hosted", async () => {
    const probe = (reply: unknown) => kvSpaceProbe({ profile: "p", host: "http://127.0.0.1:1" }, feed, answering(reply))();
    expect(await probe({ ok: true, data: { rows: [[1]] } })).toBe("hosted");
    expect(await probe(failure(404, "Space not found"))).toBe("unhosted");
    expect(await probe(failure(404, "database not found"))).toBe("hosted");
    expect(await probe(failure(403, "Unauthorized Action"))).toBe("unreadable");
    expect(await probe(failure(500, "boom"))).toBe("transient");
  });

  test("a grant with no database it can name (prefix only) is not probed", async () => {
    const prefixOnly = feed.filter((permission) => permission.path.endsWith("/"));
    expect(await kvSpaceProbe({ profile: "p", host: "http://127.0.0.1:1" }, prefixOnly, answering({ ok: true }))()).toBe("unreadable");
  });
});
