---
"@tinycloud/web-sdk": minor
---

Toasts now render in the UI host panel. They replace the legacy `ToastManager` stack. Toasts appear above the floating button, use `ui.position`, show up to 3 at once (oldest dropped), and auto-dismiss after 5 seconds. An identical toast already visible is not shown again. Toast text is fixed copy rendered as text only. A link is kept only when it is an absolute https URL. Toasts appear only while the UI is mounted.

Breaking changes:

- `notifications.popups`, `notifications.position`, `notifications.duration`, and `notifications.maxVisible` are removed. Setting any of them fails schema validation. Migrate `popups: false` to `ui: false`, which creates no host, button, or toasts. Migrate `position` to `ui: { position }`. `ui.position` accepts only `bottom-right`, `bottom-left`, and `bottom-center`. The former `top-*` values are gone, and an unrecognised value silently falls back to `bottom-right`. Duration (5 s) and maximum visible (3) are no longer configurable.
- `ui: { button: false }` hides the floating button but keeps toasts.
- `notifications.throwErrors` is kept. It now rethrows asynchronously only for an error toast that was actually shown.
- The `tinycloud:error`, `tinycloud:warning`, and `tinycloud:success` window events are no longer dispatched. The `tinycloud-toast*` custom elements are removed. `tinycloud:awaiting-user-input*` events are unchanged.
- Toast copy changed. Adapter and bootstrap messages show generic fixed text, and raw error descriptions go to the console instead of the toast. The toast Retry action is removed.
