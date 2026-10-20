/**
 * Parsing for OKF v0.2 knowledge files: a markdown body with optional YAML
 * frontmatter. Frontmatter in a knowledge bundle uses a small YAML subset
 * (scalars, quoted strings, flow and block lists, nested maps). Anything
 * outside it is reported, never guessed at.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

export interface ParsedConcept {
  /** `null` when the file has no frontmatter or it could not be parsed. */
  readonly frontmatter: { [key: string]: YamlValue } | null;
  /** Why frontmatter is `null` despite the file having a frontmatter block. */
  readonly frontmatterError?: string;
  /** The unparsed frontmatter text, present only with `frontmatterError`. */
  readonly frontmatterRaw?: string;
  readonly body: string;
}

export interface IndexLink {
  readonly title: string;
  readonly target: string;
}

interface Line {
  readonly indent: number;
  readonly text: string;
}

class FrontmatterError extends Error {}

export function parseConcept(source: string): ParsedConcept {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (match === null || match.index !== 0) return { frontmatter: null, body: text };
  const raw = match[1] ?? "";
  const body = text.slice(match[0].length);
  try {
    const lines = toLines(raw);
    if (lines.length === 0) return { frontmatter: {}, body };
    const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
    if (next < lines.length || value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new FrontmatterError("Frontmatter must be a single mapping.");
    }
    return { frontmatter: value, body };
  } catch (error) {
    if (!(error instanceof FrontmatterError)) throw error;
    return { frontmatter: null, frontmatterError: error.message, frontmatterRaw: raw, body };
  }
}

/** Local markdown links in an index file, in order. External links and anchors are skipped. */
export function indexLinks(body: string): IndexLink[] {
  const links: IndexLink[] = [];
  for (const match of body.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const target = match[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    links.push({ title: match[1]!, target });
  }
  return links;
}

function toLines(raw: string): Line[] {
  const lines: Line[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s*\t/.test(line)) throw new FrontmatterError("Tabs are not allowed for indentation.");
    const text = line.trimStart();
    lines.push({ indent: line.length - text.length, text: text.trimEnd() });
  }
  return lines;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start]!;
  return first.text === "-" || first.text.startsWith("- ")
    ? parseList(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseMap(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const map: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new FrontmatterError(`Unexpected indentation near "${line.text}".`);
    if (line.text === "-" || line.text.startsWith("- ")) break;
    const [key, rest] = splitKey(line.text);
    if (Object.prototype.hasOwnProperty.call(map, key)) throw new FrontmatterError(`Duplicate key "${key}".`);
    index += 1;
    if (rest !== "") {
      map[key] = parseScalar(rest);
      continue;
    }
    const next = lines[index];
    const nested = next !== undefined &&
      (next.indent > indent || (next.indent === indent && (next.text === "-" || next.text.startsWith("- "))));
    if (!nested) {
      map[key] = null;
      continue;
    }
    const [value, after] = parseBlock(lines, index, next.indent);
    map[key] = value;
    index = after;
  }
  return [map, index];
}

function parseList(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const list: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new FrontmatterError(`Unexpected indentation near "${line.text}".`);
    if (line.text !== "-" && !line.text.startsWith("- ")) break;
    const rest = line.text.slice(1).trimStart();
    if (rest === "") {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        list.push(null);
        index += 1;
      } else {
        const [value, after] = parseBlock(lines, index + 1, next.indent);
        list.push(value);
        index = after;
      }
      continue;
    }
    if (isMapEntry(rest)) {
      // `- key: value` opens a mapping whose later keys align with the first.
      const entryIndent = indent + (line.text.length - rest.length);
      const synthetic: Line[] = [{ indent: entryIndent, text: rest }, ...lines.slice(index + 1)];
      const [value, used] = parseMap(synthetic, 0, entryIndent);
      list.push(value);
      index += used;
      continue;
    }
    list.push(parseScalar(rest));
    index += 1;
  }
  return [list, index];
}

function isMapEntry(text: string): boolean {
  if (/^["'[{]/.test(text)) return false;
  return /^[^\s:#][^:#]*:(\s|$)/.test(text);
}

function splitKey(text: string): [string, string] {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*)|$)/.exec(text);
  if (quoted !== null) return [String(parseScalar(quoted[1]!)), (quoted[2] ?? "").trim()];
  const match = /^([^\s:#][^:#]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (match === null) throw new FrontmatterError(`Expected "key: value", found "${text}".`);
  if (match[1] === "__proto__") throw new FrontmatterError("Unsupported key \"__proto__\".");
  return [match[1]!, stripComment((match[2] ?? "").trim())];
}

function stripComment(value: string): string {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s+#.*$/.exec(value);
  if (quoted !== null) return quoted[1]!;
  if (/^["']/.test(value)) return value;
  return value.replace(/\s+#.*$/, "");
}

function parseScalar(raw: string): YamlValue {
  const text = stripComment(raw.trim());
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new FrontmatterError(`Unterminated string ${text}.`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[")) return parseFlow(text, "[", "]");
  if (text.startsWith("{")) return parseFlow(text, "{", "}");
  if (/^[|>&*!%@`]/.test(text)) {
    throw new FrontmatterError(`Unsupported YAML construct "${text.slice(0, 1)}".`);
  }
  return text;
}

function parseDoubleQuoted(text: string): string {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) throw new FrontmatterError(`Unterminated string ${text}.`);
  try {
    return JSON.parse(text) as string;
  } catch {
    throw new FrontmatterError(`Invalid escape in string ${text}.`);
  }
}

function parseFlow(text: string, open: string, close: string): YamlValue {
  if (!text.endsWith(close)) throw new FrontmatterError(`Unterminated flow collection ${text}.`);
  const items = splitFlow(text.slice(1, -1));
  if (open === "[") return items.map((item) => parseScalar(item));
  const map: { [key: string]: YamlValue } = {};
  for (const item of items) {
    const [key, rest] = splitKey(item);
    if (Object.prototype.hasOwnProperty.call(map, key)) throw new FrontmatterError(`Duplicate key "${key}".`);
    map[key] = parseScalar(rest);
  }
  return map;
}

/** Split on top-level commas, respecting quotes and nested flow collections. */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += inner[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (quote !== undefined || depth !== 0) throw new FrontmatterError("Unbalanced flow collection.");
  if (current.trim() !== "") items.push(current.trim());
  return items;
}
