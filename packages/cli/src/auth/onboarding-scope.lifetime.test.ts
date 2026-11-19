import { describe, expect, test } from "bun:test";
import { onboardingPlan } from "./onboarding-scope.js";

describe("onboard --with feed", () => {
  test("asks for the Feed's databases and answer notifications only: no account listing, no kv, no whole-space sql", () => {
    const { permissions } = onboardingPlan("feed");
    expect(permissions.map(({ service, space, path, actions }) => [service, space, path, actions])).toEqual([
      ["tinycloud.sql", "applications", "xyz.tinycloud.tinychat/feed/", ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]],
      ["tinycloud.sql", "applications", "xyz.tinycloud.tinychat/home_feed", ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]],
      ["tinycloud.hooks", "applications", "sql/xyz.tinycloud.tinychat/feed/", ["tinycloud.hooks/subscribe"]],
    ].sort((a, b) => `${a[1]}\0${a[0]}\0${a[2]}`.localeCompare(`${b[1]}\0${b[0]}\0${b[2]}`)));
    expect(permissions.some(p => p.space === "account")).toBe(false);
    expect(permissions.some(p => p.service === "tinycloud.kv")).toBe(false);
  });

  test("lasts 7 days unless --expiry says otherwise, and says so in the owner's words", () => {
    expect(onboardingPlan("feed")).toMatchObject({ expiry: "7d", asks: "Set up TinyCloud on this computer: use your Feed, for 7 days." });
    expect(onboardingPlan("feed", "12h")).toMatchObject({ expiry: "12h", asks: "Set up TinyCloud on this computer: use your Feed, for 12 hours." });
    expect(onboardingPlan("feed", "1d").asks).toBe("Set up TinyCloud on this computer: use your Feed, for 1 day.");
    expect(onboardingPlan("feed", "2w")).toMatchObject({ expiry: "2w" });
    expect(onboardingPlan("feed", "30d")).toMatchObject({ expiry: "30d" });
  });
});

describe("the other selections keep the account listing", () => {
  test("apps lasts 30 days; apps,feed lasts 7 days like the Feed alone", () => {
    const apps = onboardingPlan("apps");
    expect(apps).toMatchObject({ expiry: "30d", asks: "Set up TinyCloud on this computer: use your apps and see your spaces, for 30 days." });
    for (const selector of ["apps,feed", "feed,apps"]) {
      expect(onboardingPlan(selector)).toMatchObject({ expiry: "7d", asks: "Set up TinyCloud on this computer: use your apps and your Feed, and see your spaces and apps, for 7 days." });
    }
    for (const selector of ["apps", "apps,feed", "feed,apps"]) {
      expect(onboardingPlan(selector).permissions.some(p => p.space === "account" && p.path === "spaces/")).toBe(true);
    }
  });

  test("--expiry changes the lifetime in the approval line for every selection, up to 30 days", () => {
    expect(onboardingPlan("apps", "7d")).toMatchObject({ expiry: "7d", asks: "Set up TinyCloud on this computer: use your apps and see your spaces, for 7 days." });
    expect(onboardingPlan("apps,feed", "30d")).toMatchObject({ expiry: "30d", asks: "Set up TinyCloud on this computer: use your apps and your Feed, and see your spaces and apps, for 30 days." });
  });
});

describe("--expiry is checked before anything is created", () => {
  test("a lifetime over OpenKey's 30 days, or not a number and a unit, is refused", () => {
    for (const bad of ["31d", "5w", "721h", "0d", "-1d", "7", "d", "1.5d", "tomorrow", "2026-12-01", ""]) {
      expect(() => onboardingPlan("feed", bad)).toThrow(/--expiry/);
    }
    expect(() => onboardingPlan("apps", "31d")).toThrow("--expiry can be at most 30 days (30d), the longest an OpenKey approval lasts.");
    expect(() => onboardingPlan("apps", "tomorrow")).toThrow(/--expiry takes a number and a unit/);
  });
});
