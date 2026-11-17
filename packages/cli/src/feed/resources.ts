/**
 * The owner's feed resources, in the `applications` space. The output and response databases of every agent sit under
 * `${FEED_PREFIX}/` (`feed_output_<token>`, `feed_responses_<token>`); the registry of connected agents is one database.
 * `feed` and the feed onboarding preset read these from here so the grant asked for and the resources used cannot drift.
 */
export const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";
export const FEED_REGISTRY = "xyz.tinycloud.tinychat/home_feed";
