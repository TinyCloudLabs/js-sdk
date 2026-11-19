import { expect, test } from "bun:test";
import { onboardingPlan } from "./onboarding-scope.js";

test("combined approval text names apps, the Feed and discovery for every normalized spelling", () => {
  const canonical = onboardingPlan("apps,feed");
  expect(canonical.asks).toBe("Set up TinyCloud on this computer: use your apps and your Feed, and see your spaces and apps, for 30 days.");
  for (const selector of ["feed,apps", " apps , feed ", " feed , apps ", "feed,apps,feed"]) {
    expect(onboardingPlan(selector)).toEqual(canonical);
  }
});

test("default apps and feed-only approval text and scopes retain their behavior", () => {
  expect(onboardingPlan()).toEqual(onboardingPlan("apps"));
  expect(onboardingPlan().asks).toBe("Set up TinyCloud on this computer: use your apps and see your spaces, for 30 days.");
  const feed = onboardingPlan("feed");
  expect(feed.asks).toBe("Set up TinyCloud on this computer: use your Feed and see your spaces and apps, for 30 days.");
  expect(onboardingPlan(" feed ")).toEqual(feed);
  expect(feed.permissions.some(p => p.space === "applications" && p.path === "" && p.service !== "tinycloud.capabilities")).toBe(false);
});
