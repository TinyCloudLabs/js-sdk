---
"@tinycloud/cli": minor
---

`tc secrets migrate` asks the owner for one approval to move secrets. It first lists and checks the secrets with read access only, which needs no prompt when the sign-in already includes it. Then one request covers writing the secrets, decrypting the older format with the network key and creating a key for each secret left to move. The approval lasts one hour and is not renewed. The request is split only when it would not fit the node's header limit; the first part then carries the write and network access with its keys, and the others carry keys only.

Details: TC-4246
