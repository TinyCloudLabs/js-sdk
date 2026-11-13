import { expect, test } from "bun:test";
import { ACCOUNT_MANIFEST_PERMISSIONS } from "@tinycloud/bootstrap";
import { composeManifestRequest, resolveManifest, type Manifest } from "./manifest";

const app: Manifest = {
  app_id: "tc2931-notes", name: "One permission notes", defaults: false,
  includePublicSpace: false,
  permissions: [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "put"] }],
};
const ownRows = [{ service: "tinycloud.kv", space: "applications", path: "tc2931-notes/notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }];
const strict = { includeAccountRegistryPermissions: false, includeImplicitCapabilitiesRead: false };

test("a non-bootstrap one-permission manifest resolves and composes to exactly its own row", () => {
  expect(resolveManifest(app, strict).resources).toEqual(ownRows);
  const request = composeManifestRequest([app], strict);
  expect(request.resources).toEqual(ownRows);
  expect(request.registryRecords).toEqual([]);
});

test("explicit capabilities reads survive non-bootstrap composition", () => {
  const request = composeManifestRequest([{ ...app, permissions: [
    ...app.permissions!, { service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"], skipPrefix: true },
  ] }], strict);
  expect(request.resources).toHaveLength(2);
  expect(request.resources.find((entry) => entry.service === "tinycloud.capabilities")?.actions).toEqual(["tinycloud.capabilities/read"]);
});

test("first-party/default composition retains the canonical bootstrap bundle", () => {
  const request = composeManifestRequest([app]);
  for (const permission of ACCOUNT_MANIFEST_PERMISSIONS) expect(request.resources).toContainEqual(permission);
  expect(request.resources).toContainEqual({ service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"] });
  expect(request.registryRecords.map((record) => record.app_id)).toEqual([app.app_id]);
});
