import { expect, test } from "bun:test";

import { ONBOARD_STEPS } from "./onboard.js";

const applications = ONBOARD_STEPS.find((step) => step.space === "applications")!;
const account = ONBOARD_STEPS.find((step) => step.space === "account")!;

// Whether a requested entry covers `action` on `path` (an empty entry path covers the whole space).
const covers = (step: typeof applications, service: string, action: string, path: string) =>
  step.permissions.some((entry) => entry.service === service && entry.actions.includes(action) && path.startsWith(entry.path));

test("the applications approval lets Health Log read and write its database, in one approval with kv", () => {
  const healthDb = "xyz.tinycloud.sample.healthlog/healthlog";
  expect(covers(applications, "tinycloud.sql", "tinycloud.sql/write", healthDb)).toBe(true);
  expect(covers(applications, "tinycloud.sql", "tinycloud.sql/read", healthDb)).toBe(true);
  expect(covers(applications, "tinycloud.kv", "tinycloud.kv/put", "xyz.tinycloud.sample.healthlog/prefs/x")).toBe(true);
  expect(applications.permissions.every((entry) => entry.space === "applications")).toBe(true);
  // Rows only: no table changes or database admin.
  const sqlActions = applications.permissions.filter((entry) => entry.service === "tinycloud.sql").flatMap((entry) => entry.actions);
  expect(sqlActions.sort()).toEqual(["tinycloud.sql/read", "tinycloud.sql/write"]);
});

test("onboarding stays read-only on the account space and never touches the default space", () => {
  expect(account.permissions.flatMap((entry) => entry.actions).sort()).toEqual([
    "tinycloud.kv/get", "tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/list",
  ]);
  expect(account.permissions.every((entry) => entry.service === "tinycloud.kv" && entry.space === "account")).toBe(true);
  expect(ONBOARD_STEPS.flatMap((step) => step.permissions).some((entry) => entry.space === "default")).toBe(false);
  expect(ONBOARD_STEPS.map((step) => step.space)).toEqual(["applications", "account"]);
});
