import { expect, test } from "bun:test";
import { projectDiagnosticData } from "./diagnostics";

test("replication diagnostic projection retains approved scalars and drops identifying values", () => {
  expect(projectDiagnosticData({
    type: "replication.read",
    reason: "NETWORK_REQUESTED",
    source: "network",
    latencyMs: 12,
    stalenessMs: 24,
    key: "notes/private",
    etag: "secret-etag",
    localEtag: "local-etag",
    unknownReason: "NOT_AN_ENUM",
  })).toEqual({ reason: "NETWORK_REQUESTED", source: "network", latencyMs: 12, stalenessMs: 24 });
});

test("consent-expiry denial remains observable without account identifiers", () => {
  expect(projectDiagnosticData({
    type: "replication.lifecycle",
    action: "denied",
    reason: "consent_expired",
    replicaId: "opaque-partition",
    principal: "did:example:private",
    space: "private-space",
    prefix: "notes/private/",
  })).toEqual({ action: "denied", reason: "consent_expired" });
});
