import { type ProfileGateModule, registerReplicationLoaders } from "./module-registry";

registerReplicationLoaders({
  runtime: () => import("./runtime"),
  authority: () => import("./authority"),
  // Lazy by contract: replica loads only when replication is enabled. Literal specifier typed by
  // ProfileGateModule; TS2307 under moduleResolution "node" is suppressed (see replica-contract.ts).
  // @ts-ignore
  gate: () => import("@tinycloud/replica/profile-gate") as Promise<ProfileGateModule>,
});
