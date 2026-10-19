// The optional webpack build resolves this relative import to the root package
// external. Its named exports must match the real sdk-core functions exactly.
export {
  __replicaActionContains as actionContains,
  __replicaKV as KV,
  __replicaCanonicalizeRecapCaveats as canonicalizeRecapCaveats,
  __replicaIsCapabilitySubset as isCapabilitySubset,
  __replicaParsePkhDid as parsePkhDid,
  __replicaParseSpaceUri as parseSpaceUri,
  __replicaPkhDid as pkhDid,
  __replicaPrincipalDid as principalDid,
} from "./index";
