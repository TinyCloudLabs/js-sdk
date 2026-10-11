/**
 * Grant resources needed to cover a replica selector's complete namespace.
 * Bare selectors select an exact key and its slash descendants; root and
 * trailing-slash selectors each name a single grant path.
 */
export function grantPathsForSelector(selector: string): string[] {
  return selector === "" || selector.endsWith("/")
    ? [selector]
    : [selector, `${selector}/`];
}
