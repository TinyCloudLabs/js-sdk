import {
  ARTIFACT_ENTRY,
  ArtifactBundleError,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_SOURCE_BYTES,
  canonicalArtifactPath,
  prepareHtmlArtifact,
  type ArtifactFile,
  type PrepareHtmlArtifactOptions,
} from "./bundle.js";

/**
 * Passive files (the T8 "artifact to app" hook). A folder published as one self-contained page may also carry a
 * `manifest.json` at its root and files under `knowledge/`. They describe the page (an app manifest, its knowledge
 * bundle); they are not part of it. `inlineHtmlFolder` therefore never inlines them, never lets the page reference them
 * (a reference to one is refused like any missing file), and hands them back, unchanged, in `passive`, for a publisher
 * that can store sidecar files next to the page. This module defines the split only: it does not store anything.
 *
 * The match is on the canonical path and case-insensitive, like the path-collision rule, so `Knowledge/a.md` and
 * `MANIFEST.JSON` are passive as well.
 */
export function isPassiveArtifactPath(canonicalPath: string): boolean {
  const lower = canonicalPath.toLowerCase();
  return lower === "manifest.json" || lower.startsWith("knowledge/");
}

export interface InlinedHtmlFolder {
  readonly entry: typeof ARTIFACT_ENTRY;
  /** The one self-contained document (UTF-8). Self-contained: it fetches nothing and links nowhere at render time (see `docs/share-html-bundle.md`). */
  readonly html: Uint8Array;
  /** `manifest.json` and `knowledge/**`, byte for byte, in path order. See `isPassiveArtifactPath`. */
  readonly passive: readonly ArtifactFile[];
  /** Every file the folder held, passive ones included. */
  readonly fileCount: number;
  readonly sourceBytes: number;
}

function canonicalWithPath(path: string): string {
  try {
    return canonicalArtifactPath(path);
  } catch (error) {
    if (error instanceof ArtifactBundleError) throw new ArtifactBundleError(error.kind, error.message, path);
    throw error;
  }
}

/**
 * Inline a folder (a root `index.html` and the files it uses) into one self-contained HTML document, under the rules of
 * `prepareHtmlArtifact` and with `singlePage`: the stylesheets, scripts, images and fonts the page uses are inlined as
 * `<style>`, `<script>` and `data:` URLs, and everything else is refused (external references, `<base>`, frames,
 * forms, event-handler attributes, modules, links to other pages, ...). Files the page does not use are left out. Nothing
 * outside `files` is read.
 *
 * Refusals are `ArtifactBundleError`s; `path` and `reference` name the offending input.
 */
export async function inlineHtmlFolder(files: readonly ArtifactFile[], options: Omit<PrepareHtmlArtifactOptions, "singlePage"> = {}): Promise<InlinedHtmlFolder> {
  if (files.length === 0) throw new ArtifactBundleError("malformed", "artifact bundle is empty");
  if (files.length > MAX_ARTIFACT_FILES) throw new ArtifactBundleError("limit", "artifact has too many files");
  const canonical = new Map<string, ArtifactFile>();
  const aliases = new Map<string, string>();
  let sourceBytes = 0;
  for (const candidate of files) {
    const path = canonicalWithPath(candidate.path);
    const alias = path.toLowerCase();
    if (aliases.has(alias)) throw new ArtifactBundleError("malformed", "artifact paths collide after canonicalization", path);
    aliases.set(alias, path);
    sourceBytes += candidate.bytes.byteLength;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_ARTIFACT_SOURCE_BYTES) {
      throw new ArtifactBundleError("limit", "artifact source exceeds limit", path);
    }
    canonical.set(path, { ...candidate, path });
  }
  if (!canonical.has(ARTIFACT_ENTRY)) throw new ArtifactBundleError("missing", "artifact root index is missing", ARTIFACT_ENTRY);
  const active: ArtifactFile[] = [];
  const passive: ArtifactFile[] = [];
  for (const file of canonical.values()) (isPassiveArtifactPath(file.path) ? passive : active).push(file);
  const prepared = await prepareHtmlArtifact(active, { ...options, singlePage: true });
  passive.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    entry: ARTIFACT_ENTRY,
    html: new TextEncoder().encode(prepared.pages[ARTIFACT_ENTRY]!),
    passive,
    fileCount: canonical.size,
    sourceBytes,
  };
}
