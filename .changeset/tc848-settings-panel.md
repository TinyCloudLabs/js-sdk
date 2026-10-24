---
"@tinycloud/web-sdk": minor
---

Add the TinyCloud settings panel to `TinyCloudWeb`: a floating launcher button and a panel, controlled through `tc.ui` (`open(section?)`, `openPage(section?)`, `close()`, `toggle()`, `isOpen`, `available`) and the `ui` config option. `ui: false` turns the UI off, `ui: { button: false }` hides the button while `tc.ui` still opens the panel, and `ui: { mode: "sidebar" | "page" | "both" }` (default `"both"`) sets the layouts offered. The UI is not rendered in iframes or opaque origins.

Sections: Overview, Local TinyCloud, Local copy, Delegations, Nodes, Storage and Activity (Activity only with `ui: { developerMode: true }`). The panel is a sidebar or a full page with one button to switch between them. On phones it always opens as a full page, with a Sections menu and a Close button.

What the sections show with `TinyCloudWeb` today:
- Local copy appears only when the host supplies a sync facade, and sign-out removes the local copy only when the host supplies a purge. `TinyCloudWeb` supplies neither, so Local copy is not shown.
- Storage details need the `tinycloud.space/info` permission on the app's primary space, which the panel can't request itself. Add it to your app's manifest to show them: a permission with `service: "tinycloud.space"`, `actions: ["info"]`, an empty `path` and `skipPrefix: true`, on the same `space` as your app's first permission (`applications` when `space` is omitted). Without it, Storage says the app can't see your storage.
- Local TinyCloud says it can't be checked from this app, and Activity has nothing to show until the host supplies a request log.
- Delegations and Storage appear when signed in.

Behavior to know about:
- The panel loads on first open, or on hover or focus of the launcher, so it mounts after an asynchronous import. Code that queries the shadow root right after `open()` has to wait for it.
- The permission and space-creation dialogs load when the first prompt is shown. A dialog that cannot load is declined, never approved.
- After sign-in or session restore, once the browser is idle, the panel's reads (account, delegations, storage) start in the background, so a signed-in page makes them without the panel being opened. They are not retried after a failure until the next sign-in, restore, or hover, focus or open. Sign-out cancels a pending start. There is no option to disable this.

Details: TC-1932
