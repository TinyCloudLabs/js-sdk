// RTMR3 replay adapted from TinyCloudLabs/openkey PR #491
// (packages/escrow-verify/src/internal.ts, `replay`), the TC-2823 escrow verifier.
// Changes: portable hashing (@noble/hashes instead of node:crypto); the
// `os-image-hash` and `key-provider` events are also read and bound to the boot
// order; event names with ':' are refused, as dstack's own replay does.
import { sha384 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { refuse } from "./errors.js";

/** One entry of a dstack event log, as the guest agent returns it. */
export interface DstackEvent {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
  version?: number;
}

export interface Replayed {
  /** Hex RTMR3 recomputed from the runtime events. */
  rtmr3: string;
  appId: string;
  composeHash: string;
  osImageHash: string;
  /** The `key-provider` payload as UTF-8: the KMS, and its root key, the CVM took its keys from. */
  keyProvider: string;
}

/** dstack's runtime event type (DSTACK_RUNTIME_EVENT_TYPE). */
const RUNTIME_EVENT = 0x08000001;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Replays the RTMR3 events of `log` and returns the register plus the app ID,
 * compose hash, OS image hash and key provider it measured. Each of those
 * events, and `boot-mr-done` and `system-ready`, must appear exactly once: app
 * ID and compose hash before `boot-mr-done`; the OS image hash and key provider
 * before `system-ready` (after it, the app itself can emit events). The caller
 * must compare `rtmr3` with the verified quote's RTMR3 before trusting any field.
 */
export function replayRtmr3(log: unknown): Replayed {
  if (!Array.isArray(log) || log.length === 0 || log.length > 100_000) refuse("event-log", "event log is not a non-empty list");
  let register: Uint8Array = new Uint8Array(48);
  const named = new Map<string, { index: number; payload: Uint8Array }[]>();
  for (const [index, e] of (log as DstackEvent[]).entries()) {
    if (!e || typeof e !== "object" || !Number.isInteger(e.imr) || e.imr < 0 || e.imr > 3) {
      refuse("event-log", `event ${index} has no valid register`);
    }
    if (e.imr !== 3) continue;
    if (e.event_type !== RUNTIME_EVENT || typeof e.event !== "string" || typeof e.event_payload !== "string" || !HEX.test(e.event_payload)) {
      refuse("event-log", `event ${index} is not a dstack runtime event`);
    }
    // The digest input is `:<name>:<payload>`, so a ':' in a name lets two different events hash alike.
    if (e.event.includes(":")) refuse("event-log", `event ${index} has a ':' in its name`);
    if (typeof e.digest !== "string") refuse("event-log", `event ${index} has no digest`);
    // Version 2 event logs are not supported yet; an OS that writes them is refused (README).
    if ((e.version ?? 1) !== 1) refuse("event-log", `event ${index} has unsupported version ${e.version}`);
    const payload = hexToBytes(e.event_payload);
    const type = new Uint8Array(4);
    new DataView(type.buffer).setUint32(0, RUNTIME_EVENT, true);
    const digest = sha384(concat(type, utf8ToBytes(`:${e.event}:`), payload));
    if (e.digest !== "" && e.digest.toLowerCase() !== bytesToHex(digest)) refuse("event-log", `event ${index} (${e.event}) digest does not match its payload`);
    register = sha384(concat(register, digest));
    named.set(e.event, [...(named.get(e.event) ?? []), { index, payload }]);
  }
  const one = (name: string) => {
    const entries = named.get(name);
    if (entries?.length !== 1) refuse("event-log", `event log must hold exactly one ${name} event`);
    return entries[0]!;
  };
  const app = one("app-id");
  const compose = one("compose-hash");
  const os = one("os-image-hash");
  const kms = one("key-provider");
  const boot = one("boot-mr-done");
  const ready = one("system-ready");
  if (app.index >= boot.index || compose.index >= boot.index || os.index >= ready.index || kms.index >= ready.index || ready.index <= boot.index) {
    refuse("event-log", "identity events are not measured in boot order");
  }
  let keyProvider: string;
  try {
    keyProvider = new TextDecoder("utf-8", { fatal: true }).decode(kms.payload);
  } catch {
    refuse("event-log", "key-provider payload is not UTF-8");
  }
  return {
    rtmr3: bytesToHex(register),
    appId: bytesToHex(app.payload),
    composeHash: bytesToHex(compose.payload),
    osImageHash: bytesToHex(os.payload),
    keyProvider,
  };
}
