/**
 * `@tinycloud/share-sdk/web-recipient`: the browser recipient surface.
 * Its own entry so web-sdk does not retain the rest of the package barrel.
 * The contents are fixed to these three names; adding one is a public-surface review.
 */
export { inspectShare, type ShareMetadata } from "./receive.js";
export { ShareRecipientClient } from "./recipient.js";
