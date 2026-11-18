---
"@tinycloud/cli": patch
---

`tinycloud delegation revoke <cid>` from an owner profile now also checks the delegations that profile's own key issued. Before, a grant made with `feed connect` (or any grant the owner session issued) failed with TARGET_NOT_FOUND because the owner session cannot list the account's delegations and the CLI kept no record of it. Now, when the node lists the CID as issued by this profile's key, the CLI revokes it with that key and asks for no owner approval. A CID the node does not list as issued by this key is still refused, and a network or node failure is reported as an error.

Details: TC-3150
