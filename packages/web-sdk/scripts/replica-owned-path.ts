// web-sdk files that wire replication into the client bundle; their bytes are replica-owned.
// The wiring is ONE module: tcw.ts and index.ts only call into it, so editing them is not a
// replica change. replica-wiring-boundary.test.ts fails if replica code returns to them.
export const replicationWiringPaths: Record<string, true> = {
  "packages/web-sdk/src/modules/replica-wiring.ts": true,
};

// packages/*/scripts/ holds the size checkers, their ledgers and tests. They never ship in an
// artefact, so editing them is not a replica change. A script a package build runs shapes the
// shipped dist and stays owned; replica-owned-path.test.ts keeps this list complete.
export const buildStepScripts: Record<string, true> = {
  "packages/replica/scripts/hash-worker.ts": true,
};

export const replicaOwnedPath = (path: string) =>
  !/\.test\.[cm]?[jt]sx?$/.test(path) &&
  (!/^packages\/[^/]+\/scripts\//.test(path) || Object.hasOwn(buildStepScripts, path)) && (
    path.startsWith("packages/replica/") ||
    path.startsWith("packages/sdk-services/src/kv/replication/") ||
    path.startsWith("packages/sdk-core/src/replication/") ||
    path.startsWith("packages/node-sdk/src/replication/") ||
    Object.hasOwn(replicationWiringPaths, path) ||
    (path.startsWith("packages/web-sdk/src/") && /replica|replication/i.test(path))
  );
