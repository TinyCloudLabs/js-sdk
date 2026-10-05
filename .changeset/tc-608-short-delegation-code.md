---
"@tinycloud/cli": minor
---

Manual OpenKey login now accepts an eight-character delegation retrieval code in `tc auth login --paste` and the interactive callback fallback. The CLI checks that the fetched public delegation belongs to its local session key. Full JSON and base64 delegation paste remain available when the broker cannot be reached.
