---
"@tinycloud/web-sdk": minor
---

Toasts now render in the UI host panel. They replace the legacy `ToastManager` stack. Toasts appear above the floating button, use `ui.position`, show up to 3 at once (oldest dropped), and auto-dismiss after 5 seconds. These are fixed defaults and are not configurable. An identical toast already visible is not shown again. The old toast debounce is removed, so toasts appear immediately. Toast text is fixed copy rendered as text only. A link is kept only when it is an absolute https URL. Toasts appear only while the UI is mounted.

Breaking changes:

- `notifications.popups`, `notifications.position`, `notifications.duration`, and `notifications.maxVisible` are removed from the TypeScript types, so typed callers get a compile error. JavaScript callers that still pass them are mapped onto `ui` once per page load, with a console warning. `popups: false` becomes `ui: false` unless `ui` is set explicitly, which creates no host, button, or toasts. `position` becomes `ui.position`, unless `ui.position` is set. Migrate to `ui`. `position` values starting with `top-` are accepted and now place the button and toasts at the matching bottom position. An unrecognised value silently falls back to `bottom-right`. `duration` and `maxVisible` are ignored. Duration (5 s) and maximum visible (3) are no longer configurable.
- `ui: { button: false }` hides the floating button but keeps toasts.
- `notifications.throwErrors` is kept. It rethrows the raw error message asynchronously. Identical errors within a 200 ms window collapse into one throw; distinct errors each throw. It applies whenever `ui` is enabled, including on a framed page where the toast is dropped. It does not throw with `ui: false`. Dedupe does not suppress the throw.
- The `tinycloud:error`, `tinycloud:warning`, and `tinycloud:success` window events are no longer dispatched. The `tinycloud-toast*` custom elements are removed. `tinycloud:awaiting-user-input*` events are unchanged.
- Toast copy changed. Adapter and bootstrap messages show generic fixed text. Raw error descriptions are no longer shown in the toast: they go to the console, and `throwErrors` rethrows them. The toast Retry action is removed.
- Toasts render inside the TinyCloud host, which is an open shadow root (`[data-tinycloud-ui]`, reachable as `host.shadowRoot`), instead of being appended to `document.body`. Selectors that matched those body children must search inside the host's `shadowRoot`.
