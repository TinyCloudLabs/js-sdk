---
"@tinycloud/cli": patch
---

When the TinyCloud CLI can't write to its profile folder (a read-only home, or a `~/.tinycloud` owned by another user after an earlier `sudo` run), setup now stops with an error that names the folder, says why, and gives the command to fix it, instead of a raw `EACCES: permission denied, mkdir` message. Nothing changes before it stops, so fix the folder and run the same command again. For a folder outside your home, the error says to ask the person who manages the computer instead of giving a command.

Details: TC-3278
