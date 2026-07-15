/** A reachable node returned an HTTP failure for a decrypt request. */
export interface DecryptTransportResponseError extends Error {
  readonly status: number;
}

type DecryptTransportResponseErrorConstructor = {
  new (status: number): DecryptTransportResponseError;
  readonly prototype: DecryptTransportResponseError;
};

// Root and `/encryption` entrypoints are independently bundled in both module
// formats. Store the constructor, rather than a marker on each error, so all
// entrypoints share normal class identity and `instanceof` semantics.
const sharedConstructorKey = Symbol.for(
  "@tinycloud/sdk-services/DecryptTransportResponseError.constructor",
);

function createConstructor(): DecryptTransportResponseErrorConstructor {
  return class DecryptTransportResponseError extends Error {
    constructor(readonly status: number) {
      super("Node decrypt request failed");
      this.name = "DecryptTransportResponseError";
    }
  };
}

function getSharedConstructor(): DecryptTransportResponseErrorConstructor {
  const registry = globalThis as Record<PropertyKey, unknown>;
  const existing = registry[sharedConstructorKey];
  if (typeof existing === "function" && existing.prototype instanceof Error) {
    return existing as DecryptTransportResponseErrorConstructor;
  }

  const constructor = createConstructor();
  Object.defineProperty(registry, sharedConstructorKey, {
    configurable: false,
    enumerable: false,
    value: constructor,
    writable: false,
  });
  return constructor;
}

export const DecryptTransportResponseError = getSharedConstructor();
