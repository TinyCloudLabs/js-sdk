/**
 * IComputeService - Interface for the compute service.
 *
 * Platform-agnostic interface for deploying and executing WASM routines
 * (compute-service.md in tinycloud-node).
 */

import type { IService, Result } from "../types";
import type {
  ComputeServiceConfig,
  ComputeDeployOptions,
  ComputeDeployResult,
  ComputeExecuteOptions,
  ComputeExecuteResult,
} from "./types";

/**
 * Compute service interface.
 *
 * Two-layer permissioning (compute-service.md §6): `execute` only requires
 * `tinycloud.compute/execute` on the target function — the invoker gains no
 * data capability. `deploy` is a privileged, explicit-only operation that
 * mints the routine's own data grant (`D_fn`); it is never part of a
 * standard session's default abilities.
 */
export interface IComputeService extends IService {
  /**
   * Deploy a WASM function under `name`. Performs the full deploy sequence:
   * the `RoutineDid` handshake (learn the routine identity the node derives
   * for this WASM's content CID), mint a `D_fn` delegation carrying the
   * `computeFunctionBinding` caveat plus `options.dataGrants`, then submit
   * the deploy request (wasm bytes + `D_fn`) atomically.
   *
   * @param wasm - The WASM module bytes (or WAT text bytes for fixtures the
   *   node's `wat` feature accepts).
   * @param name - The `<function-path>` name to deploy under.
   * @param options - Data grants for the routine's own `D_fn`, and optional
   *   expiry/not-before/abort-signal.
   */
  deploy(
    wasm: Uint8Array,
    name: string,
    options: ComputeDeployOptions,
  ): Promise<Result<ComputeDeployResult>>;

  /**
   * Run a deployed function. The caller only needs
   * `tinycloud.compute/execute` on `<space>/compute/<name>` — the routine
   * reads/writes data under its own `D_fn`, never under the caller's
   * capabilities.
   *
   * @param name - The `<function-path>` name to execute.
   * @param input - Inline input JSON passed to the guest's `run` entrypoint.
   * @param options - Optional content-CID pin, output KV path, abort signal.
   */
  execute<T = unknown>(
    name: string,
    input: unknown,
    options?: ComputeExecuteOptions,
  ): Promise<Result<ComputeExecuteResult<T>>>;

  /**
   * Service configuration.
   */
  readonly config: ComputeServiceConfig;
}
