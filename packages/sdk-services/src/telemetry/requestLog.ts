/**
 * Developer request log core. Events are sanitized by `buildRequestEvent`, the
 * only constructor, which copies an allowlist of fields. Values, headers,
 * bodies, tokens, delegations, and error text have no field to land in.
 */

import { TelemetryEvents, type IServiceContext } from "../types";

export type RequestService =
  | "kv"
  | "sql"
  | "duckdb"
  | "hooks"
  | "vault"
  | "space"
  | "sync"
  | "other";

export interface RequestEvent {
  v: 1;
  /** Monotonic per RequestLog. */
  id: number;
  /** Request start, ms since epoch. */
  at: number;
  service: RequestService;
  /** `service/action`, e.g. `kv/get`; `other` when unknown. */
  op: string;
  /** Scrubbed key path, at most 256 chars; `secrets/` for secret keys. */
  path: string | null;
  /** Tail label of the space id, never the id. */
  space: string | null;
  /** URL host[:port] only. */
  host: string | null;
  /** Body bytes for writes, response bytes for reads; null when unknown. */
  bytes: number | null;
  /** Whole logical request, including retry backoff. */
  durationMs: number;
  attempts: number;
  ok: boolean;
  code: string;
  source: "network" | "replica";
}

/** A sanitized event before the log assigns its id. */
export type RequestDraft = Omit<RequestEvent, "id">;

export interface RequestLogReader {
  /** Copy, oldest first. */
  snapshot(): readonly RequestEvent[];
  subscribe(cb: (event: RequestEvent) => void): () => void;
  onClear(cb: () => void): () => void;
}

export interface RequestSink {
  record(event: RequestDraft): void;
}

/** Raw facts about one logical request. Only `buildRequestEvent` reads them. */
export interface RawRequest {
  service?: string;
  op?: string;
  /** Unscrubbed key path. */
  path?: string | null;
  /** Full space id; only its tail label is kept. */
  spaceId?: string | null;
  url?: string | null;
  bytes?: number | null;
  durationMs: number;
  attempts?: number;
  ok: boolean;
  code?: string;
  source?: string;
  at: number;
}

const RING_SIZE = 500;
const MAX_PATH = 256;
const SECRETS_PATH = "secrets/";
const REDACTED = "[redacted]";

const SERVICES: Record<string, true> = {
  kv: true,
  sql: true,
  duckdb: true,
  hooks: true,
  vault: true,
  space: true,
  sync: true,
};
const OP_SHAPE = /^[a-z]+\/[A-Za-z]+$/;
const SPACE_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CODE_SHAPE = /^(ok|HTTP_[1-5]\d\d|[A-Z][A-Z0-9_]{1,63}|ERROR)$/;
const OPAQUE_RUN = /[A-Za-z0-9_+=-]{32,}/g;

function scrubSegment(segment: string): string {
  if (segment.startsWith("did:key:")) return "did:key:…";
  if (segment.startsWith("eyJ") || /0x[0-9a-fA-F]{8}/.test(segment)) return REDACTED;
  for (const run of segment.match(OPAQUE_RUN) ?? []) {
    if (/\d/.test(run) && /[A-Za-z]/.test(run)) return REDACTED;
  }
  return segment;
}

function scrubPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.split(/[?#]/, 1)[0] ?? "";
  if (bare === "") return null;
  const out = bare.split("/").map(scrubSegment).join("/");
  return out.length > MAX_PATH ? out.slice(0, MAX_PATH) : out;
}

function isSecretKey(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const key = raw.replace(/^\/+/, "");
  return key === "secrets" || key.startsWith("secrets/");
}

function spaceLabel(spaceId: string | null | undefined): string | null {
  if (typeof spaceId !== "string" || spaceId === "") return null;
  const tail = spaceId.slice(spaceId.lastIndexOf(":") + 1);
  return SPACE_LABEL.test(tail) ? tail : "space";
}

function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** UTF-8 byte length of a request body without consuming it; null when unknown. */
export function byteLengthOf(body: unknown): number | null {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/** What the signing path knows about a request; read back by the fetch layer. */
export interface InvocationMeta {
  service: string;
  path: string;
  action: string;
  spaceId?: string | null;
}

const invocationMeta = new WeakMap<object, InvocationMeta>();

/** Called only when a sink is set, so developer-off code never writes here. */
export function rememberInvocation(headers: object, meta: InvocationMeta): void {
  invocationMeta.set(headers, meta);
}

/** Copies metadata onto headers rebuilt from signed headers (per retry attempt). */
export function carryInvocationMeta(from: object, to: object): void {
  const meta = invocationMeta.get(from);
  if (meta !== undefined) invocationMeta.set(to, meta);
}

export function invocationMetaOf(headers: unknown): InvocationMeta | undefined {
  return typeof headers === "object" && headers !== null ? invocationMeta.get(headers) : undefined;
}

export function buildRequestEvent(raw: RawRequest): RequestDraft {
  const service: RequestService =
    raw.service !== undefined && SERVICES[raw.service] === true
      ? (raw.service as RequestService)
      : "other";
  const space = spaceLabel(raw.spaceId);
  const secret = service === "vault" || space === "secrets" || isSecretKey(raw.path);
  const op = typeof raw.op === "string" && OP_SHAPE.test(raw.op) ? raw.op : "other";
  const code =
    raw.code === undefined ? (raw.ok ? "ok" : "ERROR") : CODE_SHAPE.test(raw.code) ? raw.code : "ERROR";
  const bytes =
    typeof raw.bytes === "number" && Number.isFinite(raw.bytes) && raw.bytes >= 0
      ? Math.floor(raw.bytes)
      : null;
  return {
    v: 1,
    at: raw.at,
    service,
    op,
    path: secret ? SECRETS_PATH : scrubPath(raw.path),
    space: secret && space === null ? "secrets" : space,
    host: hostOf(raw.url),
    bytes,
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : 0,
    attempts:
      raw.attempts !== undefined && Number.isFinite(raw.attempts) && raw.attempts >= 1
        ? Math.floor(raw.attempts)
        : 1,
    ok: raw.ok === true,
    code,
    source: raw.source === "replica" ? "replica" : "network",
  };
}

/**
 * Maps replica-served KV reads (`replication.read` with `source: "replica"`) to
 * request events. Network reads and replication writes are not mapped here:
 * their wire requests are recorded by the fetch layer.
 */
export function observeReplicaReads(context: IServiceContext, sink: RequestSink): () => void {
  return context.on(TelemetryEvents.REPLICATION_READ, (data: unknown) => {
    try {
      const read = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      if (read.source !== "replica") return;
      sink.record(
        buildRequestEvent({
          service: "kv",
          op: `kv/${String(read.op)}`,
          path: typeof read.key === "string" ? read.key : null,
          spaceId: typeof read.space === "string" ? read.space : null,
          url: null,
          bytes: null,
          durationMs: typeof read.latencyMs === "number" ? read.latencyMs : 0,
          attempts: 1,
          ok: read.outcome !== "error",
          code: read.outcome === "not_found" ? "KV_NOT_FOUND" : typeof read.code === "string" ? read.code : undefined,
          source: "replica",
          at: Date.now(),
        }),
      );
    } catch {
      // Observability must not affect KV behavior.
    }
  });
}

type Listener<T extends unknown[]> = (...args: T) => void;

/** Fixed-size in-memory ring of sanitized events. Lost on reload by design (v1). */
export class RequestLog implements RequestSink, RequestLogReader {
  readonly #slots: (RequestEvent | undefined)[] = new Array(RING_SIZE);
  #head = 0;
  #count = 0;
  #nextId = 1;
  readonly #subscribers = new Set<Listener<[RequestEvent]>>();
  readonly #clearListeners = new Set<Listener<[]>>();

  record(draft: RequestDraft): void {
    const event: RequestEvent = {
      v: 1,
      id: this.#nextId++,
      at: draft.at,
      service: draft.service,
      op: draft.op,
      path: draft.path,
      space: draft.space,
      host: draft.host,
      bytes: draft.bytes,
      durationMs: draft.durationMs,
      attempts: draft.attempts,
      ok: draft.ok,
      code: draft.code,
      source: draft.source,
    };
    this.#slots[this.#head] = event;
    this.#head = (this.#head + 1) % RING_SIZE;
    if (this.#count < RING_SIZE) this.#count++;
    for (const cb of this.#subscribers) {
      try {
        cb(event);
      } catch {
        // A failing subscriber must not break the request path or other subscribers.
      }
    }
  }

  snapshot(): RequestEvent[] {
    const start = this.#count < RING_SIZE ? 0 : this.#head;
    const out: RequestEvent[] = [];
    for (let i = 0; i < this.#count; i++) {
      out.push(this.#slots[(start + i) % RING_SIZE]!);
    }
    return out;
  }

  subscribe(cb: (event: RequestEvent) => void): () => void {
    this.#subscribers.add(cb);
    return () => {
      this.#subscribers.delete(cb);
    };
  }

  onClear(cb: () => void): () => void {
    this.#clearListeners.add(cb);
    return () => {
      this.#clearListeners.delete(cb);
    };
  }

  clear(): void {
    this.#slots.fill(undefined);
    this.#head = 0;
    this.#count = 0;
    for (const cb of this.#clearListeners) {
      try {
        cb();
      } catch {
        // Isolated like subscribers.
      }
    }
  }
}
