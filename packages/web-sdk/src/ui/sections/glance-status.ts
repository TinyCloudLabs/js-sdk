import type { LocalCopyStatus, LocalNodeState, NodeRow, PanelDataSource, StorageView, ViewResult } from "../data";
import type { SectionId } from "../slots";
import { panelText } from "../strings-panel";
import type { StatusView } from "./ui";

const CHECKING: StatusView = { word: panelText("glance.word.checking"), tone: "x" };
const NEEDS_PERMISSION: StatusView = { word: panelText("glance.word.needs_permission"), tone: "x" };
/** Shown when a read fails or the client has no data source. */
export const UNAVAILABLE: StatusView = { word: panelText("glance.word.unavailable"), tone: "x" };

/** Maps one view result to a status. Loading, needs-permission, and error stay neutral. */
function fromView<T>(result: ViewResult<T>, ready: (data: T) => StatusView): StatusView {
  switch (result.state) {
    case "loading":
      return CHECKING;
    case "needs-permission":
      return NEEDS_PERMISSION;
    case "error":
      return UNAVAILABLE;
    case "ready":
      return ready(result.data);
  }
}

function localNodeStatus(node: LocalNodeState): StatusView {
  switch (node.connection) {
    case "found":
      return { word: panelText("glance.word.found"), tone: "on" };
    case "looking":
      return { word: panelText("glance.word.looking"), tone: "x" };
    case "not-found":
      return { word: panelText("glance.word.not_found"), tone: "off" };
    case "off":
      return { word: panelText("glance.word.off"), tone: "off" };
    case "unavailable":
      return UNAVAILABLE;
  }
}

function localCopyStatus(copy: LocalCopyStatus): StatusView {
  switch (copy.effective) {
    case "on":
      return { word: panelText("glance.word.on"), tone: "on" };
    case "off":
      return { word: panelText("glance.word.off"), tone: "off" };
    case "unavailable":
      return UNAVAILABLE;
    // Transitional states (enabling, wiping, pending) are not a settled on or off.
    default:
      return CHECKING;
  }
}

function nodesStatus(rows: readonly NodeRow[]): StatusView {
  if (rows.length === 0) return { word: panelText("glance.word.none"), tone: "off" };
  const down = rows.filter((row) => row.status === "down").length;
  if (down > 0) return { word: panelText("glance.word.down", { count: down }), tone: "warn" };
  const slow = rows.filter((row) => row.status === "slow").length;
  if (slow > 0) return { word: panelText("glance.word.slow", { count: slow }), tone: "warn" };
  return { word: panelText("glance.word.healthy"), tone: "on" };
}

function storageStatus(view: StorageView): StatusView {
  if (view.state === "full") return { word: panelText("glance.word.full"), tone: "warn" };
  if (view.state === "nearly_full") return { word: panelText("glance.word.nearly_full"), tone: "warn" };
  return { word: panelText("glance.word.normal"), tone: "on" };
}

/**
 * Status for one At-a-glance row, read through the same PanelDataSource the sections use.
 * Each row resolves on its own so one slow read does not hold the others.
 * Undefined means no status to show (Activity without developer-mode request logs).
 */
export async function readGlanceStatus(
  data: PanelDataSource | undefined,
  id: SectionId,
): Promise<StatusView | undefined> {
  if (data === undefined) return UNAVAILABLE;
  switch (id) {
    case "local-tinycloud":
      return fromView(await data.localNode(), localNodeStatus);
    case "local-copy":
      return fromView(await data.localCopy(), localCopyStatus);
    case "delegations":
      return fromView(await data.delegations(), () => ({ word: panelText("glance.word.visible"), tone: "on" }));
    case "nodes":
      return fromView(await data.nodes(), nodesStatus);
    case "storage":
      return fromView(await data.storage(), storageStatus);
    case "activity": {
      const requests = data.requests?.();
      if (requests === undefined) return undefined;
      const errors = requests.rows().filter((row) => !row.ok).length;
      if (errors === 0) return { word: panelText("glance.word.no_errors"), tone: "on" };
      return { word: panelText("glance.word.errors", { count: errors }), tone: "warn" };
    }
    default:
      return undefined;
  }
}
