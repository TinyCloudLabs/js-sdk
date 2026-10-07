import { expect, test } from "bun:test";

import {
  BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_DEFAULT_ONLY_SESSION_REQUEST,
  BOOTSTRAP_MANIFEST,
  BOOTSTRAP_SESSION_REQUESTS,
  BOOTSTRAP_SPACE_NAMES,
  ACCOUNT_MANIFEST_PERMISSIONS,
  TINYCLOUD_AGENTS_SPACE_MANIFEST,
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  bootstrapSteps,
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_MANIFEST_SPACE,
  SECRETS_SPACE,
} from "./index";

test("@tinycloud/bootstrap re-exports the canonical bootstrap surface", () => {
  expect(BOOTSTRAP_MANIFEST.spaces).toHaveLength(6);
  expect(BOOTSTRAP_ALLOWLIST).toHaveLength(12);
  expect(bootstrapSteps("0x1234567890abcdef1234567890abcdef12345678", 1).length)
    .toBeGreaterThan(10);
});

test("per-space descriptors compose to single-space recaps", () => {
  for (const space of BOOTSTRAP_SPACE_NAMES) {
    const request = BOOTSTRAP_SESSION_REQUESTS[space];
    const spaces = new Set(request.resources.map((resource) => resource.space));

    expect(spaces).toEqual(
      space === "default" ? new Set(["default", ACCOUNT_REGISTRY_SPACE]) : new Set([space]),
    );
    expect(request.registryRecords).toEqual([]);
    expect(
      request.resources.some((resource) => resource.space === ACCOUNT_REGISTRY_SPACE),
    ).toBe(space === ACCOUNT_REGISTRY_SPACE || space === "default");
  }
});

test("default bootstrap request includes the canonical six-row account bundle", () => {
  expect(new Set(BOOTSTRAP_DEFAULT_ONLY_SESSION_REQUEST.resources.map((resource) => resource.space)))
    .toEqual(new Set(["default"]));

  const widened = BOOTSTRAP_SESSION_REQUESTS.default.resources;
  expect(widened.filter((resource) => resource.space === ACCOUNT_REGISTRY_SPACE)).toEqual([
    ...ACCOUNT_MANIFEST_PERMISSIONS,
  ]);
  expect(widened.some((resource) => resource.path === "system/bootstrap/")).toBe(false);
  expect(BOOTSTRAP_DEFAULT_ONLY_SESSION_REQUEST.resources.some(
    (resource) => resource.space === ACCOUNT_REGISTRY_SPACE,
  )).toBe(false);
});

test("allowlist contains bootstrap session and host targets plus account network create", () => {
  const sessionEntries = BOOTSTRAP_ALLOWLIST.filter((entry) => entry.kind === "session");
  const hostEntries = BOOTSTRAP_ALLOWLIST.filter((entry) => entry.kind === "space/host");
  const accountSession = sessionEntries.find(
    (entry) => entry.space === ACCOUNT_REGISTRY_SPACE,
  );

  expect(sessionEntries).toHaveLength(6);
  expect(hostEntries).toHaveLength(6);
  expect(new Set(BOOTSTRAP_ALLOWLIST.map((entry) => entry.space))).toEqual(
    new Set(BOOTSTRAP_SPACE_NAMES),
  );
  expect(accountSession?.rawAbilities).toEqual([
    {
      service: "tinycloud.encryption",
      resource: "urn:tinycloud:encryption:{ownerDid}:default",
      actions: ["tinycloud.encryption/network.create"],
    },
  ]);
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
  const accountSession = steps.find(
    (step) => step.kind === "session" && step.space === ACCOUNT_REGISTRY_SPACE,
  );

  expect(seedSpaces?.kind).toBe("seed-spaces");
  if (seedSpaces?.kind === "seed-spaces") {
    expect(seedSpaces.spaces.map((space) => space.name)).toEqual([
      "default",
      DEFAULT_MANIFEST_SPACE,
      ACCOUNT_REGISTRY_SPACE,
      SECRETS_SPACE,
      "public",
      "agents",
    ]);
  }

  expect(seedApplications?.kind).toBe("seed-applications");
  if (seedApplications?.kind === "seed-applications") {
    expect(seedApplications.manifests.map((manifest) => manifest.app_id)).toEqual([
      "xyz.tinycloud.secrets",
    ]);
  }
  expect(accountSession?.kind).toBe("session");
  if (accountSession?.kind === "session") {
    expect(Object.values(accountSession.rawAbilities ?? {})).toEqual([
      ["tinycloud.encryption/network.create"],
    ]);
  }
});

test("agents bootstrap manifest grants only whole-space KV access", () => {
  expect(BOOTSTRAP_SPACE_NAMES.at(-1)).toBe("agents");
  expect(TINYCLOUD_AGENTS_SPACE_MANIFEST).toMatchObject({
    app_id: "xyz.tinycloud.agents",
    name: "TinyCloud Agents Space",
    space: "agents",
    prefix: "",
    defaults: false,
    includePublicSpace: false,
    permissions: [{
      service: "tinycloud.kv",
      space: "agents",
      path: "",
      actions: ["get", "put", "del", "list", "metadata"],
    }],
  });
  expect(TINYCLOUD_AGENTS_SPACE_MANIFEST.permissions).toHaveLength(1);
});
