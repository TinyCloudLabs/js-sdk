---
"@tinycloud/cli": patch
---

The CLI updates itself. After a command, it installs a newer patch or minor release of your channel in the background, once that release has been out for 6 hours and passes the provenance and npm signature checks; your next command uses it. A new major release gets a notice only. Turn it off with `TC_NO_AUTO_UPDATE=1` or `"autoUpdate": false` in `~/.tinycloud/config.json`; it is off when `CI` is set to anything but `false` or `0`.

`tinycloud upgrade` checks provenance and npm signatures, installs the exact version next to the current one and switches only after the new version runs. `--to <version>` switches to an exact version and pauses automatic updates. Outside a terminal it needs `--yes`. Exit codes: 12 refused, 13 failed (the previous version runs), 14 failed and not restored.

Versions live in `~/.tinycloud/versions`. To uninstall, run `npm uninstall -g @tinycloud/cli` (or `bun remove -g @tinycloud/cli`), then delete `~/.tinycloud/versions`. The standalone `courier` (`npm i -g @tinycloud/courier`) isn't updated this way; reinstall it by hand.

Details: TC-4276
