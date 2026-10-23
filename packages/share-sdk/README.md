# @tinycloud/share-sdk

## Subpath exports

- `@tinycloud/share-sdk/web-recipient`: `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type. The browser recipient surface, imported without the package root barrel. Its contents are fixed to these three names.

The web-recipient subpath is its own build entry, built with splitting: false, so it ships its own copies of inspectShare and ShareRecipientClient. Use the subpath's exports together, and check results by their fields rather than by class identity.

The credential witness answers browser requests only for the origins it is configured with.

openerOrigin and completionOrigin must be https origins (openerOrigin defaults to the page's own origin): web-sdk credential acquisition rejects anything else, and the witness enforces the same rule.
