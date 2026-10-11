import type { Unit } from "./common";
export interface BaselineMetric { unit: Unit; direction: "lower" | "higher"; stat: "p50" | "p95"; value: number; n: number; tolerance: number; floor: number; gaThreshold: number | null }
export interface Baseline { schema: "tc893.baseline/v1"; runnerClass: string; nodeImage: string; createdAt: string; speedConcurrency: 1; metrics: Record<string, BaselineMetric> }
