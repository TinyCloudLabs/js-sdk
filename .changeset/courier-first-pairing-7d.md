---
"@tinycloud/courier": patch
---

A first-time manual pairing (`pair accept`, the B and C artifacts) now signs its peer delegations for 7 days, so a new pairing with a Courier 0.5.x peer, which refuses anything longer, works. Courier still accepts a peer delegation of up to 30 days, so a Courier 0.6 peer that signs 30 days is unaffected. Renewals are unchanged (they follow the peer's limit), and so are invitation pairings. The README now states the real rules: issued at 7 days for a new manual pairing, renewed at the peer's limit (7 days for a 0.5.x or unknown peer, up to 30 days otherwise), accepted up to 30 days. A manual pairing made by this version therefore renews at 7 days, and lapses 3.5 to 7 days after its Courier stops running.

Details: TC-3173
