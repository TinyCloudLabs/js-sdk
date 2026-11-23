---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
"@tinycloud/sdk-services": patch
---

`courier watch` and `tc courier watch` now use a verified extension of the owner's grant without restarting. Running watchers can renew existing peer access before the original grants expire, without changing what either peer can read.

Automatic renewal shortens its cooldown when the owner grant limits a peer grant to a short lifetime. Manual renewal and artifact export retain their existing cooldown.

Overlapping watch checks no longer treat a peer grant that is being renewed as an orphan and revoke it.

Installing a successor immediately switches the watcher's hook and read checks to the new grant. A refusal from a superseded grant no longer stops access under its successor.

Watchers retry a rejected invocation once if it was signed before a suspend or cannot establish which grant was refused. Only a refusal of the installed peer grant stops access; a denial of an expired invocation does not mark a peer as revoked.

After the original owner deadline, Courier confirms a still-signed-live successor by its exact delegation CID when the node's issued listing does not account for renewal. Missing or revoked authority still fails closed.

After a sibling grant is revoked, Courier also confirms and revokes any live successor that the issued listing incorrectly reports as expired.

Details: TC-3522
