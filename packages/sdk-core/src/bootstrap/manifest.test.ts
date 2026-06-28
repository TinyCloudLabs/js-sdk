import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_MANIFEST_SPACE,
  SECRETS_SPACE,
} from "../manifest";
import {
  BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_SESSION_REQUESTS,
  BOOTSTRAP_SPACE_NAMES,
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  bootstrapSteps,
} from "./manifest";

describe("bootstrap manifest", () => {
  test("per-space descriptors compose to single-space recaps", () => {
    for (const space of BOOTSTRAP_SPACE_NAMES) {
      const request = BOOTSTRAP_SESSION_REQUESTS[space];
      const spaces = new Set(request.resources.map((resource) => resource.space));

      expect(spaces).toEqual(new Set([space]));
      expect(request.registryRecords).toEqual([]);
      expect(request.resources.some((resource) => resource.space === ACCOUNT_REGISTRY_SPACE))
        .toBe(space === ACCOUNT_REGISTRY_SPACE);
    }
  });

  test("allowlist contains five session SIWE targets and five space host targets", () => {
    expect(BOOTSTRAP_ALLOWLIST).toHaveLength(10);
    expect(BOOTSTRAP_ALLOWLIST.filter((entry) => entry.kind === "session"))
      .toHaveLength(5);
    expect(BOOTSTRAP_ALLOWLIST.filter((entry) => entry.kind === "space/host"))
      .toHaveLength(5);
    expect(new Set(BOOTSTRAP_ALLOWLIST.map((entry) => entry.space))).toEqual(
      new Set(BOOTSTRAP_SPACE_NAMES),
    );
  });

  test("secrets grants SQL schema for secret_records", () => {
    const sql = TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST.permissions?.find(
      (permission) =>
        permission.service === "tinycloud.sql" &&
        permission.space === SECRETS_SPACE &&
        permission.path === "default",
    );

    expect(sql?.actions).toContain("schema");
  });

  test("bootstrap steps include public in the seed set and only secrets as an app", () => {
    const steps = bootstrapSteps("0x1234567890abcdef1234567890abcdef12345678", 1);
    const seedSpaces = steps.find((step) => step.kind === "seed-spaces");
    const seedApplications = steps.find((step) => step.kind === "seed-applications");

    expect(seedSpaces?.kind).toBe("seed-spaces");
    if (seedSpaces?.kind === "seed-spaces") {
      expect(seedSpaces.spaces.map((space) => space.name)).toEqual([
        "default",
        DEFAULT_MANIFEST_SPACE,
        ACCOUNT_REGISTRY_SPACE,
        SECRETS_SPACE,
        "public",
      ]);
    }

    expect(seedApplications?.kind).toBe("seed-applications");
    if (seedApplications?.kind === "seed-applications") {
      expect(seedApplications.manifests.map((manifest) => manifest.app_id)).toEqual([
        "xyz.tinycloud.secrets",
      ]);
    }
  });
});
