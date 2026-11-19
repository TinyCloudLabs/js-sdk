// Source tests use the implementation modules; the built placement entry shares the public Core root.
export { parseSpaceUri } from "./spaces/SpaceService";
export { exactHttpOrigin, validateLocationRecordV2Payload } from "./location";
export { decodeBase64Url } from "./credentials/digest";
export { parseSignedSiweCacao } from "./delegations/cacao";
export { verifiedDelegationRouting, spaceIdsEqual } from "./delegations/portable";
export { resolveOwnerHosts, RegistryUnavailableError, type ResolveOwnerHostsOptions } from "./registry-policy";
