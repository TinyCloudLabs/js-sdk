---
"@tinycloud/cli": patch
---

When the TinyCloud profile folder cannot be written (a read-only home, or a `~/.tinycloud` that belongs to another user after an earlier `sudo` run), setup now stops with an error that names the folder, says why, and gives the exact command to fix it, instead of a raw `EACCES: permission denied, mkdir` message. Nothing is changed before it stops; fix the folder and run the same command again. The fix command is shown only for a folder inside your home; for anywhere else the error says to ask the person who manages the computer.

Details: TC-3278
