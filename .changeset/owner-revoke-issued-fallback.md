---
"@tinycloud/cli": patch
---

`tinycloud delegation revoke <cid>` from an owner profile can now revoke a grant that profile's own key issued, such as one made with `feed connect`. When the node lists the CID as issued by this profile's key, the CLI revokes it with that key, with no owner approval. A CID the node doesn't list as issued by this key is still refused, and a network or node failure is reported as an error.

Details: TC-3150
