import { safeBlock, safeInline } from "../output/safe-text.js";

/**
 * Human output of `knowledge list|read`. Everything here was written by
 * whoever can write the user's space, so every string goes through the
 * terminal-safe helpers; `--json` never uses these.
 */

export interface ListedApp {
  readonly app_id: string;
  readonly name?: string;
  readonly root: string;
  readonly has_index: boolean;
  readonly concepts: readonly string[];
}

export interface ReadKnowledge {
  readonly key: string;
  readonly frontmatter: unknown;
  readonly body: string;
}

/** Table rows for `knowledge list`: app id, name, root, concept count. */
export function knowledgeListRows(apps: readonly ListedApp[]): string[][] {
  return apps.map((app) => [
    safeInline(app.app_id),
    app.name === undefined ? "—" : safeInline(app.name),
    safeInline(app.has_index ? app.root : `${app.root} (no index)`),
    String(app.concepts.length),
  ]);
}

/** The pieces of `knowledge read`: the key, the parsed frontmatter on one line, the file content. */
export function knowledgeReadParts(output: ReadKnowledge): { heading: string; meta?: string; body: string } {
  const body = safeBlock(output.body);
  return {
    heading: safeInline(output.key),
    ...(output.frontmatter === null ? {} : { meta: safeInline(JSON.stringify(output.frontmatter)) }),
    body: body.endsWith("\n") ? body : `${body}\n`,
  };
}
