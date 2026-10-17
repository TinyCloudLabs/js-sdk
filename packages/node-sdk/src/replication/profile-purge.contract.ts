/**
 * Compile-time tie between the replication contract's profile facade types
 * (sdk-services, the single source of truth) and this package's implementation.
 * Type-only; compiled by `bun run typecheck:replica-contract`, which CI runs on
 * pull requests.
 */
import type {
  ProfileReplicaDeferredToken as ContractDeferredToken,
  ProfileReplicaPurge as ContractProfileReplicaPurge,
} from "@tinycloud/sdk-services/kv/replication";
import type { ProfileReplicaDeferredToken, ProfileReplicaPurge } from "../index";
import type { createProfileReplicaPurge } from "./sqlite";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type _TokenIsTheContractToken = Assert<Equal<ProfileReplicaDeferredToken, ContractDeferredToken>>;
type _ExportIsTheContract = Assert<Equal<ProfileReplicaPurge, ContractProfileReplicaPurge>>;
type _FactoryReturnsTheExport = Assert<Equal<ReturnType<typeof createProfileReplicaPurge>, ProfileReplicaPurge>>;
