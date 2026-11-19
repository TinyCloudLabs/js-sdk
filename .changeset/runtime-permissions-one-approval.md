---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`grantRuntimePermissions` (and so `TinyCloudWeb.requestPermissions`) asks for one signature for a request that spans several spaces: it prepares one SIWE whose ReCap lists each space's abilities, signs it once, and activates it once. Each space still gets its own `PortableDelegation` (all proven by the same signed session), and each space's access works as before. Previously every space needed its own signature, so an OpenKey user saw one approval per space.

A requested space that does not exist is never created. The node attaches the grant only to the spaces it hosts; when it skips a space that has no location record (a space that was never set up), the call throws `MissingSpacesError` (code `SPACE_NOT_FOUND`), whose `missingSpaceIds` lists the spaces that got nothing and whose `delegations` holds the grants that did activate for the existing spaces (they are installed and usable). Before this change such a grant was returned as if it had been granted. A space the registry routes to a node that then skips it is still a routing fault and still throws `RESOURCE_NOT_ROUTED` with nothing installed. The one approval still names a missing space, because the SDK can only learn that a space is missing when the node answers the signed request.

The same `MissingSpacesError` (every requested space listed, `delegations` empty) is thrown when the owner is registered and the signed location record lists none of the requested spaces, which is what a never-set-up space looks like for a registered owner; before, that surfaced as `NodeNotFoundError`. An unregistered owner or an unreachable registry still throws as before.

A request naming a space this account does not own now throws before any signature is asked for (`code: "SPACE_NOT_OWNED"`, `spaceIds`).

`MissingSpacesError` is exported from `@tinycloud/node-sdk`, `@tinycloud/node-sdk/core` and `@tinycloud/web-sdk`.

Details: TC-3338
