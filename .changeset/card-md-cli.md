---
"@tinycloud/cli": minor
"@tinycloud/sdk-services": minor
---

`feed card-md` prints the owner's card.md (`{text, version, updatedAt}`). When the owner hasn't set one, it prints the default (`{text, version, default: true}`). `feed publish` adds `cardMd: {version}` to its JSON, with `default: true` while it is the default, and `feed publish` and `feed watch` print the text once on stderr when its version differs from the last one this profile saw for that agent. `feed connect` copies the owner's card.md into the new agent's response database. An agent connected before card.md existed reads it with the same grant, without reconnecting. `@tinycloud/sdk-services` adds `readFeedCardMd` and an optional `onWake` callback on `listenFeedResponses`, run at the start of every drain.

Details: TC-3345
