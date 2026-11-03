---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

`TinyCloudWeb.signOut()` clears local state first. The node's sign-out starts at once, but `signOut()` waits for it for at most 3 seconds after the persisted session is cleared, so a node call that never answers (for example after a revoked grant) no longer leaves the tab signed in. When the 3 seconds pass, `signOut()` resolves while the node's own cleanup may still be running; the local session is already gone, but callers should not assume the node-side cleanup has finished. Errors the node's sign-out raises within that time still reject `signOut()`, as before. A session whose stored record could not be removed is now fenced in `BrowserSessionStorage` (`markSignedOut` / `isSignedOut`), so a reload cannot restore it; a successful `clear` or a different saved session lifts the fence. Other `ISessionStorage` implementations keep only the in-memory block, and a sign-out with no live session (a restore still pending) fences nothing: only the in-memory block applies there.

`signOut()` in both SDKs clears the stored session only when it is still the session being signed out (same signature): a sign-out that finishes after a newer sign-in for the same address no longer erases the newer saved copy.

`FileSessionStorage.save` writes a temp file (mode 0600, so the saved file is owner-only) and renames it, so a failed write keeps the previous session. `FileSessionStorage.load` no longer deletes a file it cannot read or parse; it rejects with `Could not read session file <path>: <cause>` and leaves the file. Expired and schema-invalid files are still removed.

Details: TC-2379
