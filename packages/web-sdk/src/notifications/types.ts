/** Notification configuration. Toast placement and visibility are set through `ui`. */
export interface NotificationConfig {
  /**
   * Throw, asynchronously, for each error toast that was shown. The caller is not
   * affected; the error surfaces as an uncaught exception.
   */
  throwErrors?: boolean;
}
