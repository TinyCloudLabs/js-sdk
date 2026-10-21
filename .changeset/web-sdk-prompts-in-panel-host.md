---
"@tinycloud/web-sdk": minor
---

Permission and space creation prompts now render inside the TinyCloud panel host instead of `document.body`. Prompts fail closed: inside a frame or with `ui: false` they do not render, resolve immediately as declined or dismissed, and log one warning. `ui: false` refuses SDK prompts (explicit opt-in); `popups: false` and `ui: { button: false, toasts: false }` keep them. Prompts still open when the host resets or tears down resolve as dismissed. Opening a prompt while another is open dismisses the first, which resolves as dismissed. Before, the first prompt was removed silently and its promise never settled.

Prompts stack at the host's page-level z-index 999990 instead of 2000000 (their own `z-index: 2000000` now applies inside the host's `isolation: isolate` context). Page overlays with a z-index above 999990 therefore paint above a consent prompt. Lower such overlays' z-index below 999990 to keep them under prompts. OpenKey's 999999 overlay still paints above the host.

The unused node selection modal is removed (`NodeSelectionModal.ts`, and its re-exports from the internal `notifications` barrel). The package entry point never exported it. Selectors that matched `tinycloud-space-modal` in the light DOM no longer match, because prompts are inside the host's open shadow root (`host.shadowRoot`).
