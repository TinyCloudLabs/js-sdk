import { registerReplicationLoaders } from "./module-registry";

registerReplicationLoaders({
  runtime: () => import("./runtime"),
  authority: () => import("./authority"),
});
