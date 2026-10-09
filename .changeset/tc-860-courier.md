---
"@tinycloud/courier": minor
"@tinycloud/cli": minor
---

New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

`@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

`courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.
