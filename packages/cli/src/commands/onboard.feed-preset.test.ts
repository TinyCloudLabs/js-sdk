import { expect, test } from "bun:test";
import { feedResourceNames } from "@tinycloud/sdk-services/feed";
import { FEED_PREFIX, FEED_REGISTRY } from "../feed/resources.js";
import { onboardSteps, ONBOARD_STEPS } from "./onboard.js";

const [step, ...rest] = onboardSteps("feed");

// How the node matches a path: an entry ending in `/` covers everything under it; otherwise the path must be exact.
const covers = (service: string, action: string, path: string) =>
  step!.permissions.some((entry) => entry.service === service && entry.actions.includes(action) &&
    (entry.path === path || (entry.path.endsWith("/") && path.startsWith(entry.path))));

const resources = feedResourceNames(FEED_PREFIX, "demo-agent");
if (!resources.ok) throw new Error("feed resource names");
const { outputResource, responseResource } = resources.data;

test("the feed preset is one approval, in the one space OpenKey can sign it in", () => {
  expect(rest).toEqual([]);
  expect(step!.space).toBe("applications");
  expect(step!.permissions.every((entry) => entry.space === "applications")).toBe(true);
});

test("it covers everything feed connect and feed watch use for an agent", () => {
  for (const database of [FEED_REGISTRY, outputResource, responseResource]) {
    for (const action of ["read", "write", "schema"]) expect(covers("tinycloud.sql", `tinycloud.sql/${action}`, database)).toBe(true);
  }
  // The webhook that wakes the agent is on the response database; connect also lists and replaces its own.
  for (const action of ["register", "subscribe", "list", "unregister"]) {
    expect(covers("tinycloud.hooks", `tinycloud.hooks/${action}`, `sql/${responseResource}`)).toBe(true);
  }
});

test("it grants no files, no other database, no neighbouring name, and no admin or delete", () => {
  expect(step!.permissions.some((entry) => entry.service === "tinycloud.kv")).toBe(false);
  for (const other of [
    "xyz.tinycloud.sample.healthlog/healthlog", // another app's database
    "xyz.tinycloud.tinychat/feed_x", // the namespace without its slash
    "xyz.tinycloud.tinychat/home_feed2", // the registry is exact, not a prefix
    "xyz.tinycloud.tinychat/other",
  ]) {
    for (const action of ["read", "write", "schema"]) expect(covers("tinycloud.sql", `tinycloud.sql/${action}`, other)).toBe(false);
  }
  expect(covers("tinycloud.hooks", "tinycloud.hooks/register", "sql/xyz.tinycloud.sample.healthlog/healthlog")).toBe(false);
  expect(covers("tinycloud.sql", "tinycloud.sql/admin", outputResource)).toBe(false);
  expect(step!.permissions.flatMap((entry) => entry.actions).some((action) => action.endsWith("/*") || action.endsWith("/del"))).toBe(false);
});

test("it asks for less than the default onboarding on the same space, and an unknown preset is refused before anything runs", () => {
  const defaults = ONBOARD_STEPS.find((entry) => entry.space === "applications")!;
  expect(defaults.permissions.some((entry) => entry.path === "")).toBe(true);
  expect(step!.permissions.some((entry) => entry.path === "")).toBe(false);
  expect(() => onboardSteps("everything")).toThrow(/Unknown --preset/);
  expect(onboardSteps(undefined)).toBe(ONBOARD_STEPS);
});

test("its approval lasts 7 days, the agent-preset lifetime, and the default onboarding keeps its own", () => {
  expect(step!.expiry).toBe("7d");
  expect(step!.asks).toContain("7 days");
  expect(ONBOARD_STEPS.every((entry) => entry.expiry === undefined)).toBe(true);
});
