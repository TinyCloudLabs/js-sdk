---
"@tinycloud/web-sdk": minor
---

The UI host now renders toasts. Toasts appear above the floating button, use the configured position, and show up to 3 at once (oldest dropped). Each auto-dismisses after 5 seconds. Hovering a toast pauses every timer until the pointer leaves. Toast text is rendered as text only, and a link is kept only when its `href` is an absolute http(s) URL. Toasts appear only when the UI is mounted (`ui` not `false`). Nothing public changes in this release: the existing `ToastManager` / `SDKErrorHandler` path is unchanged.
