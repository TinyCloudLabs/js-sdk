/**
 * Every web-sdk root-bundle line that wires the optional replica. This file is the whole
 * replica-owned part of the root: `tcw.ts` and `index.ts` call into it and must hold no other
 * replica code (enforced by `scripts/replica-wiring-boundary.test.ts`), so an edit to them is not
 * charged to the replica size allowance.
 */
import {
  registerReplicationLoaders as registerNodeReplicationLoaders,
  type ReplicationModuleLoaders,
  type TinyCloudNodeConfig,
} from "@tinycloud/node-sdk/core";
import type { BrowserWalletSigner } from "../adapters/BrowserWalletSigner";

// The optional replica bundle imports shared SDK core and SIWE from this root
// bundle, never from a separately instantiated registry or session cache.
// sdk-core re-exports siwe's SiweMessage, so the published types need only
// declared dependencies.
export {
  actionContains as __replicaActionContains,
  KV as __replicaKV,
  canonicalizeRecapCaveats as __replicaCanonicalizeRecapCaveats,
  isCapabilitySubset as __replicaIsCapabilitySubset,
  parsePkhDid as __replicaParsePkhDid,
  parseSpaceUri as __replicaParseSpaceUri,
  pkhDid as __replicaPkhDid,
  principalDid as __replicaPrincipalDid,
  SiweMessage as __replicaSiweMessage,
} from "@tinycloud/sdk-core";

/** The `replica.purge.failed` event, under a name `tcw.ts` may use (it holds no replica-named identifiers). */
export type { ReplicaPurgeFailedEvent as LocalCopyPurgeFailedEvent } from "@tinycloud/sdk-core";

/** Supplied by the optional web replica entry; importing that entry does not register it. */
export interface BrowserReplicaPlugin {
  readonly loaders: ReplicationModuleLoaders;
  readonly validateConfig: (replication: NonNullable<TinyCloudNodeConfig["replication"]>) => void;
  readonly recover: (
    replication: NonNullable<TinyCloudNodeConfig["replication"]>,
    signer?: BrowserWalletSigner,
  ) => Promise<NonNullable<TinyCloudNodeConfig["replication"]>>;
}

let registeredBrowserReplica: BrowserReplicaPlugin | undefined;

/**
 * Register in the root bundle so a separately built plugin shares its Node loader registry. The
 * registry keeps a frozen copy, so mutating the supplied plugin later changes nothing.
 */
export function registerBrowserReplica(plugin: BrowserReplicaPlugin): void {
  if (registeredBrowserReplica) throw new Error("Browser replica is already registered.");
  const loaders = Object.freeze({ ...plugin.loaders });
  registerNodeReplicationLoaders(loaders);
  registeredBrowserReplica = Object.freeze({ ...plugin, loaders });
}

type ReplicationConfigHolder = { readonly replication?: TinyCloudNodeConfig["replication"] };

export function validateReplicationConfig(config: ReplicationConfigHolder): void {
  if (config.replication?.enabled) {
    if (!registeredBrowserReplica) {
      throw new Error("Call registerBrowserReplica from @tinycloud/web-sdk with the @tinycloud/web-sdk/replica plugin before constructing TinyCloudWeb with replication enabled.");
    }
    registeredBrowserReplica.validateConfig(config.replication);
  }
}

/** The replication value for the node config (a promise when recovery runs); undefined when none is configured. */
export function resolveReplicationConfig(
  config: ReplicationConfigHolder,
  signer?: BrowserWalletSigner,
): TinyCloudNodeConfig["replication"] | Promise<NonNullable<TinyCloudNodeConfig["replication"]>> {
  return config.replication?.enabled
    ? registeredBrowserReplica!.recover(config.replication, signer)
    : config.replication;
}
