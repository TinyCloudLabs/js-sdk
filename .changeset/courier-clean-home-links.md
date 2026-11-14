---
"@tinycloud/courier": patch
---

The agent's clean HOME is checked for links the agent planted there between wakes. Before Courier makes, removes or writes any path in it (`.claude`, `.config`, a `--home-file` directory such as `.codex`, `.gitconfig`, the agent identity files), each component is checked without following links: a link found is removed (the link only, never what it points at) and the wake logs `removed a symbolic link the agent left in its clean HOME: <path>`. A clean HOME that is itself a link is refused. Before, a planted link such as `.config -> ~/somewhere` could make the next wake delete or overwrite files outside the clean HOME.

The Claude login that a `--wake claude` wake copies automatically (`.claude/.credentials.json`) is now read the way `--home-file` sources are: a link on the file or above it fails the wake closed instead of being followed; a missing file is still skipped.

Details: TC-3014
