---
"@tinycloud/web-sdk": minor
---

Permission and space creation prompts now render inside the TinyCloud panel host instead of `document.body`. Prompts fail closed: inside a frame or with `ui: false` they do not render, resolve immediately as declined or dismissed, and log one warning. Prompts still open when the host resets or tears down resolve as dismissed.

The unused node selection modal is removed (`NodeSelectionModal.ts`, and its re-exports from the internal `notifications` barrel). The package entry point never exported it. Selectors that matched `tinycloud-space-modal` in the light DOM no longer match, because prompts are inside the host's open shadow root (`host.shadowRoot`).
