---
"@tinycloud/courier": minor
---

Courier pairing now accepts artifacts from a different Courier agent key of the same owner, so two agents sharing one `did:pkh` pair like any two agents. Pairing still refuses the agent's own courier DID, and the peer delegation binding is unchanged. Tested with an isolated same-owner A→B→C exchange plus self-pair, key-substitution and different-owner regression checks.

Details: TC-1248
