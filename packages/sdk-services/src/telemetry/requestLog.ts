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
  /** `first/` of the key (`[redacted]` when unsafe or slashless); full key only for allowlisted first segments. */
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
const REDACTED = "[redacted]";

const SERVICE_NAME = /^(kv|sql|duckdb|hooks|vault|space|sync)$/;
const OP_SHAPE = /^[a-z]+\/[A-Za-z]+$/;
const SPACE_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CODE_SHAPE = /^(ok|HTTP_[1-5]\d\d|[A-Z][A-Z0-9_]{1,63}|ERROR)$/;
const PATH_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** First segments whose full key may be recorded. Empty: only `first/` is ever kept. */
const PATH_ALLOWLIST: ReadonlySet<string> = new Set<string>();

function scrubPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.split(/[?#]/, 1)[0] ?? "";
  if (bare === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return REDACTED;
  }
  const stripped = decoded.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (stripped === "") return null;
  const slash = stripped.indexOf("/");
  // Slashless: the whole value may be a bare secret name.
  if (slash === -1) return REDACTED;
  const first = stripped.slice(0, slash).toLowerCase();
  if (!PATH_LABEL.test(first)) return REDACTED;
  if (PATH_ALLOWLIST.has(first)) return stripped.length > MAX_PATH ? stripped.slice(0, MAX_PATH) : stripped;
  return `${first}/`;
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

/** Response Content-Length as bytes; null unless the header is plain digits (blank, signed, or exponent forms are unknown). */
export function declaredLengthOf(header: string | null | undefined): number | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
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
    raw.service !== undefined && SERVICE_NAME.test(raw.service)
      ? (raw.service as RequestService)
      : "other";
  const space = spaceLabel(raw.spaceId);
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
    path: scrubPath(raw.path),
    space,
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
    const event: RequestEvent = { ...draft, id: this.#nextId++ };
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
