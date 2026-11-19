---
"@tinycloud/cli": minor
---

New `tinycloud feed card-md --agent <token>` reads the owner's card.md from the agent's own response database and prints `{text, version, updatedAt}`, or `null` when the owner's Feed has not delivered one. `feed publish` and `feed watch` print "The owner's card.md changed (<version>):" and the new text on stderr once for each version a profile has not shown yet, and stay silent otherwise; a card.md that cannot be read never fails them, and a row whose version does not match its text is ignored. The last shown version is kept per feed in the profile folder and never leaves the computer.

Details: TC-3345
