import { expect, test } from "bun:test";
import { onboardingPermissions } from "./onboarding-scope.js";

// The owner's master card.md is a table in this database; only the owner's web session may write it.
const CARD_MD_DATABASE = "xyz.tinycloud.tinychat/threads";

/** A SQL permission path is a whole name, or a prefix when it ends in "/" (empty: every database). */
const coversDatabase = (path: string, database: string) => path === "" || (path.endsWith("/") ? database.startsWith(path) : path === database);

test("the Feed-only onboarding grant covers no permission on the database that holds the owner's card.md", () => {
  const sqlEntries = onboardingPermissions("feed").filter((entry) => entry.service === "tinycloud.sql");
  expect(sqlEntries.length).toBeGreaterThan(0);
  expect(sqlEntries.filter((entry) => coversDatabase(entry.path, CARD_MD_DATABASE))).toEqual([]);
});
