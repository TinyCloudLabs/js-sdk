/**
 * Compute Service Module
 *
 * Deploys and executes WASM routines on TinyCloud (compute-service.md).
 */

export { ComputeService } from "./ComputeService";
export type { IComputeService } from "./IComputeService";
export {
  ComputeAction,
  type ComputeActionType,
  type ComputeServiceConfig,
  type ComputeDataGrant,
  type ComputeDeployOptions,
  type ComputeDeployResult,
  type ComputeExecuteOptions,
  type ComputeExecuteResult,
  type ComputeManifest,
  type ComputeManifestEntry,
} from "./types";
