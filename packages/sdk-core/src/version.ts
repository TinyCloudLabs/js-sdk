/**
 * Protocol version checking for SDK-to-node compatibility.
 *
 * @packageDocumentation
 */

export class ProtocolMismatchError extends Error {
  name = "ProtocolMismatchError" as const;
  constructor(
    public readonly sdkProtocol: number,
    public readonly nodeProtocol: number,
    public readonly nodeVersion: string,
    public readonly host: string
  ) {
    super(
      `SDK protocol version ${sdkProtocol} is incompatible with node protocol version ${nodeProtocol} (node v${nodeVersion}) at ${host}. ` +
        (sdkProtocol < nodeProtocol
          ? "Please update your SDK."
          : "Please update the TinyCloud node.")
    );
  }
}

export class VersionCheckError extends Error {
  name = "VersionCheckError" as const;
  constructor(
    public readonly host: string,
    public readonly cause?: Error
  ) {
    super(
      `Failed to fetch node info at ${host}. Ensure the node is running and the /info endpoint is accessible.`
    );
  }
}

export class UnsupportedFeatureError extends Error {
  name = "UnsupportedFeatureError" as const;
  constructor(
    public readonly feature: string,
    public readonly host: string,
    public readonly availableFeatures: string[]
  ) {
    super(
      `Feature "${feature}" is not supported by the node at ${host}. ` +
        `Available features: ${availableFeatures.join(", ") || "none"}.`
    );
  }
}

export interface NodeServicesInfo {
  kv: boolean;
  delegation: boolean;
  sharing: boolean;
  sql: boolean;
  duckdb: boolean;
}

export interface NodeReplicationInfo {
  supported: boolean;
  enabled: boolean;
  recon: boolean;
  authSync: boolean;
  authoredFactExchange: boolean;
  notifications: boolean;
  snapshots: boolean;
}

export interface NodeInfo {
  features: string[];
  quotaUrl?: string;
  rolesSupported?: string[];
  rolesEnabled?: string[];
  services?: NodeServicesInfo;
  replication?: NodeReplicationInfo;
}

export async function checkNodeInfo(
  host: string,
  sdkProtocol: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
): Promise<NodeInfo> {
  let response: Response;
  try {
    response = await fetchFn(`${host}/info`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new VersionCheckError(host, err as Error);
  }

  if (!response.ok) {
    throw new VersionCheckError(host);
  }

  const data = (await response.json()) as {
    protocol: number;
    version: string;
    features: string[];
    quota_url?: string;
    rolesSupported?: string[];
    rolesEnabled?: string[];
    services?: NodeServicesInfo;
    replication?: NodeReplicationInfo;
  };

  if (sdkProtocol !== data.protocol) {
    throw new ProtocolMismatchError(
      sdkProtocol,
      data.protocol,
      data.version,
      host
    );
  }

  return {
    features: data.features ?? [],
    quotaUrl: data.quota_url,
    rolesSupported: data.rolesSupported ?? [],
    rolesEnabled: data.rolesEnabled ?? [],
    services: data.services,
    replication: data.replication,
  };
}
