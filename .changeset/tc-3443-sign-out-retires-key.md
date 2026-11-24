---
"@tinycloud/web-sdk": minor
---

Signing out asks each TinyCloud node the session used to stop accepting its session key and the keys created while setting up the account. Sign-out on this device finishes without waiting for the nodes. A node counts as done only when it confirms it recorded this; a node that can't be reached or doesn't support it keeps accepting those keys until the latest grant they hold ends, which can be after the session expires if the session was renewed or holds a longer delegation. `nodeSignOutStatus()` on `TinyCloudNode` and the web SDK resolves when the node calls finish and lists the nodes that confirmed (`confirmed`), had nothing to record (`nothingToRecord`) and didn't confirm (`notConfirmed`, each with a reason: unreachable, refused, unsupported or failed).

Only the instance that set up the account holds its setup keys. After a reload, sign-out can't send them, and they expire on their own (7 days by default). Access the user gave apps and agents before signing out stays until they remove it in Settings.

Details: TC-3443
