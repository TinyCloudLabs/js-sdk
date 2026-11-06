import { expect, test } from "bun:test";
import { onboardingPlan } from "./onboarding-scope.js";

test("combined approval text names apps, Home/feed and discovery for every normalized spelling", () => {
  const canonical = onboardingPlan("apps,feed");
  expect(canonical.asks).toBe("Use your apps, Home and your feed, and discover your spaces and apps, for 30 days.");
  for (const selector of ["feed,apps", " apps , feed ", " feed , apps ", "feed,apps,feed"]) {
    expect(onboardingPlan(selector)).toEqual(canonical);
  }
});

test("default apps and feed-only approval text and scopes retain their behavior", () => {
  expect(onboardingPlan()).toEqual(onboardingPlan("apps"));
  expect(onboardingPlan().asks).toBe("Use the requested apps and discover your spaces, for 30 days.");
  const feed = onboardingPlan("feed");
  expect(feed.asks).toBe("Use Home and your feed, and discover your spaces and apps, for 30 days.");
  expect(onboardingPlan(" feed ")).toEqual(feed);
  expect(feed.permissions.some(p => p.space === "applications" && p.path === "" && p.service !== "tinycloud.capabilities")).toBe(false);
});
