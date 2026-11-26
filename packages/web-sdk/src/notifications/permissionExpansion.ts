/**
 * sdk-core's permission expansion, for the prompt's derived line. In the built prompt chunk this module is replaced by
 * permissionExpansionBridge.ts, which takes the root bundle's own copy, so the chunk carries none of sdk-core (TC-4294).
 */
export { expandPermissionEntries } from "@tinycloud/sdk-core";
