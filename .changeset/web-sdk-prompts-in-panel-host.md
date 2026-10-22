---
"@tinycloud/web-sdk": minor
---

Permission and space creation prompts now render inside the TinyCloud panel host instead of `document.body`. Prompts fail closed: inside a frame or with `ui: false` they do not render, resolve immediately as declined or dismissed, and log one warning. `ui: false` refuses SDK prompts (explicit opt-in); `popups: false` and `ui: { button: false, toasts: false }` keep them. Prompts still open when the host resets or tears down resolve as dismissed. Opening a prompt while another is open dismisses the first, which resolves as dismissed. Before, the first prompt was removed silently and its promise never settled.

Prompts stack at the host's page-level z-index 999990 instead of 2000000 (their own `z-index: 2000000` now applies inside the host's `isolation: isolate` context). Page overlays with a z-index above 999990 therefore paint above a consent prompt. Lower such overlays' z-index below 999990 to keep them under prompts. OpenKey's 999999 overlay still paints above the host.

Prompts are announced as modal dialogs (`role="dialog"`, `aria-modal="true"`, named by their title and described by their explanation). Focus moves to the dialog itself on open, never to Approve or Create, so Enter alone cannot confirm consent or start space creation. Tab and Shift+Tab stay inside the dialog while it is open. Closing a prompt returns focus to the element that had it, unless focus has moved elsewhere on the page. While a prompt is open, the body scroll lock restores the page's previous `overflow` value on release instead of clearing it, so a page that set `overflow: clip` keeps it. Pages that relied on Tab moving out of an open prompt will now stay inside it.

Approve and Create act only when they are the topmost element at their centre at the moment they are activated (click, or Enter or Space on the focused button). An element covering them blocks the action, including a translucent one; the check is a hit test, so an element with `pointer-events: none` does not block it. Decline, close, Escape, and the backdrop are not gated.

Prompts scroll inside their backdrop when the window is shorter than the prompt, so Approve and Create stay reachable by keyboard and mouse at any window height. Clicking or dragging the backdrop's scrollbar neither approves nor declines the prompt.

The unused node selection modal is removed (`NodeSelectionModal.ts`, and its re-exports from the internal `notifications` barrel). The package entry point never exported it. Selectors that matched `tinycloud-space-modal` in the light DOM no longer match, because prompts are inside the host's open shadow root (`host.shadowRoot`).
