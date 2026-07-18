import type { OperationDefinition, OperationId } from "./contract.js";
import { authOperationDefinitions } from "./operations/auth.js";
import { explorationOperationDefinitions } from "./operations/exploration.js";
import { secretsGetOperationDefinitions } from "./operations/secrets-get.js";
import { sqlOperationDefinitions } from "./operations/sql.js";
import { statusOperationDefinitions } from "./operations/status.js";

export type OperationLookup =
  | Readonly<{ status: "found"; definition: OperationDefinition<any, any> }>
  | Readonly<{ status: "operation_not_found" }>
  | Readonly<{
      status: "operation_version_unsupported";
      supportedVersions: readonly number[];
    }>;

/**
 * The closed v1 catalog is assembled from internal definitions. There is no
 * exported registration hook for projections or a handler bypass API.
 */
let operationDefinitions: readonly OperationDefinition<any, any>[] | undefined;

function registeredOperationDefinitions(): readonly OperationDefinition<any, any>[] {
  // Auth handlers consult lookupOperation while executing. Lazy assembly keeps
  // that internal dependency out of the module-initialization cycle.
  operationDefinitions ??= [
    ...statusOperationDefinitions,
    ...authOperationDefinitions,
    ...explorationOperationDefinitions,
    ...sqlOperationDefinitions,
    ...secretsGetOperationDefinitions,
  ];
  return operationDefinitions;
}

/** Internal generator input; package exports prevent projection access. */
export function operationDefinitionsForCatalog(): readonly OperationDefinition<any, any>[] {
  return registeredOperationDefinitions();
}

export function lookupOperation(
  operationId: OperationId,
  operationVersion: number,
): OperationLookup {
  const matchingId = registeredOperationDefinitions().filter(
    (definition) => definition.id === operationId,
  );
  if (matchingId.length === 0) {
    return { status: "operation_not_found" };
  }

  const definition = matchingId.find(
    (candidate) => candidate.version === operationVersion,
  );
  if (definition === undefined) {
    return {
      status: "operation_version_unsupported",
      supportedVersions: matchingId.map((candidate) => candidate.version),
    };
  }

  return { status: "found", definition };
}
