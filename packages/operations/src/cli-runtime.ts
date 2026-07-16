import type { InvocationTarget, OperationResult } from "./contract.js";
import { invokeOperationWithLocalAuthorityRetry } from "./invoke.js";

/**
 * The only published CLI acquisition helper. Its fixed operation identity is
 * deliberate: adding a future registry operation cannot expand this seam.
 */
export function invokeSecretsGetWithLocalAuthorityRetry(
  invocationTarget: InvocationTarget,
  unknownInput: unknown,
): Promise<OperationResult<unknown>> {
  return invokeOperationWithLocalAuthorityRetry(
    "tinycloud.secrets.get",
    1,
    invocationTarget,
    unknownInput,
  );
}
