/**
 * CLI projection seam. This subpath exposes only the registry-keyed
 * invocation shape; runtime construction and the local-owner retry remain
 * entirely inside operations.
 */
export { invokeOperationWithLocalAuthorityRetry } from "./invoke.js";
