import { expect, test } from "bun:test";
import {
  diagnosticEventSelected,
  diagnosticId,
  encodeDiagnosticEvent,
  projectDiagnosticObservation,
  validateDiagnosticDescriptor,
  validateDiagnosticEvent,
  validateDiagnosticSelection,
  type DiagnosticEvent,
} from "./model.js";
import { decodeDiagnosticContext, encodeDiagnosticContext, type DiagnosticEnvironmentContext } from "./context.js";

const event: DiagnosticEvent = {
  schema_version: 1, type: "attempt.finish", event_id: diagnosticId(), source_id: diagnosticId(),
  process_id: diagnosticId(), partition_id: diagnosticId(), invocation_id: diagnosticId(), sequence: 1,
  occurred_at: "2026-10-15T12:00:00.000Z", source: "cli", service: "kv", action: "put", layer: "transport",
  attempt_id: diagnosticId(), outcome: "error", mutation: "unknown", duration_ms: 12.5, timing_scope: "transport",
};

test("metadata refuses content-bearing additions instead of serializing or redacting business objects", () => {
  for (const addition of [
    { key: "xyz.tinycloud.agent-data/private-canary" },
    { error: { message: "credential-canary" } },
    { sql: "SELECT secret_canary" },
    { activity: "custom-tool-credential-canary" },
    { warning: "field-private-canary" },
    { attempt_id: "Bearer private-token-canary" },
    { duration_ms: Infinity },
    { bytes: -1 },
  ]) {
    expect(encodeDiagnosticEvent({ ...event, ...addition })).toBeUndefined();
  }
  expect(JSON.parse(encodeDiagnosticEvent(event)!)).toMatchObject({ mutation: "unknown", outcome: "error", duration_ms: 12.5 });
});

test("getters and custom serializers are never invoked at the privacy boundary", () => {
  let accessed = false;
  const getter = Object.defineProperty({ type: "invocation.finish" }, "business", {
    enumerable: true, get() { accessed = true; return "complete"; },
  });
  const serializer = { ...event, toJSON() { accessed = true; return event; } };
  expect(projectDiagnosticObservation(getter)).toBeUndefined();
  expect(encodeDiagnosticEvent(serializer)).toBeUndefined();
  expect(accessed).toBe(false);
});

test("prototype tricks, invalid identity and impossible timestamps are rejected on import", () => {
  expect(validateDiagnosticEvent(Object.assign(Object.create({ credential: "canary" }), event))).toBeUndefined();
  for (const replacement of [
    { schema_version: 2 }, { sequence: 0 }, { sequence: 1.1 },
    { partition_id: "../../other-owner" }, { occurred_at: "2026-02-30T12:00:00.000Z" },
    { source: "owner-controlled-source" },
  ]) expect(validateDiagnosticEvent({ ...event, ...replacement })).toBeUndefined();
});

test("metadata selection is explicit and a selected case cannot accidentally admit every event", () => {
  expect(validateDiagnosticSelection({})).toBeUndefined();
  expect(validateDiagnosticSelection({ all: false })).toBeUndefined();
  expect(validateDiagnosticSelection({ event_ids: [] })).toBeUndefined();
  expect(validateDiagnosticSelection({ event_ids: [event.event_id], path: "../canary" })).toBeUndefined();
  expect(validateDiagnosticSelection({ from: "2026-10-16T00:00:00.000Z", until: "2026-10-15T00:00:00.000Z" })).toBeUndefined();
  const caseOnly = validateDiagnosticSelection({ case_ids: [diagnosticId()], include_detail: true })!;
  expect(diagnosticEventSelected(event, caseOnly)).toBe(false);
  expect(diagnosticEventSelected(event, { event_ids: [event.event_id], source_ids: [diagnosticId()] })).toBe(false);
  expect(diagnosticEventSelected(event, { event_ids: [event.event_id], source_ids: [event.source_id] })).toBe(true);
});

test("environment context links cannot carry authority, storage paths or arbitrary client identity", () => {
  const run_id = diagnosticId();
  const valid = { version: 1, run_id, scope: "tc-apps", role: "copy",
    adapter: "opencode_v1", adapter_revision: 1, client_version: "1.18.31" } as const;
  expect(decodeDiagnosticContext(encodeDiagnosticContext(valid))).toEqual(valid);
  for (const addition of [
    { enabled: true }, { partition_id: diagnosticId() }, { root: "/private-canary" },
    { token: "secret-canary" }, { model: "arbitrary-canary" }, { task_id: "not-an-opaque-id" },
    { child_ordinal: 4 },
    { adapter: "constructor" }, { adapter: "unsupported-client" }, { adapter_revision: 2 },
    { adapter: undefined }, { client_version: "1.2.3-secret-canary" },
    { client_version: "123456.1.1" }, { client_trust: "observed" },
  ]) expect(decodeDiagnosticContext(JSON.stringify({ ...valid, ...addition }))).toBeUndefined();
  expect(decodeDiagnosticContext(" ".repeat(2049))).toBeUndefined();
});

test("environment encoding validates before consulting nested serialization", () => {
  let serialized = false;
  const hostile = {
    version: 1,
    run_id: { toJSON() { serialized = true; return diagnosticId(); } },
  } as unknown as DiagnosticEnvironmentContext;
  expect(encodeDiagnosticContext(hostile)).toBeUndefined();
  expect(serialized).toBe(false);
});

test("descriptors preserve independent code revisions but reject arbitrary model and path strings", () => {
  const descriptor = {
    descriptor_id: diagnosticId(), source: "cli", package: "@tinycloud/cli", version: "1.2.3-beta.2",
    wrapper_revision: "abcdef0123456789", skill_revision: "0.10.0", adapter: "codex",
    adapter_revision: 1, client_version: "0.160.0", client_trust: "observed",
  };
  expect(validateDiagnosticDescriptor(descriptor)).toMatchObject({ version: "1.2.3-beta.2", skill_revision: "0.10.0", client_version: "0.160.0" });
  expect(validateDiagnosticDescriptor({ ...descriptor, model: "credential-canary" })).toBeUndefined();
  expect(validateDiagnosticDescriptor({ ...descriptor, build_hash: "/home/private-canary" })).toBeUndefined();
  expect(validateDiagnosticDescriptor({ ...descriptor, package: "@private-canary/unknown" })).toBeUndefined();
});
