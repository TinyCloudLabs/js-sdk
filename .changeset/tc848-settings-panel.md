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

Changes for existing code:
- Toasts render in the TinyCloud UI host, an open shadow root (`[data-tinycloud-ui]`, reachable as `host.shadowRoot`), instead of `document.body`. The legacy toast stack and the `tinycloud-toast*` elements are removed, so selectors that matched them must search inside `host.shadowRoot`. At most three toasts show at a time (the oldest is dropped), each disappears after 7 seconds, an identical toast that is already visible is not shown again, and a link shows only when it is an absolute https URL. Toasts show fixed wording; the raw error description goes to the console, and the toast Retry action is removed.
- New `ui.toasts` option (default `true`). `ui: { toasts: false }` shows no toasts and stops the SDK's unhandled-rejection listener; prompts still render. `ui: false` creates no host, button, toasts or listeners.
- `notifications.popups`, `position`, `duration` and `maxVisible` are removed from the types. JavaScript callers that still pass them are mapped onto `ui` once per page load, with a console warning: `popups: false` becomes `ui: { button: false, toasts: false }` when `ui` is not set, `position` becomes `ui.position` when that is not set, and `duration` and `maxVisible` are ignored.
- `notifications.throwErrors` is kept. It rethrows an error's raw message asynchronously whenever the UI and toasts are enabled, and identical errors within 200 ms collapse into one throw.
- The `tinycloud:error`, `tinycloud:warning` and `tinycloud:success` window events are no longer dispatched; `tinycloud:awaiting-user-input*` events are unchanged.
- Permission and space-creation prompts render inside the same host instead of `document.body`. In a frame or with `ui: false` they are not shown and resolve as declined or dismissed, with one console warning; `popups: false` and `ui: { button: false, toasts: false }` keep them. A prompt still open when the host is reset or removed resolves as dismissed, and opening a prompt while another is open dismisses the first.
- Prompts sit at z-index 999990, so a page overlay above that paints over them, and OpenKey's own overlay (999999) paints over the host. Prompts are modal dialogs (`role="dialog"`, `aria-modal="true"`): focus moves into them on open, Tab stays inside, and closing returns focus to where it was and restores the page's previous `overflow`. Approve and Create act only when nothing covers their centre at the moment they're activated.
- The unused node selection modal is removed; the package entry point never exported it.

Details: TC-1932
