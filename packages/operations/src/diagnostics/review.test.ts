import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDiagnosticBundle, deduplicateDiagnosticSnapshot, diagnosticTransferChecksum, exportDiagnosticBundle, importDiagnosticBundle, rewriteDiagnosticBundle, type DiagnosticBundleManifest } from "./bundles.js";
import { DiagnosticStore } from "./storage.js";
import { METADATA_RETENTION_MS, type DiagnosticEvent, type DiagnosticSnapshot } from "./model.js";
import { compareDiagnosticReviews, reviewDiagnosticSnapshot, reviewDiagnostics } from "./review.js";
import { rejectDiagnosticCredentials, readDiagnosticJsonFile, selectDiagnosticCase, validateSelectedDiagnosticCase, type SelectedDiagnosticCase } from "./selection.js";
import { bundleDiagnosticCase, diagnosticFixtureRevision, validateDiagnosticFixture, REPRODUCTION_SCRIPT, REPRODUCTION_INSTRUCTIONS } from "./reproduction.js";

const now = Date.now();
const source = randomUUID(), processId = randomUUID(), partition = randomUUID(), invocation = randomUUID();
function event(fields: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return { schema_version: 1, type: "invocation.start", event_id: randomUUID(), source_id: source, process_id: processId, partition_id: partition, invocation_id: invocation, sequence: 1, occurred_at: new Date(now - 60000).toISOString(), source: "cli", ...fields };
}
function snapshot(events: DiagnosticEvent[]): DiagnosticSnapshot { return { events, descriptors: [], gaps: [], conflicts: [] }; }
function bundle(events: DiagnosticEvent[], expiry = now + 3600000): Record<string, Uint8Array> {
  const bytes = Buffer.from(events.map((item) => JSON.stringify(item) + "\n").join(""));
  const times = events.map((item) => item.occurred_at).sort();
  const manifest: DiagnosticBundleManifest = { format: "tinycloud-diagnostics", schema_version: 1, bundle_id: randomUUID(), exported_at: new Date(now - 1000).toISOString(), expires_at: new Date(expiry).toISOString(), destination: "external", trust: "source_observation", integrity: "sha256-transfer-only-not-authenticity", content_tiers: ["metadata"], selection: { source_ids: [...new Set(events.map((item) => item.source_id))] }, source_ids: [...new Set(events.map((item) => item.source_id))], partition_ids: [partition], original_times: { first: times[0] ?? null, last: times.at(-1) ?? null }, descriptors: [], gaps: [], conflicts: [], files: { "events.jsonl": { bytes: bytes.length, sha256: diagnosticTransferChecksum(bytes) } } };
  return { "manifest.json": Buffer.from(JSON.stringify(manifest)), "events.jsonl": bytes };
}
function selected(events: DiagnosticEvent[]): SelectedDiagnosticCase {
  const intent = randomUUID(), observed = randomUUID();
  return { schema_version: 1, case_id: randomUUID(), created_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3600000).toISOString(), purpose: "synthetic_reproduction", owner_selected: true, no_secrets_or_unrelated_content: true, detail_policy: "encrypted-excluded-backups", event_ids: events.map((item) => item.event_id), source_ids: [source], trust: "owner_reported", passages: [
    { id: intent, kind: "intent", origin: "owner", text: "Store 12 U1", event_ids: [events[0]!.event_id], unit: { value: "U1", start: 9, end: 11 } },
    { id: observed, kind: "record_excerpt", origin: "selected_record", text: "Stored 12 U2", event_ids: [events[0]!.event_id], unit: { value: "U2", start: 10, end: 12 } },
  ], feedback: { classification: "wrong_units", passage_ids: [intent, observed] } };
}

test("empty and wholly expired history cannot establish zero work or complete coverage", () => {
  const empty = reviewDiagnosticSnapshot(snapshot([]));
  expect(empty.coverage.gaps).toContain("coverage_unknown");
  expect(empty.invocations).toEqual([]);
  const expired = reviewDiagnosticSnapshot(snapshot([
    event({ occurred_at: new Date(now - METADATA_RETENTION_MS - 1).toISOString() }),
  ]));
  expect(expired.coverage.gaps).toContain("expired_evidence");
  expect(expired.coverage.gaps).toContain("coverage_unknown");
  expect(expired.invocations).toEqual([]);
});

test("source/event duplicates count once; conflicting duplicate is excluded rather than last-write-wins", () => {
  const first = event();
  const duplicate = { ...first };
  expect(deduplicateDiagnosticSnapshot(snapshot([first, duplicate])).events.map((item) => item.event_id)).toEqual([first.event_id]);
  const conflict = { ...first, business: "failed" as const };
  const report = deduplicateDiagnosticSnapshot(snapshot([first, duplicate, conflict]));
  expect(report.events).toEqual([]);
  expect(report.conflicts).toEqual([`${first.source_id}/${first.event_id}`]);
  expect(report.gaps).toContain("conflict");
});

test("partial ordering respects producer sequence despite clock reversal and does not order independent producers", () => {
  const first = event();
  const second = event({ sequence: 2, occurred_at: new Date(now - 120000).toISOString() });
  const independent = event({ process_id: randomUUID(), invocation_id: randomUUID(), occurred_at: new Date(now - 180000).toISOString() });
  const review = reviewDiagnosticSnapshot(snapshot([second, independent, first]));
  expect(review.partial_order.layers[0]).toEqual([`${source}/${first.event_id}`, `${source}/${independent.event_id}`].sort());
  expect(review.partial_order.layers[1]).toEqual([`${source}/${second.event_id}`]);
  expect(review.coverage.gaps).toContain("clock_anomaly");
  expect(review.timeline.every((node) => node.provenance === "unknown")).toBe(true);
  expect(review.invocations.every((item) => item.finish === "unknown" && item.business === "unknown")).toBe(true);
});

test("phase and wrapper-attempt parents order related producers without using wall time", () => {
  const task = randomUUID(), operation = randomUUID(), attempt = randomUUID();
  const start = event({ task_id: task });
  const phase = event({ type: "phase.start", phase: "execution", sequence: 2, task_id: task, operation_id: operation, parent_id: invocation });
  const wrapper = event({ type: "attempt.start", process_id: randomUUID(), task_id: task, attempt_id: attempt, parent_id: operation, layer: "wrapper_child" });
  const child = event({ process_id: randomUUID(), invocation_id: randomUUID(), task_id: task, parent_id: attempt });
  const report = reviewDiagnosticSnapshot(snapshot([child, wrapper, phase, start]));
  expect(report.partial_order.layers).toEqual([start, phase, wrapper, child].map((item) => [`${source}/${item.event_id}`]));
  expect(report.coverage.gaps).not.toContain("linkage_unknown");
});

test("ambiguous phase aliases and another source's aliases never select an arbitrary parent", () => {
  const operation = randomUUID();
  const first = event({ type: "phase.start", operation_id: operation });
  const second = event({ type: "phase.start", operation_id: operation, process_id: randomUUID() });
  const child = event({ type: "attempt.start", attempt_id: randomUUID(), parent_id: operation, process_id: randomUUID() });
  const ambiguous = reviewDiagnosticSnapshot(snapshot([first, second, child]));
  expect(ambiguous.timeline.find((node) => node.event.event_id === child.event_id)!.predecessors).toEqual([]);
  expect(ambiguous.coverage.gaps).toContain("conflict");
  expect(ambiguous.coverage.gaps).toContain("linkage_unknown");
  const separate = reviewDiagnosticSnapshot(snapshot([first, { ...child, source_id: randomUUID() }]));
  expect(separate.timeline.find((node) => node.event.event_id === child.event_id)!.predecessors).toEqual([]);
  expect(separate.coverage.gaps).toContain("linkage_unknown");
});

test("recovered retries retain unknown first mutation, distinguish layers and never sum overlap as wall time", () => {
  const firstAttempt = randomUUID(), recovered = randomUUID();
  const events = [event(), event({ type: "attempt.start", sequence: 2, attempt_id: firstAttempt, layer: "transport" }), event({ type: "attempt.finish", sequence: 3, attempt_id: firstAttempt, layer: "transport", outcome: "error", mutation: "unknown", duration_ms: 100, timing_scope: "transport" }), event({ type: "retry.scheduled", sequence: 4, layer: "transport", delay_ms: 50 }), event({ type: "attempt.start", sequence: 5, attempt_id: recovered, layer: "transport" }), event({ type: "attempt.finish", sequence: 6, attempt_id: recovered, layer: "transport", mutation: "confirmed", duration_ms: 80, timing_scope: "transport" }), event({ type: "invocation.finish", sequence: 7, business: "complete", duration_ms: 250, timing_scope: "invocation" })];
  const report = reviewDiagnosticSnapshot(snapshot(events));
  expect(report.invocations[0]!.mutation).toBe("mixed_evidence");
  expect(report.retries.find((item) => item.layer === "transport")).toMatchObject({ starts: 2, finishes: 2, scheduled_retries: 1, scheduled_delay_ms: 50, unfinished_attempts: 0 });
  expect(report.retries.find((item) => item.layer === "wrapper_child")!.starts).toBe(0);
  expect(report.durations.find((item) => item.timing_scope === "transport")).toMatchObject({ summed_measurements_ms: 180, maximum_observed_ms: 100, wall_time_ms: "unknown", overlap: "not_established" });
});

test("delivery measurements retain HTTP exchange timing without claiming wall time", () => {
  const report = reviewDiagnosticSnapshot(snapshot([
    event({ type: "delivery.outcome", source: "mcp_http", delivery: "finish", duration_ms: 25, timing_scope: "http_exchange" }),
    event({ type: "delivery.outcome", source: "mcp_http", delivery: "close_before_finish", sequence: 2, duration_ms: 30, timing_scope: "http_exchange" }),
    event({ type: "delivery.outcome", source: "mcp_http", delivery: "error", sequence: 3, duration_ms: 35, timing_scope: "http_exchange" }),
  ]));
  expect(report.durations).toEqual([{
    timing_scope: "http_exchange", samples: 3, minimum_observed_ms: 25, maximum_observed_ms: 35,
    summed_measurements_ms: 90, wall_time_ms: "unknown", overlap: "not_established",
  }]);
});

test("CLI root outcomes replace preparatory state without inventing outcomes for missing evidence", () => {
  const events = [
    event(),
    event({ type: "operation.step", sequence: 2, mutation: "not_dispatched" }),
    event({ type: "operation.step", sequence: 3, business: "complete", mutation: "confirmed", verification: "write_response" }),
    event({ type: "invocation.finish", sequence: 4, business: "unknown" }),
  ];
  expect(reviewDiagnosticSnapshot(snapshot(events)).invocations[0]).toMatchObject({
    finish: "observed", business: "complete", mutation: "confirmed", verification: "write_response",
  });
  const missing = reviewDiagnosticSnapshot(snapshot([events[0]!, events[1]!, events[3]!]));
  expect(missing.invocations[0]).toMatchObject({ business: "unknown", mutation: "unknown" });
  expect(missing.coverage.gaps).toContain("sequence_gap");
});

test("only an exact observed phase finish supersedes pending mutation state", () => {
  const committed = randomUUID(), uncertain = randomUUID();
  const events = [
    event(),
    event({ type: "phase.start", sequence: 2, phase: "execution", operation_id: committed, mutation: "unknown" }),
    event({ type: "phase.finish", sequence: 3, phase: "execution", operation_id: committed, mutation: "confirmed", outcome: "complete" }),
    event({ type: "invocation.finish", sequence: 4 }),
  ];
  expect(reviewDiagnosticSnapshot(snapshot(events)).invocations[0]!.mutation).toBe("confirmed");
  const unfinished = [...events.slice(0, 3),
    event({ type: "phase.start", sequence: 4, phase: "execution", operation_id: uncertain, mutation: "unknown" })];
  expect(reviewDiagnosticSnapshot(snapshot(unfinished)).invocations[0]).toMatchObject({ finish: "unknown", mutation: "mixed_evidence" });
  const failed = [...unfinished,
    event({ type: "phase.finish", sequence: 5, phase: "execution", operation_id: uncertain, mutation: "unknown", outcome: "error" }),
    event({ type: "invocation.finish", sequence: 6 })];
  expect(reviewDiagnosticSnapshot(snapshot(failed)).invocations[0]!.mutation).toBe("mixed_evidence");
});

test.each(["cli", "mcp_http"] as const)("%s explicit approval handoffs survive nested phase context without implying completed work", (source) => {
  const events = [
    event({ source }),
    event({ source, type: "operation.step", sequence: 2, operation_id: randomUUID(),
      phase: source === "cli" ? "approval_request" : "approval_wait",
      business: "awaiting_owner", outcome: "awaiting_owner" }),
    event({ source, type: "invocation.finish", sequence: 3, business: "unknown" }),
  ];
  expect(reviewDiagnosticSnapshot(snapshot(events)).invocations[0]).toMatchObject({
    finish: "observed", business: "awaiting_owner", mutation: "unknown",
  });
  expect(reviewDiagnosticSnapshot(snapshot([events[0]!, events[2]!])).invocations[0]!.business).toBe("unknown");
  const completed = [...events.slice(0, 2), { ...events[2]!, business: "complete" as const }];
  expect(reviewDiagnosticSnapshot(snapshot(completed)).invocations[0]!.business).toBe("complete");
});

test("partial work, canonical success, protocol result, send settlement and normal close remain independent", () => {
  const events = [
    event({ source: "mcp_http" }),
    event({ source: "mcp_http", type: "operation.step", sequence: 2, business: "complete", mutation: "confirmed" }),
    event({ source: "mcp_http", type: "operation.step", sequence: 3, business: "failed", mutation: "unknown" }),
    event({ source: "mcp_http", type: "phase.finish", sequence: 4, phase: "execution", business: "partial", canonical_status: "ok" }),
    event({ source: "mcp_http", type: "protocol.outcome", sequence: 5, protocol: "result" }),
    event({ source: "mcp_http", type: "invocation.finish", sequence: 6, business: "unknown" }),
    event({ source: "mcp_http", type: "protocol.outcome", sequence: 7, protocol: "send_finished" }),
    event({ source: "mcp_http", type: "delivery.outcome", sequence: 8, delivery: "finish" }),
    event({ source: "mcp_http", type: "delivery.outcome", sequence: 9, delivery: "close_after_finish" }),
  ];
  expect(reviewDiagnosticSnapshot(snapshot(events)).invocations[0]).toMatchObject({
    business: "partial", canonical_status: "ok", mutation: "mixed_evidence",
    protocol: "result", transport_send: "send_finished", delivery: "finish",
  });
  const noSummary = events.filter((item) => item.phase !== "execution");
  expect(reviewDiagnosticSnapshot(snapshot(noSummary)).invocations[0]!.business).toBe("unknown");
  const rootSummary = events.map((item) => item.phase === "execution"
    ? { ...item, type: "operation.step" as const, operation_id: randomUUID() } : item);
  rootSummary.push(event({ type: "operation.step", source: "mcp_http", sequence: 10, phase: "execution", ordinal: 1, business: "complete" }));
  expect(reviewDiagnosticSnapshot(snapshot(rootSummary)).invocations[0]!.business).toBe("partial");
});

test("semantic wrong_units needs exact selected evidence and cannot be inferred from successful transport", () => {
  const events = [event({ type: "invocation.finish", business: "complete" })];
  const item = validateSelectedDiagnosticCase(selected(events), now);
  expect(reviewDiagnosticSnapshot(snapshot(events)).findings).toEqual([]);
  const report = reviewDiagnosticSnapshot(snapshot(events), [item]);
  expect(report.findings[0]).toMatchObject({ classification: "wrong_units", status: "selected_evidence_supports", passage_ids: item.feedback!.passage_ids, event_ids: [events[0]!.event_id] });
  expect(reviewDiagnosticSnapshot(snapshot([]), [item]).findings[0]!.status).toBe("owner_reported_not_established");
  const misquoted = structuredClone(item); misquoted.passages[0]!.unit!.start = 0;
  expect(() => validateSelectedDiagnosticCase(misquoted, now)).toThrow("diagnostics: invalid_input");
});

test("comparisons refuse winner when fixture revisions, cache conditions or coverage differ", () => {
  const events = [event({ type: "invocation.finish", business: "complete" })];
  const leftCase = selected(events), rightCase = selected(events);
  const fixtureId = randomUUID();
  leftCase.equivalence = { fixture_id: fixtureId, fixture_revision: "a".repeat(64), task_class: "record_write_readback", cache_state: "cold" };
  rightCase.equivalence = { ...leftCase.equivalence, fixture_revision: "b".repeat(64), cache_state: "warm" };
  const result = compareDiagnosticReviews(reviewDiagnosticSnapshot(snapshot(events), [leftCase]), reviewDiagnosticSnapshot(snapshot(events), [rightCase]));
  expect(result.comparable).toBe(false);
  expect(result.winner).toBeNull();
  expect(result.reasons).toContain("fixture_revision_mismatch");
  expect(result.reasons).toContain("cache_state_incomparable");
  expect(result.reasons).toContain("provenance_incomplete");
});

test("selected credentials are rejected before acceptance including URI, base64 and escaped forms without echo", () => {
  const secret = "Authorization: Bearer synthetic-super-secret-token";
  for (const text of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), secret.replace(/./g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`), Buffer.from(Buffer.from(secret).toString("base64")).toString("base64")]) {
    try { rejectDiagnosticCredentials(text); throw new Error("accepted credential"); }
    catch (error) { expect((error as Error).message).toBe("diagnostics: credential_content"); }
  }
  const item = selected([event()]); item.expires_at = new Date(now + 8 * 86400000).toISOString();
  expect(() => validateSelectedDiagnosticCase(item, now)).toThrow("diagnostics: invalid_input");
});

test("transfer checksum cannot bypass original retention or authorize unknown executable files", () => {
  const old = event({ occurred_at: new Date(now - METADATA_RETENTION_MS + 1000).toISOString() });
  expect(() => decodeDiagnosticBundle(bundle([old], now + 2000), now)).toThrow("diagnostics: invalid_input");
  const files = bundle([event()]);
  expect(() => decodeDiagnosticBundle({ ...files, "run.sh": Buffer.from("ignored") }, now)).toThrow("diagnostics: invalid_input");
  files["events.jsonl"] = Buffer.from("{}\n");
  expect(() => decodeDiagnosticBundle(files, now)).toThrow("diagnostics: integrity_failure");
});

test("exact deletion rewrites mixed bundle without erasing unrelated evidence or refreshing expiry", () => {
  const first = event(), second = event({ sequence: 2, invocation_id: randomUUID() });
  const files = bundle([first, second]);
  const original = decodeDiagnosticBundle(files, now);
  const rewritten = rewriteDiagnosticBundle(files, { event_ids: [first.event_id] })!;
  const retained = decodeDiagnosticBundle(rewritten.files, now);
  expect(retained.snapshot.events.map((item) => item.event_id)).toEqual([second.event_id]);
  expect(retained.manifest.expires_at).toBe(original.manifest.expires_at);
  expect(retained.manifest.exported_at).toBe(original.manifest.exported_at);
  expect(rewritten.meta.event_ids).toEqual([second.event_id]);
  const unrelated = event({ source_id: randomUUID() });
  const withConflict = bundle([first, unrelated, { ...unrelated, business: "failed" }]);
  const filteredAll = rewriteDiagnosticBundle(withConflict, { all: true, source_ids: [first.source_id] })!;
  expect(decodeDiagnosticBundle(filteredAll.files, now).snapshot.conflicts).toEqual([`${unrelated.source_id}/${unrelated.event_id}`]);
  expect(filteredAll.meta.event_ids).toEqual([unrelated.event_id]);
});

test("bounded explicit inputs refuse symlinks, traversal and excess bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-input-test-"));
  try {
    const path = join(root, "selected.json");
    await writeFile(path, JSON.stringify({ selected: true }), { mode: 0o600 });
    await symlink(path, join(root, "link.json"));
    await expect(readDiagnosticJsonFile(join(root, "link.json"))).rejects.toThrow("diagnostics: unsafe_path");
    await expect(readDiagnosticJsonFile(join(root, "sub", "..", "selected.json") + "/../selected.json")).rejects.toThrow("diagnostics: unsafe_path");
    await expect(readDiagnosticJsonFile(path, 3)).rejects.toThrow("diagnostics: input_limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed import is idempotent, reports conflicts and does not confer source trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-import-test-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    await store.control("enable", { scope: "tc-apps" });
    const dir = join(root, "transfer"); await mkdir(dir, { mode: 0o700 });
    const first = event();
    for (const [name, bytes] of Object.entries(bundle([first]))) await writeFile(join(dir, name), bytes, { mode: 0o600 });
    const one = await importDiagnosticBundle(store, dir), two = await importDiagnosticBundle(store, dir);
    expect(two.import_id).toBe(one.import_id);
    expect(two.trust).toBe("imported_assertion");
    expect((await store.snapshot({ event_ids: [first.event_id] })).events.map((item) => item.event_id)).toEqual([first.event_id]);
    const reordered: DiagnosticEvent = JSON.parse(JSON.stringify(first, Object.keys(first).reverse()));
    for (const [name, bytes] of Object.entries(bundle([reordered]))) await writeFile(join(dir, name), bytes, { mode: 0o600 });
    const sameEvidence = await importDiagnosticBundle(store, dir);
    expect(sameEvidence.conflicts).toEqual([]);
    expect((await store.snapshot({ event_ids: [first.event_id] })).events.map((item) => item.event_id)).toEqual([first.event_id]);
    for (const [name, bytes] of Object.entries(bundle([{ ...first, business: "failed" }]))) await writeFile(join(dir, name), bytes, { mode: 0o600 });
    const conflict = await importDiagnosticBundle(store, dir);
    expect(conflict.conflicts).toContain(`${first.source_id}/${first.event_id}`);
    expect((await store.snapshot({ event_ids: [first.event_id] })).events).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("synthetic fixtures accept no executable, URL, profile or arbitrary command fields", () => {
  const fixture = { schema_version: 1, kind: "wrong_units", fixture_id: randomUUID(), reviewed: true, synthetic: true, expected: { value: 12, unit: "U1" }, observed: { value: 12, unit: "U2" } };
  const accepted = validateDiagnosticFixture(fixture);
  expect(diagnosticFixtureRevision(accepted)).not.toBe(diagnosticFixtureRevision({ ...accepted, observed: { value: 13, unit: "U2" } }));
  expect(() => validateDiagnosticFixture({ ...fixture, command: "not executable" })).toThrow("diagnostics: invalid_input");
  expect(() => validateDiagnosticFixture({ ...fixture, reviewed: false })).toThrow("diagnostics: invalid_input");
});

test("equivalent selected fixtures compare independent client revisions without inventing an overall winner", () => {
  const descriptorId = randomUUID();
  const events = [
    event({ descriptor_id: descriptorId }),
    event({ type: "invocation.finish", sequence: 2, descriptor_id: descriptorId, business: "complete" }),
  ];
  const first = selected(events), second = selected(events);
  first.equivalence = { fixture_id: randomUUID(), fixture_revision: "a".repeat(64), task_class: "record_write_readback", cache_state: "cold" };
  second.equivalence = { ...first.equivalence };
  const left: DiagnosticSnapshot = { ...snapshot(events), descriptors: [{ descriptor_id: descriptorId, source: "cli", package: "@tinycloud/cli", version: "1.0.0", build_hash: "a".repeat(40), skill_revision: "1.0.0", rules_revision: "b".repeat(40), client_version: "1.0.0" }] };
  const right: DiagnosticSnapshot = { ...left, descriptors: [{ ...left.descriptors[0]!, client_version: "2.0.0" }] };
  const report = compareDiagnosticReviews(reviewDiagnosticSnapshot(left, [first]), reviewDiagnosticSnapshot(right, [second]));
  expect(report.comparable).toBe(true);
  expect(report.winner).toBeNull();
  expect(report.measures.wall_time).toBe("unknown");
  expect(report.left.timeline[0]!.provenance).toMatchObject({ client_version: "1.0.0" });
  expect(report.right.timeline[0]!.provenance).toMatchObject({ client_version: "2.0.0" });
  const finishOnly = reviewDiagnosticSnapshot({ ...right, events: events.slice(1) }, [second]);
  expect(compareDiagnosticReviews(report.left, finishOnly).reasons).toContain("completion_coverage_incomplete");
  expect(finishOnly.invocations[0]).toMatchObject({ start: "unknown", finish: "observed" });
});

test("reused imported event UUIDs remain separate source-qualified timeline nodes", () => {
  const first = event(), second = { ...first, source_id: randomUUID() };
  const report = reviewDiagnosticSnapshot(snapshot([first, second]));
  expect(report.event_count).toBe(2);
  expect(report.partial_order.layers).toEqual([[`${first.source_id}/${first.event_id}`, `${second.source_id}/${second.event_id}`].sort()]);
  expect(report.timeline.map((node) => node.node_id).sort()).toEqual(report.partial_order.layers[0]);
});

test("case expansion preserves exact source/event links across independent imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-case-sources-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    await store.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
    const first = event();
    const second = event({ source_id: randomUUID(), invocation_id: randomUUID() });
    const unrelated = event({ source_id: randomUUID(), event_id: first.event_id });
    const crossFirst = { ...first, event_id: second.event_id, sequence: 2 };
    const crossSecond = { ...second, event_id: first.event_id, sequence: 2 };
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(bundle([first, second, unrelated, crossFirst, crossSecond]))) {
      await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    }
    await importDiagnosticBundle(store, transfer);
    const cases = [selected([first]), { ...selected([second]), source_ids: [second.source_id] }];
    for (const item of cases) {
      await store.putManaged("cases", item.case_id, { "detail.json": JSON.stringify(item) }, {
        expires_at: item.expires_at, source_ids: item.source_ids, event_ids: item.event_ids,
        case_ids: [item.case_id], detail: true,
      });
    }
    const selection = { case_ids: cases.map((item) => item.case_id), include_detail: true };
    const expected = [first, second].map((item) => `${item.source_id}/${item.event_id}`).sort();
    expect((await reviewDiagnostics(store, selection)).timeline.map((node) => node.node_id).sort()).toEqual(expected);
    const exported = await exportDiagnosticBundle(store, {
      selection, out: join(root, "receiver", "exports", randomUUID()),
      expires_at: new Date(now + 600000).toISOString(),
    });
    expect(exported.manifest.source_ids.sort()).toEqual([first.source_id, second.source_id].sort());
    const exportedEvents = (await readFile(join(exported.path, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as DiagnosticEvent);
    expect(exportedEvents.map((item) => `${item.source_id}/${item.event_id}`).sort()).toEqual(expected);
    const constrained = await reviewDiagnostics(store, { ...selection, source_ids: [first.source_id] });
    expect(constrained.timeline.map((node) => node.node_id)).toEqual([`${first.source_id}/${first.event_id}`]);
    const explicit = await reviewDiagnostics(store, { ...selection, event_ids: [first.event_id] });
    expect(explicit.timeline.map((node) => node.node_id).sort()).toEqual(
      [first, second, unrelated, crossSecond].map((item) => `${item.source_id}/${item.event_id}`).sort(),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed exports round-trip through strict import and imported evidence cannot acquire fresh expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-roundtrip-test-"));
  try {
    const producer = new DiagnosticStore(join(root, "producer"));
    const receiver = new DiagnosticStore(join(root, "receiver"));
    await producer.control("enable", { scope: "tc-apps" });
    await receiver.control("enable", { scope: "tc-apps" });
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    const first = event(), second = event({ sequence: 2, invocation_id: randomUUID() });
    const originalExpiry = now + 600000;
    for (const [name, bytes] of Object.entries(bundle([first, second], originalExpiry))) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    await importDiagnosticBundle(producer, transfer);
    const exported = await exportDiagnosticBundle(producer, { selection: { event_ids: [first.event_id, second.event_id] }, out: join(root, "producer", "exports", randomUUID()), expires_at: new Date(originalExpiry - 1000).toISOString() });
    expect(exported.managed).toBe(true);
    await importDiagnosticBundle(receiver, exported.path);
    expect((await receiver.snapshot({ source_ids: [source] })).events.map((item) => item.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
    await expect(exportDiagnosticBundle(receiver, { selection: { event_ids: [first.event_id] }, out: join(root, "receiver", "exports", randomUUID()), expires_at: new Date(originalExpiry + 1000).toISOString() })).rejects.toThrow("diagnostics: invalid_input");
    await receiver.delete({ event_ids: [first.event_id] });
    expect((await receiver.snapshot({ source_ids: [source] })).events.map((item) => item.event_id)).toEqual([second.event_id]);
    expect((await producer.snapshot({ source_ids: [source] })).events.map((item) => item.event_id).sort()).toEqual([first.event_id, second.event_id].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selected intake rejects credentials without persistence and bundles preserve imported assertion trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-selected-test-"));
  try {
    const store = new DiagnosticStore(join(root, "owner"));
    await store.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
    const evidenceEvent = event({ type: "invocation.finish", business: "complete" });
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(bundle([evidenceEvent]))) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    await importDiagnosticBundle(store, transfer);
    const selectedCase = selected([evidenceEvent]);
    const fixture = validateDiagnosticFixture({ schema_version: 1, kind: "wrong_units", fixture_id: randomUUID(), reviewed: true, synthetic: true, expected: { value: 12, unit: "U1" }, observed: { value: 12, unit: "U2" } });
    const input = { schema_version: 1, expires_at: selectedCase.expires_at, purpose: "synthetic_reproduction", owner_selected: true, no_secrets_or_unrelated_content: true, detail_policy: "encrypted-excluded-backups", event_ids: selectedCase.event_ids, passages: selectedCase.passages, feedback: selectedCase.feedback, equivalence: { fixture_id: fixture.fixture_id, fixture_revision: diagnosticFixtureRevision(fixture), task_class: "record_write_readback", cache_state: "cold" } };
    const inputPath = join(root, "selection.json");
    const unsafe = structuredClone(input);
    unsafe.passages[0]!.text = "Authorization: Bearer synthetic-secret-token";
    await writeFile(inputPath, JSON.stringify(unsafe), { mode: 0o600 });
    await expect(selectDiagnosticCase(store, inputPath)).rejects.toThrow("diagnostics: credential_content");
    expect(await store.listManaged("cases")).toEqual([]);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const accepted = await selectDiagnosticCase(store, inputPath);
    await expect(reviewDiagnostics(store, { case_ids: [accepted.case_id] })).rejects.toThrow("diagnostics: detail_policy_required");
    const report = await reviewDiagnostics(store, { case_ids: [accepted.case_id], include_detail: true });
    expect(report.findings[0]!.status).toBe("selected_evidence_supports");
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    const exported = await bundleDiagnosticCase(store, { case_id: accepted.case_id, fixture: fixturePath, out: join(root, "owner", "exports", randomUUID()), expires_at: new Date(now + 600000).toISOString() });
    const receiver = new DiagnosticStore(join(root, "reviewer"));
    await receiver.control("enable", { scope: "tc-apps", detail_policy: "encrypted-excluded-backups" });
    await importDiagnosticBundle(receiver, exported.path);
    const importedReview = await reviewDiagnostics(receiver, { case_ids: [accepted.case_id], include_detail: true });
    expect(importedReview.findings[0]).toMatchObject({ classification: "wrong_units", status: "selected_evidence_supports", trust: "imported_assertion" });
    expect(Date.parse(importedReview.expires_at!)).toBeLessThanOrEqual(Date.parse(accepted.expires_at));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["event", "escaped event", "manifest", "nested manifest", "nested detail", "nested fixture"] as const)("duplicate JSON keys in %s never persist shadowed credentials", async (target) => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-duplicate-keys-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    await store.control("enable", { scope: "tc-apps", ...(target.includes("detail") || target.includes("fixture") ? { detail_policy: "encrypted-excluded-backups" as const } : {}) });
    const first = event({ activity: "kv" });
    const files = bundle([first]);
    const manifest: DiagnosticBundleManifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString());
    const canary = "Authorization: Bearer synthetic-shadowed-credential-canary";
    if (target === "event" || target === "escaped event") {
      files["events.jsonl"] = Buffer.from(Buffer.from(files["events.jsonl"]!).toString().replace('"activity":"kv"', `"activity":${JSON.stringify(canary)},"${target === "event" ? "activity" : "\\u0061ctivity"}":"kv"`));
    }
    if (target === "nested detail" || target === "nested fixture") {
      const detail = selected([first]);
      manifest.content_tiers.push("selected_detail");
      manifest.selection = { ...manifest.selection, case_ids: [detail.case_id], include_detail: true };
      files["detail.json"] = Buffer.from(JSON.stringify({ schema_version: 1, cases: [detail] }).replace('"text":"Store 12 U1"', target === "nested detail" ? `"text":${JSON.stringify(canary)},"text":"Store 12 U1"` : '"text":"Store 12 U1"'));
      if (target === "nested fixture") {
        manifest.content_tiers.push("synthetic_fixture");
        files["fixture.json"] = Buffer.from(JSON.stringify({ schema_version: 1, kind: "wrong_units", fixture_id: randomUUID(), reviewed: true, synthetic: true, expected: { value: 12, unit: "U1" }, observed: { value: 12, unit: "U2" } }).replace('"unit":"U1"', `"unit":${JSON.stringify(canary)},"unit":"U1"`));
        files["reproduce.mjs"] = Buffer.from(REPRODUCTION_SCRIPT);
        files["instructions.txt"] = Buffer.from(REPRODUCTION_INSTRUCTIONS);
      }
    }
    for (const [name, bytes] of Object.entries(files)) {
      if (name !== "manifest.json") manifest.files[name as keyof DiagnosticBundleManifest["files"]] = { bytes: bytes.length, sha256: diagnosticTransferChecksum(bytes) };
    }
    let manifestText = JSON.stringify(manifest);
    if (target === "manifest") manifestText = manifestText.replace('"trust":"source_observation"', `"trust":${JSON.stringify(canary)},"trust":"source_observation"`);
    if (target === "nested manifest") manifestText = manifestText.replace('"first":', `"first":${JSON.stringify(canary)},"first":`);
    files["manifest.json"] = Buffer.from(manifestText);
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    let failure: unknown;
    try { await importDiagnosticBundle(store, transfer); } catch (error) { failure = error; }
    const persisted = await store.listManaged("imports");
    for (const item of persisted) {
      const stored = await store.readManaged("imports", item.id);
      expect(Object.values(stored.files).map((bytes) => Buffer.from(bytes).toString()).join("")).not.toContain(canary);
    }
    const directories = [join(root, "receiver")];
    for (const directory of directories) for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else expect(await readFile(path, "utf8")).not.toContain(canary);
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("diagnostics: invalid_input");
    expect(persisted).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source-qualified deletion preserves reused event IDs in mixed imports and derivative exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-source-deletion-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    await store.control("enable", { scope: "tc-apps" });
    const first = event(), second = { ...first, source_id: randomUUID(), invocation_id: randomUUID() };
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(bundle([first, second]))) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    const imported = await importDiagnosticBundle(store, transfer);
    const exportId = randomUUID();
    await exportDiagnosticBundle(store, { selection: { all: true }, out: join(root, "receiver", "exports", exportId), expires_at: new Date(now + 600000).toISOString() });
    await store.delete({ source_ids: [first.source_id] });
    expect((await reviewDiagnostics(store, { all: true })).timeline.map((node) => node.node_id)).toEqual([`${second.source_id}/${second.event_id}`]);
    for (const [kind, id] of [["imports", imported.import_id], ["exports", exportId]] as const) {
      const stored = await store.readManaged(kind, id);
      const retained = decodeDiagnosticBundle(stored.files);
      expect(retained.snapshot.events).toEqual([second]);
      expect(Buffer.from(stored.files["events.jsonl"]!).toString()).not.toContain(first.source_id);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["one transfer", "separate transfers"] as const)("conflicting source event does not suppress another source with the same event ID: %s", async (layout) => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-source-conflict-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    await store.control("enable", { scope: "tc-apps" });
    const first = event(), second = { ...first, source_id: randomUUID(), invocation_id: randomUUID() };
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(bundle(layout === "one transfer" ? [first, { ...first, business: "failed" }, second] : [first, second]))) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    const imported = await importDiagnosticBundle(store, transfer);
    if (layout === "separate transfers") {
      for (const [name, bytes] of Object.entries(bundle([{ ...first, business: "failed" }]))) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
      await importDiagnosticBundle(store, transfer);
    } else expect(imported.events).toBe(1);
    expect((await reviewDiagnostics(store, { all: true })).timeline.map((node) => node.node_id)).toEqual([`${second.source_id}/${second.event_id}`]);
    const report = await reviewDiagnostics(store, { source_ids: [second.source_id] });
    expect(report.timeline.map((node) => node.node_id)).toEqual([`${second.source_id}/${second.event_id}`]);
    expect(report.coverage.conflicts).toEqual([]);
    await store.delete({ source_ids: [first.source_id] });
    expect(decodeDiagnosticBundle((await store.readManaged("imports", imported.import_id)).files).snapshot.events).toEqual([second]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["conflict", "gap"] as const)("%s-only imported assertions preserve expiry through review and repeated export", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "tc-diagnostic-conflict-expiry-"));
  try {
    const store = new DiagnosticStore(join(root, "receiver"));
    const next = new DiagnosticStore(join(root, "next"));
    await store.control("enable", { scope: "tc-apps" });
    await next.control("enable", { scope: "tc-apps" });
    const first = event(), expiry = new Date(now + 600000).toISOString();
    const transfer = join(root, "transfer");
    await mkdir(transfer, { mode: 0o700 });
    const files = bundle([first, { ...first, business: "failed" }], Date.parse(expiry));
    if (kind === "gap") {
      const manifest: DiagnosticBundleManifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString());
      files["events.jsonl"] = Buffer.from("");
      manifest.original_times = { first: null, last: null };
      manifest.gaps = ["sequence_gap"];
      manifest.files["events.jsonl"] = { bytes: 0, sha256: diagnosticTransferChecksum("") };
      files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
    }
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(transfer, name), bytes, { mode: 0o600 });
    await importDiagnosticBundle(store, transfer);
    const selection = { source_ids: [first.source_id] };
    const report = await reviewDiagnostics(store, selection);
    expect(report.event_count).toBe(0);
    expect(report.expires_at).toBe(expiry);
    await expect(exportDiagnosticBundle(store, { selection, out: join(root, "receiver", "exports", randomUUID()), expires_at: new Date(Date.parse(expiry) + 1000).toISOString() })).rejects.toThrow("diagnostics: invalid_input");
    const exported = await exportDiagnosticBundle(store, { selection, out: join(root, "receiver", "exports", randomUUID()), expires_at: expiry });
    expect(exported.manifest.source_ids).toContain(first.source_id);
    await importDiagnosticBundle(next, exported.path);
    const nextReport = await reviewDiagnostics(next, selection);
    expect(nextReport.expires_at).toBe(expiry);
    expect(nextReport.coverage.conflicts).toEqual(report.coverage.conflicts);
    expect(nextReport.coverage.gaps).toContain(kind === "gap" ? "sequence_gap" : "conflict");
    const again = await exportDiagnosticBundle(next, { selection, out: join(root, "next", "exports", randomUUID()), expires_at: expiry });
    expect(again.manifest.expires_at).toBe(expiry);
    expect(again.manifest.source_ids).toContain(first.source_id);
    await next.delete({ source_ids: [first.source_id] });
    expect(await next.listManaged("imports")).toEqual([]);
    expect(await next.listManaged("exports")).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
