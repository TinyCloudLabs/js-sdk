import { invokeOperation as invokeCoreOperation, type OperationResult } from "@tinycloud/operations";
import { invokeSecretsGetWithLocalAuthorityRetry as invokeCoreSecretsGetWithLocalAuthorityRetry } from "@tinycloud/operations/cli-runtime";
import { cliRegistryVerdictCache } from "./registry-verdict-cache.js";

/** CLI projection: share routing across canonical operations and legacy SDK nodes. */
export function invokeOperation(
  operationId: string,
  operationVersion: number,
  target: Parameters<typeof invokeCoreOperation>[2],
  input: unknown,
): Promise<OperationResult<unknown>> {
  return invokeCoreOperation(operationId, operationVersion, target, input, undefined, cliRegistryVerdictCache);
}

export function invokeSecretsGetWithLocalAuthorityRetry(target: Parameters<typeof invokeCoreOperation>[2], input: unknown): Promise<OperationResult<unknown>> {
  return invokeCoreSecretsGetWithLocalAuthorityRetry(target, input, cliRegistryVerdictCache);
}
