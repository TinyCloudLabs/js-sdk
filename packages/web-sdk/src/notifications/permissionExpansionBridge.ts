// Stands in for permissionExpansion.ts in the lazy build: the root bundle exports expandPermissionEntries, and the
// root has loaded before it loads the prompt chunk.
export { expandPermissionEntries } from "../index";
