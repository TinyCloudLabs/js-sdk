/**
 * Compute Service Types
 *
 * Type definitions for the compute service operations.
 *
 * Wire format is cross-referenced against tinycloud-node's
 * `tinycloud-node-server/src/routes/mod.rs` (`handle_compute_routine_did`,
 * `handle_compute_deploy`, `handle_compute_execute`) and
 * `tinycloud-core/src/compute.rs` (`ComputeRequest`, `Manifest`,
 * `ManifestEntry`) — see specs/compute-service.md §5.1/§6.2/§7/§9.1.1 in the
 * tinycloud-node repo for the full design.
 */

import { COMPUTE } from "@tinycloud/bootstrap";

/**
 * Configuration for ComputeService.
 */
export interface ComputeServiceConfig {
  /**
   * Default timeout in milliseconds for compute operations.
   */
  timeout?: number;

  /** Allow additional config properties */
  [key: string]: unknown;
}

/**
 * One (service, path, ability) grant line for the deploy-time `D_fn` data
 * grant (compute-service.md §5.1/§6.2). `service`/`path` name a resource
 * exactly like a normal delegation (e.g. `{ service: "kv", path: "in/",
 * ability: "tinycloud.kv/get" }`); `ability` is the full URN.
 */
export interface ComputeDataGrant {
  service: string;
  path: string;
  ability: string;
}

/**
 * Options for `ComputeService.deploy`.
 */
export interface ComputeDeployOptions {
  /**
   * The data grants the deployed routine receives under its OWN `D_fn`
   * delegation — the invoker of `compute/execute` receives none of these
   * (compute-service.md §6, the two-layer permissioning model).
   */
  dataGrants: ComputeDataGrant[];

  /**
   * `D_fn` expiration, seconds since epoch. Defaults to ~10 years out (a
   * deploy-time grant is meant to outlive ordinary sessions; re-deploy
   * mints a fresh one).
   */
  expirationSecs?: number;

  /** Optional `D_fn` not-before, seconds since epoch. */
  notBeforeSecs?: number;

  /** Custom abort signal for this operation. */
  signal?: AbortSignal;
}

/**
 * Result of `ComputeService.deploy`.
 */
export interface ComputeDeployResult {
  /** The deployed function's content CID (also its content-addressed identity). */
  functionCid: string;
  /** The routine's own DID — the delegatee of the minted `D_fn`. */
  routineDid: string;
  /** The `<function-path>` name the WASM was deployed under. */
  function: string;
  /** Monotonically increasing artifact revision for this `(space, function)`. */
  revision: number;
  /** Content CID of a superseded deploy, when a re-deploy revoked a prior `D_fn`. */
  supersededContentCid: string | null;
  /** CID of the `D_fn` revoked as a result of re-deploy hygiene, if any. */
  supersededGrant: string | null;
}

/**
 * Options for `ComputeService.execute`.
 */
export interface ComputeExecuteOptions {
  /**
   * Optional exact content CID to pin — defends against a re-deploy race
   * between resolving the function name and this execute request.
   */
  contentCid?: string;

  /**
   * Optional output KV path. When present, the result is written there
   * (under the routine's own grant) instead of returned inline
   * (compute-service.md §8).
   */
  outputRef?: string;

  /** Custom abort signal for this operation. */
  signal?: AbortSignal;
}

/** A single host-call journal entry (compute-service.md §9.1.1). */
export interface ComputeManifestEntry {
  resource: string;
  ability: string;
  bytesIn: number;
  bytesOut: number;
  /** `"inline"` for reads/SQL, or the KV path written/deleted. */
  destination: string;
  granted: boolean;
}

/**
 * The full execution manifest: the per-call journal plus the
 * granted-vs-exercised capability sets (compute-service.md §9.1.1) — the
 * scope-down signal for tightening `D_fn` on the next deploy.
 */
export interface ComputeManifest {
  calls: ComputeManifestEntry[];
  /** Distinct ability URNs granted by the selected `D_fn`(s). */
  granted: string[];
  /** Distinct ability URNs that appeared in at least one successful call. */
  exercised: string[];
}

/** Result of `ComputeService.execute`. */
export interface ComputeExecuteResult<T = unknown> {
  /** The function's content CID that actually ran. */
  functionCid: string;
  /** The guest's returned result value. */
  result: T;
  /** The execution manifest (§9.1.1). */
  manifest: ComputeManifest;
  /**
   * Ability URNs granted by `D_fn` but never exercised during this run — the
   * concrete scope-down signal.
   */
  grantedButUnexercised: string[];
  /** KV path the result was written to, when `outputRef` was set; otherwise `null`. */
  outputDestination: string | null;
  /** Execution backend metadata (e.g. `{ mode: "in-node", backend: "wasmtime" }`). */
  verification: { mode: string; backend: string };
}

/**
 * Compute service action types.
 *
 * URNs derive from the canonical capability registry in `@tinycloud/bootstrap`
 * (TC-112 single source of truth, vendored from tinycloud-node).
 *
 * `EXECUTE` is the only ability a standard session may enumerate — `DEPLOY`
 * is a privileged, explicit-only capability never granted by default
 * (compute-service.md §12.1 F9), and `LIST`/`ALL` have no server-side
 * handler wired yet (`list` is registry status "reserved").
 */
export const ComputeAction = {
  EXECUTE: COMPUTE.EXECUTE,
  DEPLOY: COMPUTE.DEPLOY,
  LIST: COMPUTE.LIST,
  ALL: COMPUTE.ALL,
} as const;

export type ComputeActionType = (typeof ComputeAction)[keyof typeof ComputeAction];

/** Raw wire response of the `routine_did` handshake action. */
export interface ComputeRoutineDidWireResponse {
  routine_did: string;
  content_cid: string;
  space: string;
}

/** Raw wire response of a `deploy` action. */
export interface ComputeDeployWireResponse {
  function: string;
  content_cid: string;
  routine_did: string;
  revision: number;
  superseded_content_cid: string | null;
  superseded_grant: string | null;
}

/** Raw wire response of an `execute` action. */
export interface ComputeExecuteWireResponse {
  function: string;
  content_cid: string;
  result: unknown;
  manifest: ComputeManifest;
  grantedButUnexercised: string[];
  output_destination: string | null;
  verification: { mode: string; backend: string };
}
