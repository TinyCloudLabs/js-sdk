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
