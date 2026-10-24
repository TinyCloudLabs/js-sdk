// Browser harness for the lazy dialog seam. Bundled by `build:e2e-prompts-lazy` as an ES module graph, so the
// dialogs' dynamic import lands in its own chunk, like dist/modals.mjs. Unlike prompts-harness-entry.ts, nothing
// here imports ModalManager: prompts go through the eager front (lazy-prompts.ts) that production uses.
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";
import { ModalSpaceCreationHandler } from "../../src/authorization/WebSpaceCreationHandler";
import { showPermissionRequestModal } from "../../src/notifications/lazy-prompts";

const source = { signedIn: () => true };
let handle: UiClientHandle | undefined;
const w = window as unknown as Record<string, unknown>;

w.__tc = {
  mount() {
    handle?.unregister();
    handle = registerUiClient({ ui: {}, source: source as never, manifestAppId: () => "e2e-prompts-lazy" });
    return true;
  },
  openPermission() {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__permResult;
    showPermissionRequestModal({ appName: "E2E App", additional: [] }, handle.promptScope).then(
      (result) => {
        w.__permResult = result.approved;
      },
      (error: unknown) => {
        w.__permError = String(error);
      },
    );
    return true;
  },
  // What tcw does on sign-out and on an account change: the UI client is reset.
  reset() {
    handle?.reset();
    return true;
  },
  openSpaceCreation() {
    if (handle === undefined) throw new Error("mount() must run first");
    delete w.__spaceResult;
    new ModalSpaceCreationHandler({ promptScope: handle.promptScope, timeoutMs: 0 })
      .confirmSpaceCreation({ spaceId: "space-e2e", host: "tinycloud.test" } as never)
      .then(
        (result) => {
          w.__spaceResult = result;
        },
        (error: unknown) => {
          w.__spaceError = String(error);
        },
      );
    return true;
  },
};
