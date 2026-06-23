import type { ClientSession, PersistedSessionData } from "@tinycloud/sdk-core";

export interface RestorableSessionData {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  jwk: object;
  verificationMethod: string;
  address: string;
  chainId: number;
  siwe: string;
  signature: string;
  /**
   * Hosts the session was created against. Absent for sessions persisted
   * before this field existed; in that case the node re-resolves lazily.
   */
  tinycloudHosts?: string[];
}

export function clientSessionFromPersisted(
  data: PersistedSessionData,
): ClientSession {
  return {
    address: data.address,
    walletAddress: data.address,
    chainId: data.chainId,
    sessionKey: data.sessionKey,
    siwe: data.siwe,
    signature: data.signature,
  };
}

export function restoreDataFromPersisted(
  data: PersistedSessionData,
): RestorableSessionData {
  if (!data.tinycloudSession) {
    throw new Error("Persisted session is missing TinyCloud delegation data.");
  }

  let jwk: object;
  try {
    jwk = JSON.parse(data.sessionKey) as object;
  } catch {
    throw new Error("Persisted session has an invalid session key.");
  }

  if (jwk === null || typeof jwk !== "object") {
    throw new Error("Persisted session has an invalid session key.");
  }

  return {
    delegationHeader: data.tinycloudSession.delegationHeader,
    delegationCid: data.tinycloudSession.delegationCid,
    spaceId: data.tinycloudSession.spaceId,
    jwk,
    verificationMethod: data.tinycloudSession.verificationMethod,
    address: data.address,
    chainId: data.chainId,
    siwe: data.siwe,
    signature: data.signature,
    tinycloudHosts: data.tinycloudHosts,
  };
}
