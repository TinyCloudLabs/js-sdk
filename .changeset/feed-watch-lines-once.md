---
"@tinycloud/cli": minor
"@tinycloud/sdk-services": minor
---

`tinycloud feed watch` no longer needs `--runner`: without it, each new owner response is printed as one JSON line on stdout. `--once` exits after the first batch of new responses is handed off, so an agent whose tools return only when a command exits can run the watcher in the background and be woken by the owner's next answer or comment. `listenFeedResponses` takes the matching `once` option.

Fixed: an idle `feed watch` no longer exits with status 0 after about a minute. That happened when the node closed an idle hooks stream and nothing kept Node's event loop alive during the reconnect backoff.

Details: TC-2205
