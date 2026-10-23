# @tinycloud/share-sdk

## Subpath exports

- `@tinycloud/share-sdk/web-recipient`: `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type. The browser recipient surface, imported without the package root barrel. Its contents are fixed to these three names.

The `web-recipient` subpath is its own build entry, and the package builds with `splitting: false` (`tsup.config.ts`). The subpath therefore holds its own copies of `inspectShare` and `ShareRecipientClient`, separate from the root barrel's. Do not rely on `instanceof` across the root and the subpath. Compare behaviour (inputs, results, error codes) instead.

The credential witness answers browser requests only for the origins it is configured with, so an app on another origin can be refused until its origin is added to the witness configuration.

When set, openerOrigin and completionOrigin must be https origins: web-sdk credential acquisition rejects anything else, and the witness enforces the same rule.
