import { registerNodeReplicationLoaders } from "./module-registry";

registerNodeReplicationLoaders({
  runtime: () => import("./runtime"),
  authority: () => import("./authority"),
});
