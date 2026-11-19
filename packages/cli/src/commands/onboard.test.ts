import { expect, test } from "bun:test";

import { ONBOARD_STEPS } from "./onboard.js";

const applications = ONBOARD_STEPS.find((step) => step.space === "applications")!;

// Whether a requested entry covers `action` on `path` (an empty entry path covers the whole space).
const covers = (step: typeof applications, service: string, action: string, path: string) =>
  step.permissions.some((entry) => entry.service === service && entry.actions.includes(action) && path.startsWith(entry.path));

test("the applications approval lets Health Log read and write its database, in one approval with kv", () => {
  const healthDb = "xyz.tinycloud.sample.healthlog/healthlog";
  expect(covers(applications, "tinycloud.sql", "tinycloud.sql/write", healthDb)).toBe(true);
  expect(covers(applications, "tinycloud.sql", "tinycloud.sql/read", healthDb)).toBe(true);
  expect(covers(applications, "tinycloud.kv", "tinycloud.kv/put", "xyz.tinycloud.sample.healthlog/prefs/x")).toBe(true);
  expect(applications.permissions.every((entry) => entry.space === "applications")).toBe(true);
});
