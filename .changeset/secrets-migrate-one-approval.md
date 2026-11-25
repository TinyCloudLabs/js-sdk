---
"@tinycloud/cli": patch
---

`tc secrets migrate` asks the owner for one approval to move secrets instead of two. It first lists and checks the secrets with read access only, which needs no prompt when the sign-in already includes it. Then one request covers writing the secrets, decrypting the older format with the network key, and creating and using a key for each secret still to move. The approval lasts one hour and is not renewed. The request is split only when it would not fit the node's header limit; the first part then carries the write and network access with its keys, and the others carry keys only.

Details: TC-4246
