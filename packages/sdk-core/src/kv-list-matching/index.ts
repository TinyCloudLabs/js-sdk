/**
 * listMatching - client-side "keys starting with a partial segment" listing.
 *
 * A standalone function on its own subpath entry
 * (`@tinycloud/sdk-core/kv-list-matching`), like `held-credentials`: it is not
 * part of `IKVService`, `KVService`, the sdk-core or sdk-services root
 * barrels, or the replica kv-storage worker, so no bundle that doesn't import
 * this entry carries it.
 */

import { ErrorCodes, err, ok, serviceError } from "@tinycloud/sdk-services";
import type {
  KVListOptions,
  KVListResponse,
  Result,
} from "@tinycloud/sdk-services";

/**
 * Anything with a `list` that accepts the non-prefix list options: an
 * {@link IKVService}, a {@link KVService}, or a prefixed view from
 * `withPrefix` ({@link IPrefixedKVService}).
 */
export interface KVListSource {
  list(options?: Omit<KVListOptions, "prefix">): Promise<Result<KVListResponse>>;
}

/**
 * Options for {@link listMatching}.
 *
 * These are the {@link KVListOptions} that still make sense once the helper
 * owns the folder and the paging:
 *
 * - `prefix` and `path` are omitted: the first argument of `listMatching` is
 *   the prefix, and the helper derives the folder it lists from it.
 * - `cursor` is omitted: the helper starts at the first page and follows the
 *   node's cursors itself, so a caller cannot resume or skip pages.
 * - `raw` is omitted: the helper has to read the key array to filter it.
 *
 * `limit` is kept and means **page size**, not a cap on the result: the helper
 * still reads every page. `removePrefix` returns the names relative to the
 * folder (`qa/b00` matched by `qa/b` comes back as `b00`). `signal`, `timeout`
 * and `source` apply to every page request (`timeout` is per request, not for
 * the whole walk).
 */
export type KVListMatchingOptions = Omit<
  KVListOptions,
  "prefix" | "path" | "cursor" | "raw"
>;

/**
 * List the keys that start with a *partial* path segment, e.g. every key
 * beginning `qa/b`, including `qa/b00` and `qa/b01`.
 *
 * **Where to import it:** `import { listMatching } from
 * '@tinycloud/sdk-core/kv-list-matching'`. This is the import for browser
 * apps too (web-sdk already depends on sdk-core). It is deliberately not
 * exported from any package root (sdk-core, sdk-services, web-sdk, node-sdk),
 * to keep their bundles unchanged. node-sdk builds with `moduleResolution:
 * "node"`, which cannot resolve package subpaths, so it has no re-export;
 * import this entry directly.
 *
 * ## Why this is a helper and not a `list` option
 *
 * Since node 1.19.0 (TC-731) the node matches list prefixes on **whole path
 * segments**: `list({ prefix: 'qa/b' })` returns the key `qa/b` and everything
 * under `qa/b/`, and does **not** return `qa/b00`. This is deliberate. A list
 * *is* the authorization scope: a grant on `docs` must not let its holder
 * enumerate `docsecret/...`, and a partial-segment match would disclose key
 * names across exactly that grant boundary. (Matching is also case-exact.) So
 * the node will never do "starts with" for you, and a caller that wants "names
 * starting with X" has to do it client-side. This is that client-side helper.
 *
 * ## What it does
 *
 * 1. Splits `prefix` at its last `/`. The *folder* is everything up to and
 *    including that `/` (the root of `kv`, `""`, if there is no `/`); the
 *    *partial* is the rest.
 * 2. Calls the ordinary `kv.list` on the folder, following every `nextCursor`
 *    until the node reports no more pages.
 * 3. Keeps the keys whose segment after the folder starts with the partial and
 *    returns them as `{ keys }`, the same shape as `list`. `truncated` and
 *    `nextCursor` are never set: the result is complete, not a page.
 *
 * | `prefix`  | folder listed | partial | matches                          |
 * | --------- | ------------- | ------- | -------------------------------- |
 * | `qa/b`    | `qa/`         | `b`     | `qa/b`, `qa/b/x`, `qa/b00`       |
 * | `qa/b/`   | `qa/b/`       | (empty) | everything under `qa/b/`         |
 * | `qa/b/c`  | `qa/b/`       | `c`     | `qa/b/c`, `qa/b/cat`, `qa/b/c/x` |
 * | `b`       | `""` (root)   | `b`     | `b`, `b/x`, `b00`                |
 * | `""`      | `""` (root)   | (empty) | every key under `kv`             |
 *
 * A name that matches *and* has children returns the name **and** its
 * descendants (`qa/b` and `qa/b/x` above). That is not extra logic: `list` is
 * recursive, so the folder listing already contains the descendants, and the
 * filter only looks at the start of the name. Callers that want one entry per
 * name must collapse on the first segment after the folder themselves.
 *
 * ## Prefixed views
 *
 * The folder is passed to `list` as `path`, so it is resolved relative to
 * whatever base the source already has: nothing for a plain service, the view's
 * prefix for `kv.withPrefix('notes')`. On a view, `listMatching(notes, 'qa/b')`
 * lists `notes/qa/` and returns keys relative to the view, like `view.list()`.
 * Returned keys are always `folder + name`; on a plain `KVService` configured
 * with its own `prefix` that means relative to that prefix, not full keys.
 *
 * ## Authorization
 *
 * The helper never widens scope. It issues only normal `list` calls on the
 * folder, so a delegated session sees exactly what its grant allows for that
 * folder. If the folder itself is outside the grant, the result is the same
 * error `list` returns for it (nothing is retried against a narrower or wider
 * prefix). Consequently a grant on `qa/b00` alone cannot use
 * `listMatching(kv, 'qa/b')`: listing `qa/` is outside that grant. List the
 * folder the grant covers instead.
 *
 * ## Cost
 *
 * **It fetches every key in the folder**, page after page, then discards the
 * ones that don't match. The work is proportional to the size of the
 * *folder*, not the number of matches: a folder with 100 000 keys takes
 * hundreds of requests even if one key matches. Page size (`limit`) tunes the
 * number of requests, not the amount of data read.
 *
 * ## When to use it
 *
 * - UI type-ahead / autocomplete over a folder of modest size.
 * - Small folders, one-off lookups, scripts and debugging.
 *
 * ## When not to
 *
 * - Large or unbounded folders, or anything on a hot path. Give the data a real
 *   folder structure instead (`users/<id>/...`, one folder per bucket, day or
 *   shard) so the thing you look up is a whole segment and a plain
 *   `list({ prefix })` answers it in one request, within the grant.
 *
 * A failed page returns that page's error and discards what was gathered so
 * far; there is no partial result. Pass `signal` to abort a long walk.
 *
 * @param kv - A KV service or prefixed view; only its `list` is called
 * @param prefix - Key prefix, possibly ending mid-segment
 * @param options - Optional per-page list configuration
 * @returns Result with every key starting with `prefix`
 *
 * @example
 * ```typescript
 * // Keys: qa/b00, qa/b01, qa/c00
 * const result = await listMatching(kv, 'qa/b');
 * if (result.ok) {
 *   console.log(result.data.keys); // ['qa/b00', 'qa/b01']
 * }
 * ```
 */
export async function listMatching(
  kv: KVListSource,
  prefix: string,
  options?: KVListMatchingOptions
): Promise<Result<KVListResponse>> {
  // Split at the last "/": the folder keeps its trailing slash, so it is a
  // whole-segment prefix the node accepts as is ("qa/b" -> "qa/"). With no
  // "/" the folder is "" (the source's own root).
  const split = prefix.lastIndexOf("/") + 1;
  const folder = prefix.slice(0, split);
  const partial = prefix.slice(split);

  // `removePrefix` is always on for the underlying list, so keys come back
  // relative to the folder whatever the source's default is (a prefixed view
  // strips by default, a plain service does not). The caller's own
  // `removePrefix` only decides what we hand back.
  const { removePrefix, ...pageOptions } = options ?? {};

  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    // Only the ordinary `list`, only on the folder: the node authorizes each
    // page exactly as it would for a caller using `list` directly, so a
    // delegated session sees no more than its grant allows, and a folder
    // outside the grant fails with the error `list` produces. We never list
    // anything wider or different from `folder`.
    const page = await kv.list({
      ...pageOptions,
      path: folder,
      removePrefix: true,
      cursor,
    });
    // A failure on any page discards what was gathered: a silently truncated
    // match list would look like "no more matches".
    if (!page.ok) return page;

    // The node's list is recursive, so `startsWith(partial)` on the
    // folder-relative key means "the segment after the folder starts with the
    // partial". A match that also has children returns the key and its
    // descendants, exactly as `list` reports them.
    for (const name of page.data.keys) {
      if (name.startsWith(partial)) names.push(name);
    }

    const next = page.data.nextCursor;
    if (next === undefined) break;
    // A node that echoes the cursor we just sent would make this loop forever
    // (pre-1.19 nodes ignored cursors on list-only requests).
    if (next === cursor) {
      return err(
        serviceError(
          ErrorCodes.NETWORK_ERROR,
          `KV listMatching: the node returned the same cursor twice while listing "${folder}"; stopping instead of looping`,
          "kv"
        )
      );
    }
    cursor = next;
  }

  return ok({ keys: removePrefix ? names : names.map((name) => folder + name) });
}
