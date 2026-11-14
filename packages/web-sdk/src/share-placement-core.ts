import {
  parseSpaceUri, exactHttpOrigin, validateLocationRecordV2Payload, decodeBase64Url,
  parseSignedSiweCacao, verifiedDelegationRouting, spaceIdsEqual,
  resolveOwnerHosts, RegistryUnavailableError,
} from "@tinycloud/sdk-core";

export const sharePlacementCore = Object.freeze({
  parseSpaceUri, exactHttpOrigin, validateLocationRecordV2Payload, decodeBase64Url,
  parseSignedSiweCacao, verifiedDelegationRouting, spaceIdsEqual,
  resolveOwnerHosts, RegistryUnavailableError,
});
