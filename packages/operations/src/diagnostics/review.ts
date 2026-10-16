import type { DiagnosticDescriptor, DiagnosticEvent, DiagnosticGap, DiagnosticSelection, DiagnosticSnapshot } from "./model.js";
import { METADATA_RETENTION_MS, diagnosticMetadataEqual } from "./model.js";
import type { DiagnosticStore } from "./storage.js";
import { deduplicateDiagnosticSnapshot, resolveDiagnosticEvidence } from "./bundles.js";
import type { SelectedDiagnosticCase } from "./selection.js";

export interface DiagnosticTimelineNode {
  event: DiagnosticEvent;
  /** Source/event pair; imported UUIDs never collapse independent source nodes. */
  node_id: string;
  predecessors: string[];
  ordering: "producer_sequence_and_explicit_links_only";
  time: string | "unknown";
  provenance: DiagnosticDescriptor | "unknown";
  provenance_unknown_fields: string[];
  trust: "source_observation_or_imported_assertion";
}
export interface DiagnosticDurationSummary {
  timing_scope: string;
  samples: number;
  minimum_observed_ms: number;
  maximum_observed_ms: number;
  summed_measurements_ms: number;
  wall_time_ms: "unknown";
  overlap: "not_established";
}
export interface DiagnosticReview {
  event_count: number;
  timeline: DiagnosticTimelineNode[];
  partial_order: { layers: string[][]; cyclic_or_conflicting_event_ids: string[]; wall_time_is_not_causal_order: true };
  invocations: { invocation_id: string; source_id: string; start: "observed" | "unknown"; finish: "observed" | "unknown"; task_linkage: string | "unknown"; business: string; canonical_status: string; mutation: string; verification: string; verification_result: string; copy_state: string; protocol: string; transport_send: string; delivery: string; evidence_ids: string[] }[];
  retries: { layer: string; starts: number; finishes: number; scheduled_retries: number; scheduled_delay_ms: number; unfinished_attempts: number }[];
  durations: DiagnosticDurationSummary[];
  coverage: { selected_events: number; invocations: number; started_invocations: number; finished_invocations: number; described_events: number; task_linked_invocations: number; gaps: DiagnosticGap[]; conflicts: string[] };
  findings: { classification: string; status: "selected_evidence_supports" | "owner_reported_not_established"; case_id: string; passage_ids: string[]; event_ids: string[]; trust: string }[];
  selected_cases: SelectedDiagnosticCase[];
  expires_at?: string;
}

function eventReference(event: DiagnosticEvent): string {
  return `${event.source_id}/${event.event_id}`;
}

const PROTOCOL_RESULTS: Partial<Record<NonNullable<DiagnosticEvent["protocol"]>, true>> = {
  result: true, tool_error: true, before_executor_refusal: true, post_executor_protocol_failure: true,
};
const SEND_RESULTS: Partial<Record<NonNullable<DiagnosticEvent["protocol"]>, true>> = {
  send_finished: true, send_failed: true,
};

/** No global wall-clock sort: independent producers remain unordered unless explicitly linked. */
export function reviewDiagnosticSnapshot(input: DiagnosticSnapshot, selectedCases: SelectedDiagnosticCase[] = []): DiagnosticReview {
  const snapshot = deduplicateDiagnosticSnapshot(input);
  const now = Date.now();
  const events = snapshot.events.filter((event) => Date.parse(event.occurred_at) <= now && Date.parse(event.occurred_at) + METADATA_RETENTION_MS > now);
  const cases = selectedCases.filter((item) => Date.parse(item.expires_at) > now);
  const byId = new Map(events.map((event) => [eventReference(event), event]));
  const predecessors = new Map(events.map((event) => [eventReference(event), new Set<string>()]));
  const producers = new Map<string, DiagnosticEvent[]>();
  const invocationGroups = new Map<string, DiagnosticEvent[]>();
  const references = new Map<string, DiagnosticEvent | null>(byId);
  const gaps = new Set<DiagnosticGap>(snapshot.gaps);
  if (events.length === 0) gaps.add("coverage_unknown");
  if (events.length !== snapshot.events.length) gaps.add("expired_evidence");
  for (const event of events) {
    if (event.type === "capture.health") {
      if ((event.dropped ?? 0) > 0) gaps.add("dropped_events");
      if (event.failure !== undefined && event.failure !== "none") gaps.add("sink_failure");
    }
    const producer = `${event.source_id}/${event.process_id}`;
    const list = producers.get(producer) ?? [];
    list.push(event); producers.set(producer, list);
    const invocationKey = `${event.source_id}/${event.invocation_id}`;
    const invocation = invocationGroups.get(invocationKey) ?? [];
    invocation.push(event); invocationGroups.set(invocationKey, invocation);
    const alias = event.type === "invocation.start" ? event.invocation_id
      : event.type === "phase.start" ? event.operation_id
      : event.type === "attempt.start" ? event.attempt_id : undefined;
    if (alias) {
      const key = `${event.source_id}/${alias}`;
      const previous = references.get(key);
      if (previous === undefined) references.set(key, event);
      else if (previous !== event) { references.set(key, null); gaps.add("conflict"); }
    }
  }
  for (const list of producers.values()) {
    list.sort((left, right) => left.sequence - right.sequence);
    for (let i = 1; i < list.length; i++) {
      const before = list[i - 1]!, after = list[i]!;
      if (after.sequence === before.sequence) { gaps.add("conflict"); continue; }
      predecessors.get(eventReference(after))!.add(eventReference(before));
      if (after.sequence !== before.sequence + 1) gaps.add("sequence_gap");
      if (Date.parse(after.occurred_at) < Date.parse(before.occurred_at)) gaps.add("clock_anomaly");
    }
  }
  for (const event of events) {
    const previous = predecessors.get(eventReference(event))!;
    if (event.parent_id) {
      const parent = references.get(`${event.source_id}/${event.parent_id}`);
      if (parent) previous.add(eventReference(parent));
      else gaps.add("linkage_unknown");
    }
    const startId = event.type === "invocation.finish" ? event.invocation_id
      : event.type === "phase.finish" ? event.operation_id
      : event.type === "attempt.finish" ? event.attempt_id : undefined;
    if (startId) {
      const start = references.get(`${event.source_id}/${startId}`);
      if (start?.type === event.type.replace(".finish", ".start")) previous.add(eventReference(start));
    }
  }
  const remaining = new Map([...predecessors].map(([id, refs]) => [id, new Set(refs)]));
  const successors = new Map<string, string[]>();
  for (const [id, refs] of remaining) for (const ref of refs) { const next = successors.get(ref) ?? []; next.push(id); successors.set(ref, next); }
  let ready = [...remaining].filter(([, refs]) => !refs.size).map(([id]) => id).sort();
  const layers: string[][] = [];
  while (ready.length) {
    layers.push(ready);
    const next: string[] = [];
    for (const id of ready) {
      remaining.delete(id);
      for (const child of successors.get(id) ?? []) {
        const refs = remaining.get(child);
        if (refs) { refs.delete(id); if (!refs.size) next.push(child); }
      }
    }
    ready = [...new Set(next)].sort();
  }
  if (remaining.size) gaps.add("conflict");
  const descriptorMap = new Map<string, DiagnosticDescriptor>();
  const descriptorConflicts = new Set<string>();
  for (const descriptor of snapshot.descriptors) {
    const previous = descriptorMap.get(descriptor.descriptor_id);
    if (previous && !diagnosticMetadataEqual(previous, descriptor)) descriptorConflicts.add(descriptor.descriptor_id);
    else descriptorMap.set(descriptor.descriptor_id, descriptor);
  }
  const timeline: DiagnosticTimelineNode[] = events.map((event) => {
    const descriptor = event.descriptor_id && !descriptorConflicts.has(event.descriptor_id) ? descriptorMap.get(event.descriptor_id) : undefined;
    if (!descriptor) gaps.add("descriptor_missing");
    const provenanceFields: (keyof DiagnosticDescriptor)[] = ["package", "version", "build_hash", "wrapper_revision", "skill_revision", "rules_revision", "adapter", "adapter_revision", "client_version", "model"];
    return { event, node_id: eventReference(event), predecessors: [...predecessors.get(eventReference(event))!], ordering: "producer_sequence_and_explicit_links_only", time: event.occurred_at || "unknown", provenance: descriptor ?? "unknown", provenance_unknown_fields: provenanceFields.filter((field) => descriptor?.[field] === undefined || descriptor[field] === "unknown"), trust: "source_observation_or_imported_assertion" };
  });
  const invocations: DiagnosticReview["invocations"] = [];
  for (const group of invocationGroups.values()) {
    const invocationStarts = group.filter((event) => event.type === "invocation.start");
    const start = invocationStarts.length === 1 ? invocationStarts[0] : undefined;
    const finishes = group.filter((event) => event.type === "invocation.finish");
    const finish = finishes.length === 1 ? finishes[0] : undefined;
    if (!start) gaps.add("coverage_unknown");
    if (invocationStarts.length > 1 || finishes.length > 1) gaps.add("conflict");
    if (!finish) gaps.add("unfinished_invocation");
    const taskIds = [...new Set(group.map((event) => event.task_id).filter((id): id is string => Boolean(id)))];
    if (taskIds.length !== 1) gaps.add("linkage_unknown");
    const dimension = (name: "business" | "canonical_status" | "mutation" | "verification" | "verification_result" | "copy_state" | "protocol" | "delivery", evidence = group): string => {
      // An uncertain mutation remains uncertain after a later recovered attempt.
      const values = new Set<string>();
      for (const event of evidence) if (event[name] !== undefined) values.add(event[name]!);
      return values.size === 1 ? values.values().next().value! : values.size > 1 ? "mixed_evidence" : "unknown";
    };
    // Only producer-declared root work outcomes or an explicit approval handoff
    // summarize business state; protocol/canonical success and member steps cannot.
    const workSummaries = group.filter((event) => event.type === "operation.step" && event.phase === "execution" && event.ordinal === undefined);
    const businessEvidence = finish?.business !== undefined && finish.business !== "unknown" ? [finish] : workSummaries.length ? workSummaries : group.filter((event) =>
      (event.type === "phase.finish" && event.phase === "execution")
      || (event.source === "cli" && event.type === "operation.step" && event.operation_id === undefined)
      || (event.type === "operation.step" && event.business === "awaiting_owner"
        && (event.phase === "approval_request" || event.phase === "approval_wait")));
    const finishedPhases = new Set<string>();
    for (const event of group) if (event.type === "phase.finish" && event.operation_id) finishedPhases.add(event.operation_id);
    // Pending mutation state is superseded only by an observed finish of that
    // exact phase. An unfinished phase remains uncertain, even after other commits.
    const mutations = group.filter((event) =>
      !(event.type === "phase.start" && event.operation_id && finishedPhases.has(event.operation_id))
      && (event.mutation !== "not_dispatched" || event.business !== undefined || event.type === "invocation.finish"));
    const protocol = group.filter((event) => event.protocol !== undefined && Object.prototype.hasOwnProperty.call(PROTOCOL_RESULTS, event.protocol));
    const sends = group.filter((event) => event.protocol !== undefined && Object.prototype.hasOwnProperty.call(SEND_RESULTS, event.protocol));
    const delivered = group.some((event) => event.delivery === "finish");
    const delivery = delivered ? group.filter((event) => event.delivery !== "close_after_finish") : group;
    invocations.push({
      invocation_id: group[0]!.invocation_id, source_id: group[0]!.source_id,
      start: start ? "observed" : "unknown", finish: finish ? "observed" : "unknown", task_linkage: taskIds.length === 1 ? taskIds[0]! : "unknown",
      business: dimension("business", businessEvidence), canonical_status: dimension("canonical_status"),
      mutation: dimension("mutation", mutations), verification: dimension("verification"),
      verification_result: dimension("verification_result"), copy_state: dimension("copy_state"),
      protocol: dimension("protocol", protocol), transport_send: dimension("protocol", sends),
      delivery: dimension("delivery", delivery), evidence_ids: group.map((event) => event.event_id),
    });
  }
  const retries: DiagnosticReview["retries"] = [];
  for (const layer of ["transport", "wrapper_child", "copy_chunk", "unknown"]) {
    const selected = events.filter((event) => (event.layer ?? "unknown") === layer);
    const started = selected.filter((event) => event.type === "attempt.start");
    const finished = selected.filter((event) => event.type === "attempt.finish");
    const scheduled = selected.filter((event) => event.type === "retry.scheduled");
    retries.push({ layer, starts: started.length, finishes: finished.length, scheduled_retries: scheduled.length, scheduled_delay_ms: scheduled.reduce((sum, event) => sum + (event.delay_ms ?? 0), 0), unfinished_attempts: started.filter((start) => !start.attempt_id || !finished.some((end) => end.source_id === start.source_id && end.attempt_id === start.attempt_id)).length });
  }
  const samples = new Map<string, number[]>();
  for (const event of events) if (event.duration_ms !== undefined && (event.type.endsWith(".finish") || event.type === "delivery.outcome")) {
    const scope = event.phase === "approval_wait" ? "approval_wait" : event.timing_scope ?? "unknown";
    const values = samples.get(scope) ?? []; values.push(event.duration_ms); samples.set(scope, values);
  }
  const durations: DiagnosticDurationSummary[] = [...samples].map(([scope, values]) => ({ timing_scope: scope, samples: values.length, minimum_observed_ms: Math.min(...values), maximum_observed_ms: Math.max(...values), summed_measurements_ms: values.reduce((sum, value) => sum + value, 0), wall_time_ms: "unknown", overlap: "not_established" }));
  const findings: DiagnosticReview["findings"] = [];
  for (const selected of cases) {
    if (!selected.feedback) continue;
    const linked = selected.passages.filter((passage) => selected.feedback!.passage_ids.includes(passage.id));
    const intent = linked.find((passage) => passage.kind === "intent" && passage.unit);
    const observed = linked.find((passage) => (passage.kind === "record_excerpt" || passage.kind === "final_claim") && passage.unit);
    const eventIds = [...new Set(linked.flatMap((passage) => passage.event_ids))];
    const grounded = selected.feedback.classification === "wrong_units" && intent?.unit && observed?.unit && intent.unit.value !== observed.unit.value && eventIds.every((id) => selected.source_ids.some((sourceId) => byId.has(`${sourceId}/${id}`)));
    findings.push({ classification: selected.feedback.classification, status: grounded ? "selected_evidence_supports" : "owner_reported_not_established", case_id: selected.case_id, passage_ids: selected.feedback.passage_ids, event_ids: eventIds, trust: selected.trust });
  }
  return { event_count: events.length, timeline, partial_order: { layers, cyclic_or_conflicting_event_ids: [...remaining.keys()].map((key) => byId.get(key)!.event_id), wall_time_is_not_causal_order: true }, invocations, retries, durations, coverage: { selected_events: events.length, invocations: invocations.length, started_invocations: invocations.filter((item) => item.start === "observed").length, finished_invocations: invocations.filter((item) => item.finish === "observed").length, described_events: timeline.filter((item) => item.provenance !== "unknown").length, task_linked_invocations: invocations.filter((item) => item.task_linkage !== "unknown").length, gaps: [...gaps], conflicts: snapshot.conflicts }, findings, selected_cases: cases };
}
export async function reviewDiagnostics(store: DiagnosticStore, selection: DiagnosticSelection): Promise<DiagnosticReview> {
  const evidence = await resolveDiagnosticEvidence(store, selection);
  return { ...reviewDiagnosticSnapshot(evidence.snapshot, evidence.cases), expires_at: evidence.expires_at };
}
export interface DiagnosticComparison {
  comparable: boolean;
  reasons: string[];
  winner: null;
  interpretation: "independent_measures_no_overall_winner" | "incomparable";
  left: DiagnosticReview;
  right: DiagnosticReview;
  measures: { transport_attempts: { left: number; right: number }; record_reads: { left: number; right: number }; copy_steps: { left: number; right: number }; wall_time: "unknown"; tokens: "unknown"; cost: "unknown" };
}
export function compareDiagnosticReviews(left: DiagnosticReview, right: DiagnosticReview): DiagnosticComparison {
  const reasons: string[] = [];
  const leftCase = left.selected_cases.length === 1 ? left.selected_cases[0] : undefined;
  const rightCase = right.selected_cases.length === 1 ? right.selected_cases[0] : undefined;
  const l = leftCase?.equivalence, r = rightCase?.equivalence;
  if (!l || !r) reasons.push("fixture_task_equivalence_unknown");
  else {
    if (l.fixture_id !== r.fixture_id || l.fixture_revision !== r.fixture_revision) reasons.push("fixture_revision_mismatch");
    if (l.task_class !== r.task_class) reasons.push("task_class_mismatch");
    if (l.cache_state === "unknown" || r.cache_state === "unknown" || l.cache_state !== r.cache_state) reasons.push("cache_state_incomparable");
  }
  for (const review of [left, right]) {
    if (!review.event_count || review.coverage.started_invocations !== review.coverage.invocations || review.coverage.finished_invocations !== review.coverage.invocations) reasons.push("completion_coverage_incomplete");
    if (review.coverage.described_events !== review.coverage.selected_events) reasons.push("provenance_incomplete");
    if (review.timeline.some((node) => node.provenance_unknown_fields.some((field) => ["package", "version", "build_hash", "skill_revision", "rules_revision"].includes(field)))) reasons.push("revision_coverage_incomplete");
    if (review.coverage.conflicts.length || review.partial_order.cyclic_or_conflicting_event_ids.length || review.coverage.gaps.some((gap) => ["sequence_gap", "incomplete_tail", "sink_failure", "dropped_events", "coverage_unknown", "conflict", "expired_evidence"].includes(gap))) reasons.push("coverage_incomparable");
  }
  const count = (review: DiagnosticReview, predicate: (event: DiagnosticEvent) => boolean) => review.timeline.reduce((sum, node) => sum + Number(predicate(node.event)), 0);
  return { comparable: reasons.length === 0, reasons: [...new Set(reasons)], winner: null, interpretation: reasons.length ? "incomparable" : "independent_measures_no_overall_winner", left, right, measures: { transport_attempts: { left: count(left, (event) => event.type === "attempt.start" && event.layer === "transport"), right: count(right, (event) => event.type === "attempt.start" && event.layer === "transport") }, record_reads: { left: count(left, (event) => event.type === "attempt.start" && event.layer === "transport" && event.role === "record" && (event.action === "get" || event.action === "batchGet")), right: count(right, (event) => event.type === "attempt.start" && event.layer === "transport" && event.role === "record" && (event.action === "get" || event.action === "batchGet")) }, copy_steps: { left: count(left, (event) => event.type === "operation.step" && event.role === "copy"), right: count(right, (event) => event.type === "operation.step" && event.role === "copy") }, wall_time: "unknown", tokens: "unknown", cost: "unknown" } };
}
export async function compareDiagnostics(store: DiagnosticStore, left: DiagnosticSelection, right: DiagnosticSelection): Promise<DiagnosticComparison> {
  return compareDiagnosticReviews(await reviewDiagnostics(store, left), await reviewDiagnostics(store, right));
}
