// One canonical mailbox/domain rule for senders and receivers. It lives in
// share-envelope because the Share SDK cannot depend on sdk-core (sdk-core
// depends on the Share SDK).
export { canonicalEmailDomain, canonicalMailbox, isCanonicalEmailDomain, mailboxBelongsToDomain } from "@tinycloud/share-envelope";
