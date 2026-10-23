// web-sdk files that wire replication into the client bundle; their bytes are replica-owned.
// The wiring is ONE module: tcw.ts and index.ts only call into it, so editing them is not a
// replica change. replica-wiring-boundary.test.ts fails if replica code returns to them.
export const replicationWiringPaths: Record<string, true> = {
  "packages/web-sdk/src/modules/replica-wiring.ts": true,
};

export const replicaOwnedPath = (path: string) =>
  !/\.test\.[cm]?[jt]sx?$/.test(path) && (
    path.startsWith("packages/replica/") ||
    path.startsWith("packages/sdk-services/src/kv/replication/") ||
    path.startsWith("packages/sdk-core/src/replication/") ||
    path.startsWith("packages/node-sdk/src/replication/") ||
    Object.hasOwn(replicationWiringPaths, path) ||
    (path.startsWith("packages/web-sdk/src/") && /replica|replication/i.test(path))
  );
