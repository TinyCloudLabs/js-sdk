import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DiagnosticStore } from "./storage.js";
import { DETAIL_RETENTION_MS, METADATA_RETENTION_MS } from "./model.js";
import { resolveDiagnosticEvidence } from "./bundles.js";
import { DiagnosticError, privateRead, withPrivateDirectory } from "./filesystem.js";

export const DETAIL_LIMIT = 1024 * 1024;
export class DiagnosticInputError extends Error {
  constructor(code: "invalid_input" | "unsafe_path" | "input_limit" | "credential_content" | "expired" | "detail_policy_required" | "missing_evidence" | "integrity_failure" = "invalid_input") {
    super(`diagnostics: ${code}`);
    this.name = "DiagnosticInputError";
  }
}
export function fail(): never { throw new DiagnosticInputError(); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !("value" in item))) return fail();
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail();
  return value;
}
export function ids(value: unknown, limit = 4096): string[] {
  if (!Array.isArray(value) || value.length > limit) return fail();
  return [...new Set(value.map(uuid))];
}
export function utc(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail();
  return value;
}
export function unexpired(value: unknown, now = Date.now()): string {
  const result = utc(value);
  if (Date.parse(result) <= now) throw new DiagnosticInputError("expired");
  return result;
}
export function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return fail();
  return value as T;
}
export function assertDiagnosticInputPath(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || path.length > 4096 || path.split(/[\\/]/).includes("..")) throw new DiagnosticInputError("unsafe_path");
  return resolve(path);
}
/** Exact private owner inputs, pinned ancestors and bounded reads; no raw OS errors. */
export async function readDiagnosticFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const full = assertDiagnosticInputPath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new DiagnosticInputError("input_limit");
  try {
    return await withPrivateDirectory(dirname(full), false, async (directory) => {
      const bytes = await privateRead(join(directory.path, basename(full)), maxBytes);
      await directory.assertStable();
      return bytes;
    });
  } catch (error) {
    if (error instanceof DiagnosticInputError) throw error;
    throw new DiagnosticInputError(error instanceof DiagnosticError && error.code === "quota" ? "input_limit" : "unsafe_path");
  }
}
export function parseDiagnosticJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Native parsing checks the complete grammar. Scan its valid token stream as in
    // sdk-core's share-envelope parser, retaining decoded keys before duplicates disappear.
    const value: unknown = JSON.parse(text);
    const objects: Set<string>[] = [];
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "{") objects.push(new Set());
      else if (text[index] === "}") objects.pop();
      else if (text[index] === '"') {
        const start = index++;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === "\\") index++;
          index++;
        }
        const end = index + 1;
        let next = end;
        while (text[next] === " " || text[next] === "\t" || text[next] === "\r" || text[next] === "\n") next++;
        if (text[next] === ":") {
          const key: string = JSON.parse(text.slice(start, end));
          const keys = objects.at(-1);
          if (!keys || keys.has(key)) return fail();
          keys.add(key);
        }
      }
    }
    return value;
  } catch { return fail(); }
}
export async function readDiagnosticJsonFile(path: string, maxBytes = 65536): Promise<unknown> {
  return parseDiagnosticJson(await readDiagnosticFile(path, maxBytes));
}

// This is rejection, not redaction or a promise that arbitrary text is safe.
const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:bearer|basic)\s+[a-z0-9+/_=-]{8,}|\b(?:authorization|proxy-authorization|cookie|set-cookie|host|user-agent|x-api-key)\s*:|\b(?:private[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret[_ -]?(?:access[_ -]?)?key|password|passphrase|authorization[_ -]?code|device[_ -]?code|mnemonic|seed[_ -]?phrase|session[_ -]?key)\b|\b(?:headers|profiles|sessions)["']?\s*[:=]\s*[{[]|\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b|\b(?:0x)?[a-f0-9]{64}\b)/i;
export function rejectDiagnosticCredentials(text: string): void {
  if (Buffer.byteLength(text) > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
  let variants = [text];
  let budget = DETAIL_LIMIT * 8;
  for (let depth = 0; depth < 4; depth++) {
    const next: string[] = [];
    for (const variant of variants) {
      if (credential.test(variant)) throw new DiagnosticInputError("credential_content");
      const normalized = variant.normalize("NFKC").replace(/[\u200b-\u200f\ufeff]/g, "");
      if (normalized !== variant) next.push(normalized);
      try { const decoded = decodeURIComponent(variant); if (decoded !== variant) next.push(decoded); } catch { /* non-URI selected prose */ }
      const escaped = variant.replace(/\\u([a-f0-9]{4})|\\x([a-f0-9]{2})|&#(?:x([a-f0-9]+)|(\d+));/gi, (_all, u, x, h, d) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(u ?? x ?? h ?? d, d ? 10 : 16))));
      if (escaped !== variant) next.push(escaped);
      for (const match of variant.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
        next.push(Buffer.from(match[0], "base64").toString("utf8"));
        if (/^(?:[0-9a-f]{2}){8,}$/i.test(match[0])) next.push(Buffer.from(match[0], "hex").toString("utf8"));
      }
    }
    variants = [...new Set(next)];
    budget -= variants.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
    if (budget < 0) throw new DiagnosticInputError("input_limit");
  }
  if (variants.some((variant) => credential.test(variant))) throw new DiagnosticInputError("credential_content");
}

export interface SelectedPassage {
  id: string;
  kind: "intent" | "action" | "final_claim" | "record_excerpt" | "catalog_excerpt" | "feedback";
  origin: "owner" | "visible_client" | "selected_record" | "selected_catalog";
  text: string;
  event_ids: string[];
  unit?: { value: "U1" | "U2"; start: number; end: number };
}
export interface SelectedDiagnosticCase {
  schema_version: 1;
  case_id: string;
  created_at: string;
  expires_at: string;
  purpose: "task_review" | "comparison" | "synthetic_reproduction";
  owner_selected: true;
  no_secrets_or_unrelated_content: true;
  detail_policy: "encrypted-excluded-backups";
  event_ids: string[];
  source_ids: string[];
  passages: SelectedPassage[];
  feedback?: { classification: "wrong_units" | "wrong_kind" | "unverified_claim" | "excess_work" | "accepted"; passage_ids: string[] };
  equivalence?: { fixture_id: string; fixture_revision: string; task_class: "record_write_readback" | "record_read" | "record_move" | "copy_check"; cache_state: "cold" | "warm" | "unknown" };
  trust: "owner_reported" | "imported_assertion";
}
export function validateSelectedDiagnosticCase(value: unknown, now = Date.now()): SelectedDiagnosticCase {
  const input = object(value);
  keys(input, ["schema_version", "case_id", "created_at", "expires_at", "purpose", "owner_selected", "no_secrets_or_unrelated_content", "detail_policy", "event_ids", "source_ids", "passages", "feedback", "equivalence", "trust"]);
  if (input.schema_version !== 1 || input.owner_selected !== true || input.no_secrets_or_unrelated_content !== true || input.detail_policy !== "encrypted-excluded-backups") return fail();
  const created = utc(input.created_at), expiry = unexpired(input.expires_at, now);
  if (Date.parse(created) > now || Date.parse(expiry) > Date.parse(created) + DETAIL_RETENTION_MS) return fail();
  if (!Array.isArray(input.passages) || !input.passages.length || input.passages.length > 64) return fail();
  const eventIds = ids(input.event_ids);
  if (!eventIds.length) return fail();
  let total = 0;
  const passages = input.passages.map((raw): SelectedPassage => {
    const p = object(raw); keys(p, ["id", "kind", "origin", "text", "event_ids", "unit"]);
    if (typeof p.text !== "string" || !p.text.length || (total += Buffer.byteLength(p.text)) > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
    rejectDiagnosticCredentials(p.text);
    const linked = ids(p.event_ids);
    if (!linked.length || linked.some((id) => !eventIds.includes(id))) return fail();
    const result: SelectedPassage = { id: uuid(p.id), kind: oneOf(p.kind, ["intent", "action", "final_claim", "record_excerpt", "catalog_excerpt", "feedback"]), origin: oneOf(p.origin, ["owner", "visible_client", "selected_record", "selected_catalog"]), text: p.text, event_ids: linked };
    if (p.unit !== undefined) {
      const unit = object(p.unit); keys(unit, ["value", "start", "end"]);
      if (!Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || (unit.start as number) < 0 || (unit.end as number) > p.text.length || (unit.end as number) <= (unit.start as number)) return fail();
      const value = oneOf(unit.value, ["U1", "U2"]);
      if (p.text.slice(unit.start as number, unit.end as number) !== value) return fail();
      result.unit = { value, start: unit.start as number, end: unit.end as number };
    }
    return result;
  });
  if (new Set(passages.map((p) => p.id)).size !== passages.length) return fail();
  const result: SelectedDiagnosticCase = { schema_version: 1, case_id: uuid(input.case_id), created_at: created, expires_at: expiry, purpose: oneOf(input.purpose, ["task_review", "comparison", "synthetic_reproduction"]), owner_selected: true, no_secrets_or_unrelated_content: true, detail_policy: "encrypted-excluded-backups", event_ids: eventIds, source_ids: ids(input.source_ids), passages, trust: oneOf(input.trust, ["owner_reported", "imported_assertion"]) };
  if (input.feedback !== undefined) {
    const feedback = object(input.feedback); keys(feedback, ["classification", "passage_ids"]);
    const refs = ids(feedback.passage_ids, 64);
    if (!refs.length || refs.some((id) => !passages.some((p) => p.id === id))) return fail();
    result.feedback = { classification: oneOf(feedback.classification, ["wrong_units", "wrong_kind", "unverified_claim", "excess_work", "accepted"]), passage_ids: refs };
  }
  if (input.equivalence !== undefined) {
    const eq = object(input.equivalence); keys(eq, ["fixture_id", "fixture_revision", "task_class", "cache_state"]);
    if (typeof eq.fixture_revision !== "string" || !/^[a-f0-9]{64}$/.test(eq.fixture_revision)) return fail();
    result.equivalence = { fixture_id: uuid(eq.fixture_id), fixture_revision: eq.fixture_revision, task_class: oneOf(eq.task_class, ["record_write_readback", "record_read", "record_move", "copy_check"]), cache_state: oneOf(eq.cache_state, ["cold", "warm", "unknown"]) };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > DETAIL_LIMIT) throw new DiagnosticInputError("input_limit");
  return result;
}
export async function selectDiagnosticCase(store: DiagnosticStore, manifestPath: string): Promise<{ case_id: string; expires_at: string; trust: "owner_reported" }> {
  if (!(await store.status()).detail_allowed) throw new DiagnosticInputError("detail_policy_required");
  const raw = object(await readDiagnosticJsonFile(manifestPath, DETAIL_LIMIT));
  // Intake supplies neither trusted identity nor an import's retention refresh.
  keys(raw, ["schema_version", "expires_at", "purpose", "owner_selected", "no_secrets_or_unrelated_content", "detail_policy", "event_ids", "passages", "feedback", "equivalence"]);
  const eventIds = ids(raw.event_ids);
  const evidence = await resolveDiagnosticEvidence(store, { event_ids: eventIds });
  const snapshot = evidence.snapshot;
  if (!eventIds.length || eventIds.some((id) => !snapshot.events.some((event) => event.event_id === id))) throw new DiagnosticInputError("missing_evidence");
  const now = Date.now();
  const sourceExpiry = Math.min(Date.parse(evidence.expires_at), ...snapshot.events.map((event) => Date.parse(event.occurred_at) + METADATA_RETENTION_MS));
  const selected = validateSelectedDiagnosticCase({ ...raw, case_id: randomUUID(), created_at: new Date(now).toISOString(), expires_at: new Date(Math.min(Date.parse(utc(raw.expires_at)), now + DETAIL_RETENTION_MS, sourceExpiry)).toISOString(), source_ids: [...new Set(snapshot.events.map((event) => event.source_id))], trust: "owner_reported" }, now);
  await store.putManaged("cases", selected.case_id, { "detail.json": JSON.stringify(selected) }, { expires_at: selected.expires_at, source_ids: selected.source_ids, event_ids: selected.event_ids, case_ids: [selected.case_id], detail: true }, { generation: evidence.generation });
  return { case_id: selected.case_id, expires_at: selected.expires_at, trust: "owner_reported" };
}
