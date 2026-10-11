import type { CallOptions } from "./common";
export type ToxicStream = "upstream" | "downstream";
export type ToxicSpec =
  | { type: "latency"; latencyMs: number; jitterMs?: number; stream?: ToxicStream; toxicity?: number }
  | { type: "bandwidth"; rateKBps: number; stream?: ToxicStream; toxicity?: number }
  | { type: "reset_peer"; timeoutMs: number; stream?: ToxicStream; toxicity?: number }
  | { type: "limit_data"; bytes: number; stream?: ToxicStream; toxicity?: number }
  | { type: "timeout"; timeoutMs: number; stream?: ToxicStream; toxicity?: number }
  | { type: "slow_close"; delayMs: number; stream?: ToxicStream; toxicity?: number };
export interface ProxyHandle { readonly name: string; readonly listenUrl: string; disable(o?: CallOptions): Promise<void>; enable(o?: CallOptions): Promise<void>; addToxic(t: ToxicSpec, o?: CallOptions): Promise<string>; removeToxic(name: string, o?: CallOptions): Promise<void>; clear(o?: CallOptions): Promise<void>; state(o?: CallOptions): Promise<{ enabled: boolean; toxics: (ToxicSpec & { name: string })[] }> }
export type FaultMode =
  | { kind: "ambiguous"; urlPattern: string; methods?: string[]; times?: number }
  | { kind: "hold"; urlPattern: string; holdMs: number; selfSignal?: "SIGINT"; times?: number }
  | { kind: "fail"; urlPattern: string; times?: number };
export interface FaultFile { v: 1; faults: FaultMode[]; countFile?: string }
export interface CountedRequest { v: 1; pid: number; wallMs: number; method: string; url: string; status: number | null; fault?: FaultMode["kind"] }
