/** Notification configuration. Toast placement and visibility are set through `ui`. */
export interface NotificationConfig {
  /**
   * Rethrow each reported error asynchronously as an uncaught exception, unless
   * `ui: false`. Identical errors within 200 ms collapse into one throw. The
   * caller is not affected.
   */
  throwErrors?: boolean;
}
