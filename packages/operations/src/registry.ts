import type { OperationDefinition, OperationId } from "./contract.js";

export type OperationLookup =
  | Readonly<{ status: "found"; definition: OperationDefinition<unknown, unknown> }>
  | Readonly<{ status: "operation_not_found" }>
  | Readonly<{
      status: "operation_version_unsupported";
      supportedVersions: readonly number[];
    }>;

/**
 * I1 intentionally has no registered operations. Later increments add internal
 * definitions here; there is no exported registration hook for projections.
 */
const operationDefinitions: readonly OperationDefinition<unknown, unknown>[] = [];

/** Internal generator input; package exports prevent projection access. */
export function operationDefinitionsForCatalog(): readonly OperationDefinition<unknown, unknown>[] {
  return operationDefinitions;
}

export function lookupOperation(
  operationId: OperationId,
  operationVersion: number,
): OperationLookup {
  const matchingId = operationDefinitions.filter(
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
