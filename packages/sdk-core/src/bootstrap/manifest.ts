import {
  ACCOUNT_REGISTRY_SPACE,
  DEFAULT_MANIFEST_SPACE,
  SECRETS_SPACE,
  composeManifestRequest,
  type ComposedManifestRequest,
  type Manifest,
  type ResourceCapability,
} from "../manifest";
import { makePkhSpaceId, pkhDid } from "../identity";

export const BOOTSTRAP_DEFAULT_SPACE = "default";
export const BOOTSTRAP_PUBLIC_SPACE = "public";
export const BOOTSTRAP_ENCRYPTION_NETWORK_NAME = "default";

export const BOOTSTRAP_SPACE_NAMES = [
  BOOTSTRAP_DEFAULT_SPACE,
  DEFAULT_MANIFEST_SPACE,
  ACCOUNT_REGISTRY_SPACE,
  SECRETS_SPACE,
  BOOTSTRAP_PUBLIC_SPACE,
] as const;

export type BootstrapSpaceName = (typeof BOOTSTRAP_SPACE_NAMES)[number];

export const TINYCLOUD_DEFAULT_SPACE_MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.default",
  name: "TinyCloud Default Space",
  space: BOOTSTRAP_DEFAULT_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: BOOTSTRAP_DEFAULT_SPACE,
      path: "/",
      actions: ["get", "put", "del", "list", "metadata"],
    },
    {
      service: "tinycloud.sql",
      space: BOOTSTRAP_DEFAULT_SPACE,
      path: "/",
      actions: ["read", "write"],
    },
  ],
};

export const TINYCLOUD_APPLICATIONS_SPACE_MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.applications",
  name: "TinyCloud Applications Space",
  space: DEFAULT_MANIFEST_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: DEFAULT_MANIFEST_SPACE,
      path: "/",
      actions: ["get", "put", "del", "list", "metadata"],
    },
    {
      service: "tinycloud.sql",
      space: DEFAULT_MANIFEST_SPACE,
      path: "/",
      actions: ["read", "write"],
    },
  ],
};

export const TINYCLOUD_ACCOUNT_SPACE_MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.account",
  name: "TinyCloud Account Registry",
  space: ACCOUNT_REGISTRY_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "applications/",
      actions: ["get", "put", "list"],
    },
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "spaces/",
      actions: ["get", "put", "list"],
    },
    {
      service: "tinycloud.sql",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "account",
      actions: ["read", "write", "schema"],
    },
  ],
};

export const TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.secrets",
  name: "TinyCloud Secrets",
  space: SECRETS_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.vault",
      space: SECRETS_SPACE,
      path: "secrets/",
      actions: ["read"],
      skipPrefix: true,
    },
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: "variables",
      actions: ["list", "metadata"],
      skipPrefix: true,
    },
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: "variables/",
      actions: ["get", "put", "del", "list", "metadata"],
      skipPrefix: true,
    },
    {
      service: "tinycloud.sql",
      space: SECRETS_SPACE,
      path: "default",
      actions: ["read", "write", "schema"],
      skipPrefix: true,
    },
    {
      service: "tinycloud.capabilities",
      space: SECRETS_SPACE,
      path: "",
      actions: ["read"],
      skipPrefix: true,
    },
  ],
};

export const TINYCLOUD_PUBLIC_SPACE_MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.public",
  name: "TinyCloud Public Space",
  space: BOOTSTRAP_PUBLIC_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: BOOTSTRAP_PUBLIC_SPACE,
      path: "/",
      actions: ["get", "list", "metadata"],
    },
  ],
};

export const BOOTSTRAP_SPACE_MANIFESTS: Readonly<Record<BootstrapSpaceName, Manifest>> = {
  [BOOTSTRAP_DEFAULT_SPACE]: TINYCLOUD_DEFAULT_SPACE_MANIFEST,
  [DEFAULT_MANIFEST_SPACE]: TINYCLOUD_APPLICATIONS_SPACE_MANIFEST,
  [ACCOUNT_REGISTRY_SPACE]: TINYCLOUD_ACCOUNT_SPACE_MANIFEST,
  [SECRETS_SPACE]: TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  [BOOTSTRAP_PUBLIC_SPACE]: TINYCLOUD_PUBLIC_SPACE_MANIFEST,
};

export const BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS = [
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
] as const;

export const ACCOUNT_INDEX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applications (
    app_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    updated_at TEXT,
    manifest_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS application_state (
    app_id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS spaces (
    space_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_did TEXT NOT NULL,
    type TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    status TEXT NOT NULL,
    registered_at TEXT,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS delegations (
    cid TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    space_id TEXT NOT NULL,
    space_name TEXT,
    counterparty_did TEXT NOT NULL,
    delegate_did TEXT NOT NULL,
    delegator_did TEXT,
    path TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    expiry TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL,
    count INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_delegations_direction ON delegations(direction)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_space ON delegations(space_id)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_counterparty ON delegations(counterparty_did)",
  "CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_did)",
  "CREATE INDEX IF NOT EXISTS idx_spaces_type ON spaces(type)",
] as const;

export const SECRET_RECORDS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secret_records (
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_id TEXT,
    custom_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_tested TEXT,
    test_status TEXT,
    test_message TEXT,
    PRIMARY KEY(scope, name)
  )`,
] as const;

export interface BootstrapSpaceDescriptor {
  name: BootstrapSpaceName;
  manifest: Manifest;
  persistedAsApplication: boolean;
}

export interface BootstrapManifest {
  spaces: readonly BootstrapSpaceDescriptor[];
  applications: readonly Manifest[];
  accountIndexSchema: readonly string[];
  secretRecordsSchema: readonly string[];
  encryptionNetwork: {
    name: typeof BOOTSTRAP_ENCRYPTION_NETWORK_NAME;
  };
}

export const BOOTSTRAP_MANIFEST: BootstrapManifest = {
  spaces: BOOTSTRAP_SPACE_NAMES.map((name) => ({
    name,
    manifest: BOOTSTRAP_SPACE_MANIFESTS[name],
    persistedAsApplication: name === SECRETS_SPACE,
  })),
  applications: BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS,
  accountIndexSchema: ACCOUNT_INDEX_SCHEMA,
  secretRecordsSchema: SECRET_RECORDS_SCHEMA,
  encryptionNetwork: {
    name: BOOTSTRAP_ENCRYPTION_NETWORK_NAME,
  },
};

export type BootstrapAllowlistKind = "session" | "space/host";

export interface BootstrapAllowlistEntry {
  kind: BootstrapAllowlistKind;
  space: BootstrapSpaceName;
  service: "tinycloud.session" | "tinycloud.space";
  actions: readonly string[];
  resources?: readonly ResourceCapability[];
}

export function composeBootstrapSpaceManifest(
  space: BootstrapSpaceName,
): ComposedManifestRequest {
  return composeManifestRequest([BOOTSTRAP_SPACE_MANIFESTS[space]], {
    includeAccountRegistryPermissions: false,
  });
}

export const BOOTSTRAP_SESSION_REQUESTS: Readonly<
  Record<BootstrapSpaceName, ComposedManifestRequest>
> = Object.freeze(
  Object.fromEntries(
    BOOTSTRAP_SPACE_NAMES.map((space) => [
      space,
      composeBootstrapSpaceManifest(space),
    ]),
  ) as Record<BootstrapSpaceName, ComposedManifestRequest>,
);

export const BOOTSTRAP_ALLOWLIST: readonly BootstrapAllowlistEntry[] =
  Object.freeze(
    BOOTSTRAP_SPACE_NAMES.flatMap((space) => [
      {
        kind: "session" as const,
        service: "tinycloud.session" as const,
        space,
        actions: ["siwe"],
        resources: BOOTSTRAP_SESSION_REQUESTS[space].resources,
      },
      {
        kind: "space/host" as const,
        service: "tinycloud.space" as const,
        space,
        actions: ["tinycloud.space/host"],
      },
    ]),
  );

export type BootstrapStepKind =
  | "session"
  | "host"
  | "activate"
  | "account-index-schema"
  | "seed-spaces"
  | "seed-applications"
  | "encryption-network-create"
  | "secret-records-schema";

export interface BootstrapStepBase {
  id: string;
  kind: BootstrapStepKind;
}

export interface BootstrapSpaceStep extends BootstrapStepBase {
  kind: "session" | "host" | "activate";
  space: BootstrapSpaceName;
  spaceId: string;
  request?: ComposedManifestRequest;
  includeEncryptionNetworkCreate?: boolean;
}

export interface BootstrapSchemaStep extends BootstrapStepBase {
  kind: "account-index-schema" | "secret-records-schema";
  space: typeof ACCOUNT_REGISTRY_SPACE | typeof SECRETS_SPACE;
  spaceId: string;
  database: string;
  schema: readonly string[];
}

export interface BootstrapSeedSpacesStep extends BootstrapStepBase {
  kind: "seed-spaces";
  spaces: readonly {
    name: BootstrapSpaceName;
    spaceId: string;
  }[];
}

export interface BootstrapSeedApplicationsStep extends BootstrapStepBase {
  kind: "seed-applications";
  manifests: readonly Manifest[];
}

export interface BootstrapEncryptionNetworkStep extends BootstrapStepBase {
  kind: "encryption-network-create";
  networkId: string;
}

export type BootstrapStep =
  | BootstrapSpaceStep
  | BootstrapSchemaStep
  | BootstrapSeedSpacesStep
  | BootstrapSeedApplicationsStep
  | BootstrapEncryptionNetworkStep;

export function bootstrapSpaceId(
  address: string,
  chainId: number,
  space: BootstrapSpaceName,
): string {
  return makePkhSpaceId(address, chainId, space);
}

export function bootstrapEncryptionNetworkId(
  address: string,
  chainId: number,
): string {
  return `urn:tinycloud:encryption:${pkhDid(address, chainId)}:${BOOTSTRAP_ENCRYPTION_NETWORK_NAME}`;
}

export function bootstrapSteps(
  address: string,
  chainId: number,
): BootstrapStep[] {
  const spaces = BOOTSTRAP_SPACE_NAMES.map((name) => ({
    name,
    spaceId: bootstrapSpaceId(address, chainId, name),
  }));
  const account = spaces.find((space) => space.name === ACCOUNT_REGISTRY_SPACE)!;
  const secrets = spaces.find((space) => space.name === SECRETS_SPACE)!;

  return [
    ...spaces.map((space) => ({
      id: `session:${space.name}`,
      kind: "session" as const,
      space: space.name,
      spaceId: space.spaceId,
      request: BOOTSTRAP_SESSION_REQUESTS[space.name],
      includeEncryptionNetworkCreate: space.name === ACCOUNT_REGISTRY_SPACE,
    })),
    ...spaces.map((space) => ({
      id: `host:${space.name}`,
      kind: "host" as const,
      space: space.name,
      spaceId: space.spaceId,
    })),
    ...spaces.map((space) => ({
      id: `activate:${space.name}`,
      kind: "activate" as const,
      space: space.name,
      spaceId: space.spaceId,
    })),
    {
      id: "account:index-schema",
      kind: "account-index-schema",
      space: ACCOUNT_REGISTRY_SPACE,
      spaceId: account.spaceId,
      database: "account",
      schema: ACCOUNT_INDEX_SCHEMA,
    },
    {
      id: "account:seed-spaces",
      kind: "seed-spaces",
      spaces,
    },
    {
      id: "account:seed-applications",
      kind: "seed-applications",
      manifests: BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS,
    },
    {
      id: "encryption:network-create",
      kind: "encryption-network-create",
      networkId: bootstrapEncryptionNetworkId(address, chainId),
    },
    {
      id: "secrets:secret-records-schema",
      kind: "secret-records-schema",
      space: SECRETS_SPACE,
      spaceId: secrets.spaceId,
      database: "default",
      schema: SECRET_RECORDS_SCHEMA,
    },
  ];
}
