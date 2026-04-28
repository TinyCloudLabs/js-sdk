// scripts/rebuild.mjs — `bun run atlas:rebuild`
//
// Walks the monorepo for structural facts and merges them with hand-curated
// prose under atlas/curated/*.yaml. Emits public/data/*.json which the Astro
// build then bundles into the static site verbatim.
//
// Stdlib-only by design (no TS dep). Parsing uses a small lexer pass that
// strips comments + strings before scanning for `export`/`import` statements.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd(), '..');               // js-sdk repo root
const PKGS = path.join(ROOT, 'packages');
const CURATED = path.resolve(process.cwd(), 'curated');       // atlas/curated/*.yaml
const OUT = path.resolve(process.cwd(), 'public/data');
const PACKAGE_ORDER = ['web-sdk', 'node-sdk', 'sdk-core', 'sdk-services', 'sdk-rs', 'sdk-rs/web', 'sdk-rs/node', 'cli', 'vfs'];
const DEFAULT_CHAPTERS = [
  { id: '00', title: 'Prologue · why this atlas exists', voice: 'field guide', read: 2 },
  { id: '01', title: 'Three surfaces, one core', voice: 'field guide', read: 4 },
  { id: '02', title: 'The WASM seam', voice: 'eng memo', read: 5 },
  { id: '03', title: 'SIWE → session', voice: 'tour', read: 6 },
  { id: '04', title: 'Spaces & KV', voice: 'field guide', read: 5 },
  { id: '05', title: 'Delegation chains & ReCap', voice: 'eng memo', read: 7 },
  { id: '06', title: 'Sharing — portable bundles', voice: 'tour', read: 4 },
  { id: '07', title: 'Protocol version handshake', voice: 'eng memo', read: 3 },
  { id: '08', title: 'Build topology — bun, turbo, wasm-pack', voice: 'field guide', read: 4 },
  { id: '09', title: 'Drift & rebuild — keeping this honest', voice: 'eng memo', read: 3 },
];
const DEFAULT_ENDPOINTS = [
  { method: 'GET', path: '/atlas/data/inventory.json', desc: 'full machine-readable index' },
  { method: 'GET', path: '/atlas/data/pkg/<id>.json', desc: 'single package facts (boundaries, exports, why)' },
  { method: 'GET', path: '/atlas/data/flow/<id>.json', desc: 'sequence diagram source' },
  { method: 'GET', path: '/atlas/data/state/<id>.json', desc: 'state machine source' },
  { method: 'GET', path: '/atlas/data/cmds.json', desc: 'command and service surface map' },
  { method: 'GET', path: '/atlas/data/drift.json', desc: 'what changed since last rebuild' },
  { method: 'GET', path: '/atlas/data/artifacts.json', desc: 'all atlas artifact files and freshness' },
  { method: 'GET', path: '/atlas/data/meta.json', desc: 'how this atlas was made' },
  { method: 'GET', path: '/atlas/data/llms.txt', desc: 'agent quickstart' },
];

const sh = (cmd, opts={}) => execSync(cmd, { stdio:['ignore','pipe','ignore'], ...opts }).toString().trim();

async function readJson(p) { try { return JSON.parse(await fs.readFile(p,'utf8')); } catch { return null; } }
async function exists(p)   { try { await fs.access(p); return true; } catch { return false; } }
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2));
}

// ───────── curated YAML (very small subset) ─────────
function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') quote = quote === ch ? null : ch;
    if (ch === '#' && !quote && /\s/.test(value[i - 1] ?? ' ')) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseScalar(value) {
  const raw = stripInlineComment(value);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'undefined' || raw === 'null') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = raw.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : raw;
}

function parseCuratedYaml(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    const value = stripInlineComment(rest);

    if (value === '|') {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        i++;
        block.push(lines[i].replace(/^  ?/, ''));
      }
      out[key] = block.join('\n').trim();
      continue;
    }

    if (value === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s+-/.test(lines[i + 1])) {
        i++;
        const first = lines[i].replace(/^\s+-\s*/, '');
        if (/^[A-Za-z0-9_]+:/.test(first)) {
          const item = {};
          const firstMatch = first.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (firstMatch) item[firstMatch[1]] = parseScalar(firstMatch[2]);
          while (i + 1 < lines.length && /^\s{4,}[A-Za-z0-9_]+:/.test(lines[i + 1])) {
            i++;
            const nested = lines[i].trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
            if (nested) item[nested[1]] = parseScalar(nested[2]);
          }
          items.push(item);
        } else {
          items.push(parseScalar(first));
        }
      }
      out[key] = items;
      continue;
    }

    out[key] = parseScalar(value);
  }
  return out;
}

async function readCurated(id) {
  const file = path.join(CURATED, `${id.replace(/\//g, '__')}.yaml`);
  try {
    return parseCuratedYaml(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

// ───────── package discovery ─────────
async function listPackageDirs() {
  const entries = await fs.readdir(PKGS, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PKGS, e.name);
    const pj = path.join(dir, 'package.json');
    if (await exists(pj)) out.push({ id: e.name, dir, pj });
    const nestedRoot = path.join(dir, 'packages');
    const sub = await fs.readdir(nestedRoot, { withFileTypes: true }).catch(() => []);
    for (const s of sub) {
      if (!s.isDirectory()) continue;
      const subDir = path.join(nestedRoot, s.name);
      const subPj = path.join(subDir, 'package.json');
      if (await exists(subPj)) out.push({ id: `${e.name}/${s.name}`, dir: subDir, pj: subPj });
    }
  }
  return out.sort((a, b) => {
    const ai = PACKAGE_ORDER.indexOf(a.id);
    const bi = PACKAGE_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.id.localeCompare(b.id);
  });
}

async function countLoc(dir) {
  const SKIP = new Set(['node_modules', 'dist', 'target', '.next', 'pkg']);
  let loc = 0, modules = 0;
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|js|jsx|rs)$/.test(e.name)) {
        modules++;
        const txt = await fs.readFile(full, 'utf8').catch(() => '');
        loc += txt.split('\n').length;
      }
    }
  }
  await walk(dir);
  return { loc, modules };
}

// ───────── source stripping (comments + strings) ─────────
//
// Returns the source with every comment and every string-literal body replaced
// by spaces (preserving column offsets so regex line-info still makes sense).
// Strings collapse to empty `""` so `export … from '…'` becomes
// `export … from ""` — the `from` matcher still works, the literal value is
// retrieved separately by re-scanning the original source at the same offset.
function stripCommentsAndStrings(src) {
  const out = new Array(src.length);
  let i = 0;
  let mode = 'code'; // code | line-comment | block-comment | sq | dq | bt
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'line-comment'; continue; }
      if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'block-comment'; continue; }
      if (ch === "'") { out[i] = "'"; i++; mode = 'sq'; continue; }
      if (ch === '"') { out[i] = '"'; i++; mode = 'dq'; continue; }
      if (ch === '`') { out[i] = '`'; i++; mode = 'bt'; continue; }
      out[i] = ch; i++; continue;
    }
    if (mode === 'line-comment') {
      if (ch === '\n') { out[i] = '\n'; i++; mode = 'code'; continue; }
      out[i] = ' '; i++; continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'code'; continue; }
      out[i] = ch === '\n' ? '\n' : ' '; i++; continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'bt') {
      const closer = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
      if (ch === '\\' && i + 1 < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch === closer) { out[i] = closer; i++; mode = 'code'; continue; }
      out[i] = ch === '\n' ? '\n' : ' '; i++; continue;
    }
  }
  return out.join('');
}

// Pull the literal between matching quotes starting at index `q` in the
// original source. Returns the unescaped string body or null on failure.
function readStringAt(src, q) {
  const quote = src[q];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let out = '';
  let i = q + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
    if (ch === quote) return out;
    out += ch; i++;
  }
  return null;
}

// ───────── export parsing ─────────
//
// Returns { exports: Map<name, kind>, reexportAll: [{ specifier, asName?, typeOnly }] }
// where kind ∈ {value, type, default}. Re-export-all entries are returned
// separately so the caller can recurse into each `from` target.
function parseExportsFromStripped(stripped, source, fileLabel) {
  const exports = new Map(); // name → kind ('value'|'type'|'default')
  const reexportAll = [];    // { specifier, asName?, typeOnly }
  const warnings = [];

  const setKind = (name, kind) => {
    if (!name) return;
    const prev = exports.get(name);
    // value beats type beats default? we only need to ensure type doesn't downgrade value
    if (prev === 'value' || prev === 'default') return;
    exports.set(name, kind);
  };

  // Walk character-by-character, looking for `export` keyword at a token
  // boundary (whitespace or start-of-file before, non-identifier after).
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < stripped.length) {
    // find next 'export'
    const j = stripped.indexOf('export', i);
    if (j === -1) break;
    const before = j === 0 ? '\n' : stripped[j - 1];
    const after = stripped[j + 6] ?? ' ';
    if (isIdent(before) || isIdent(after)) { i = j + 6; continue; }
    // we're at an export keyword — determine its form
    const cursor = parseExportStatement(stripped, source, j + 6, { setKind, reexportAll, warnings, fileLabel });
    i = cursor;
  }

  return { exports, reexportAll, warnings };
}

function parseExportStatement(stripped, source, start, ctx) {
  // Skip whitespace
  let i = start;
  while (i < stripped.length && /\s/.test(stripped[i])) i++;

  // case: export type ... (could be `export type {`, `export type Foo`, `export type * from`)
  let typeOnly = false;
  if (stripped.startsWith('type', i) && /\s/.test(stripped[i + 4] ?? '')) {
    // distinguish `export type {` / `export type *` / `export type Foo =` from `export type` used as
    // a value (it isn't, in TS). All cases here are type-only.
    typeOnly = true;
    i += 4;
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
  }

  // case: `export * [as Foo] from '...'`
  if (stripped[i] === '*') {
    i++;
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    let asName = null;
    if (stripped.startsWith('as', i) && /\s/.test(stripped[i + 2] ?? '')) {
      i += 2;
      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      const m = /^([A-Za-z_$][\w$]*)/.exec(stripped.slice(i));
      if (m) { asName = m[1]; i += m[1].length; }
    }
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (stripped.startsWith('from', i) && /\s/.test(stripped[i + 4] ?? '')) {
      i += 4;
      while (i < stripped.length && /\s/.test(stripped[i])) i++;
      const q = i;
      if (stripped[q] === '"' || stripped[q] === "'" || stripped[q] === '`') {
        const lit = readStringAt(source, q);
        if (lit != null) {
          if (asName) {
            // export * as Foo from '...' — exposes a single value namespace
            ctx.setKind(asName, typeOnly ? 'type' : 'value');
          } else {
            ctx.reexportAll.push({ specifier: lit, typeOnly });
          }
          // advance past the closing quote
          i = q + 1 + lit.length + 1;
        }
      }
    }
    return i;
  }

  // case: `export { ... } [from '...']`
  if (stripped[i] === '{') {
    const close = stripped.indexOf('}', i);
    if (close === -1) {
      ctx.warnings.push(`unterminated export block in ${ctx.fileLabel}`);
      return i + 1;
    }
    const body = stripped.slice(i + 1, close);
    let cursor = close + 1;
    while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor++;
    let isReexport = false;
    if (stripped.startsWith('from', cursor) && /\s/.test(stripped[cursor + 4] ?? '')) {
      isReexport = true;
      cursor += 4;
      while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor++;
      const q = cursor;
      if (stripped[q] === '"' || stripped[q] === "'" || stripped[q] === '`') {
        const lit = readStringAt(source, q);
        if (lit != null) cursor = q + 1 + lit.length + 1;
      }
    }
    // tokenize specifiers in the body. Each spec is one of:
    //   X, X as Y, type X, type X as Y, default as Y, X as default
    for (const raw of body.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const m = item.match(/^(?:(type)\s+)?([A-Za-z_$][\w$]*|\*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/);
      if (!m) {
        ctx.warnings.push(`unparsed export specifier "${item}" in ${ctx.fileLabel}`);
        continue;
      }
      const isItemTypeOnly = typeOnly || !!m[1];
      const orig = m[2];
      const aliased = m[3] ?? orig;
      // exported name is the alias (or the original if no alias). `default as X` -> X (value).
      // `X as default` -> 'default' export.
      let outName;
      let outKind;
      if (aliased === 'default') {
        outName = 'default';
        outKind = 'default';
      } else {
        outName = aliased;
        outKind = isItemTypeOnly ? 'type' : 'value';
      }
      // skip aggregating bare '*' (shouldn't appear in `{ }` form)
      if (outName === '*') continue;
      ctx.setKind(outName, outKind);
    }
    void isReexport; // semantic info we don't need to track separately
    return cursor;
  }

  // case: `export default …`
  if (stripped.startsWith('default', i) && /\W/.test(stripped[i + 7] ?? ' ')) {
    ctx.setKind('default', 'default');
    return i + 7;
  }

  // case: `export = X` — CJS-style ambient. Treat as default-ish, skip.
  if (stripped[i] === '=') {
    ctx.warnings.push(`'export =' assignment skipped in ${ctx.fileLabel}`);
    return i + 1;
  }

  // case: `export import X = …` — TS namespace import (only legal inside
  // an already-exported namespace, not a module-level binding). Skip silently.
  if (stripped.startsWith('import', i) && /\s/.test(stripped[i + 6] ?? '')) {
    const semi = stripped.indexOf(';', i);
    return semi === -1 ? i + 6 : semi + 1;
  }

  // case: type-only direct declaration without an explicit kw, i.e.
  //   `export type Foo = …` / `export type Foo<T> = …`. We've already
  //   consumed `type` into `typeOnly`. The next token is the identifier.
  if (typeOnly) {
    const idM = /^([A-Za-z_$][\w$]*)/.exec(stripped.slice(i));
    if (idM) {
      ctx.setKind(idM[1], 'type');
      return i + idM[1].length;
    }
  }

  // case: direct declaration. Optional modifiers we may see:
  //   declare, async, abstract, default
  // Then a kind keyword: class | function | const | let | var | interface | type | enum | namespace | module
  let cursor = i;
  while (true) {
    const m = /^(declare|async|abstract|default)\b\s*/.exec(stripped.slice(cursor));
    if (!m) break;
    cursor += m[0].length;
  }
  const kw = /^(class|function\*?|const|let|var|interface|type|enum|namespace|module)\b\s*/.exec(stripped.slice(cursor));
  if (!kw) {
    // unknown form — log and skip past the keyword
    ctx.warnings.push(`unrecognized export form near ${stripped.slice(start, Math.min(stripped.length, start + 40)).replace(/\s+/g, ' ')} in ${ctx.fileLabel}`);
    return start + 1;
  }
  cursor += kw[0].length;
  const kind = typeOnly || kw[1] === 'interface' || kw[1] === 'type' ? 'type' : 'value';

  if (kw[1] === 'const' || kw[1] === 'let' || kw[1] === 'var') {
    // could be a destructuring pattern or a single name.
    // Only handle simple identifier list separated by commas up to '=' or ';' or newline.
    const tail = stripped.slice(cursor);
    // first try to capture single identifier
    const idM = /^([A-Za-z_$][\w$]*)/.exec(tail);
    if (idM) {
      ctx.setKind(idM[1], kind);
      cursor += idM[1].length;
    } else if (tail.startsWith('{') || tail.startsWith('[')) {
      // destructuring — extract identifiers up to matching close
      const pair = tail[0];
      const closer = pair === '{' ? '}' : ']';
      const end = tail.indexOf(closer);
      if (end !== -1) {
        const inside = tail.slice(1, end);
        for (const part of inside.split(',')) {
          const p = part.trim();
          const idMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(p.split(':').pop()?.trim() ?? '');
          if (idMatch) ctx.setKind(idMatch[1], kind);
        }
        cursor += end + 1;
      } else {
        ctx.warnings.push(`unterminated destructuring export in ${ctx.fileLabel}`);
      }
    } else {
      ctx.warnings.push(`unparsed const/let/var export in ${ctx.fileLabel}`);
    }
    return cursor;
  }

  // class | function | interface | type | enum | namespace | module — single identifier
  const idM = /^([A-Za-z_$][\w$]*)/.exec(stripped.slice(cursor));
  if (idM) {
    ctx.setKind(idM[1], kind);
    return cursor + idM[1].length;
  }
  ctx.warnings.push(`could not extract identifier after ${kw[1]} in ${ctx.fileLabel}`);
  return cursor;
}

// Resolve a relative specifier (e.g. './a' or '../b') against a base file
// to a concrete .ts/.tsx file (or .ts on a directory's index).
async function resolveRelative(specifier, baseFile) {
  const baseDir = path.dirname(baseFile);
  const target = path.resolve(baseDir, specifier);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      const stat = await fs.stat(c).catch(() => null);
      if (stat && stat.isFile()) return c;
    }
  }
  return null;
}

async function collectExportsFromIndex(indexFile, warnings) {
  // Recursively walks `export *` chains. Tracks visited files to avoid loops.
  const visited = new Set();
  const out = new Map();

  async function visit(file) {
    if (!file || visited.has(file)) return;
    visited.add(file);
    const source = await fs.readFile(file, 'utf8').catch(() => null);
    if (source == null) return;
    const stripped = stripCommentsAndStrings(source);
    const { exports, reexportAll, warnings: w } = parseExportsFromStripped(stripped, source, path.relative(ROOT, file));
    for (const msg of w) warnings.push(msg);
    for (const [name, kind] of exports) {
      const prev = out.get(name);
      if (prev === 'value' || prev === 'default') continue;
      out.set(name, kind);
    }
    for (const r of reexportAll) {
      if (r.specifier.startsWith('.')) {
        const resolved = await resolveRelative(r.specifier, file);
        if (resolved) await visit(resolved);
        // else: silently — re-exporting from outside the package is opaque without a TS resolver
      }
      // non-relative `export *` (e.g. `export * from '@tinycloud/sdk-core'`) is intentionally
      // not followed; the boundary scan handles cross-package edges.
    }
  }

  await visit(indexFile);
  return out;
}

// ───────── boundary detection (full src tree) ─────────
function packageIdFromSpecifier(spec) {
  if (spec === '@tinycloud/web-sdk-wasm') return 'sdk-rs/web';
  if (spec === '@tinycloud/node-sdk-wasm') return 'sdk-rs/node';
  if (spec.startsWith('@tinycloud/')) {
    // strip subpath: '@tinycloud/node-sdk/core' -> 'node-sdk'
    const tail = spec.slice('@tinycloud/'.length);
    return tail.split('/')[0];
  }
  return spec;
}

function classifySpecifier(spec) {
  if (spec.startsWith('@tinycloud/')) return 'package';
  if (spec.startsWith('node:')) return 'node';
  return 'external';
}

function parseImportSpecifiers(stripped, source) {
  // Find import / export-from statements. We rely on the from-clause: any
  // statement in stripped that has the literal `from "..."` (plus a string).
  // We also pick up bare `import "..."` for side-effect imports.
  const specs = [];
  // bare `import "x"` or `import("x")` (dynamic).
  // We use stripped for keyword scanning and source for string body retrieval.
  const len = stripped.length;
  let i = 0;
  while (i < len) {
    // skip to next import|export keyword at a token boundary
    const matchAt = (kw) => {
      const k = stripped.indexOf(kw, i);
      if (k === -1) return -1;
      const before = k === 0 ? '\n' : stripped[k - 1];
      const after = stripped[k + kw.length] ?? ' ';
      if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return -2; // not a keyword
      return k;
    };
    let next = -1;
    let nextKw = '';
    for (const kw of ['import', 'export']) {
      const k = matchAt(kw);
      if (k >= 0 && (next === -1 || k < next)) { next = k; nextKw = kw; }
    }
    if (next === -1) break;
    if (next === -2) { i++; continue; }
    // From `next`, scan forward to a string literal that is at the same
    // statement: stop at `;`, `\n` followed by `\n`, or `{` matched-balanced.
    // Cheaper heuristic: scan up to the next `;` or 800 chars and look for
    // either ` from "..."` / ` from '...'` or a leading bare string after
    // `import`.
    const head = stripped.slice(next, Math.min(len, next + 800));
    // bare side-effect import: import 'x';
    const bare = /^(import|export)\s*(['"])/.exec(head);
    let pickedSpec = null;
    if (bare && nextKw === 'import') {
      const q = next + bare[0].length - 1;
      const lit = readStringAt(source, q);
      if (lit) pickedSpec = lit;
    }
    if (!pickedSpec) {
      // look for ` from "..."` within the statement window
      const fromIdx = head.search(/\bfrom\s*['"`]/);
      if (fromIdx !== -1) {
        const qIdx = next + fromIdx + head.slice(fromIdx).search(/['"`]/);
        const lit = readStringAt(source, qIdx);
        if (lit) pickedSpec = lit;
      }
    }
    // dynamic import("…")
    if (!pickedSpec && nextKw === 'import') {
      const dyn = /^import\s*\(\s*(['"`])/.exec(head);
      if (dyn) {
        const qIdx = next + dyn[0].length - 1;
        const lit = readStringAt(source, qIdx);
        if (lit) pickedSpec = lit;
      }
    }
    if (pickedSpec) specs.push(pickedSpec);
    // advance past this statement: either the matched closing `;` or end-of-line
    const semi = stripped.indexOf(';', next);
    const nl = stripped.indexOf('\n', next);
    const advance = [semi, nl].filter(x => x !== -1).sort((a, b) => a - b)[0];
    i = advance !== undefined ? advance + 1 : next + 6;
  }
  return specs;
}

async function collectBoundaries(srcDir, selfId, idByNpm) {
  const counts = new Map(); // boundary id -> { id, kind, count }
  const SKIP = new Set(['node_modules', 'dist', 'target', '.next', 'pkg']);
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const txt = await fs.readFile(full, 'utf8').catch(() => '');
      if (!txt) continue;
      const stripped = stripCommentsAndStrings(txt);
      const specs = parseImportSpecifiers(stripped, txt);
      for (const spec of specs) {
        if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
        const id = packageIdFromSpecifier(spec);
        const kindFromSpec = classifySpecifier(spec);
        // resolve to TC package id if possible
        let outId = id;
        let outKind = kindFromSpec;
        if (kindFromSpec === 'package') {
          // already a TC package id like 'sdk-core' or mapped to 'sdk-rs/web'.
          if (id === selfId) continue; // skip self-imports
          outKind = 'package';
        } else {
          outKind = kindFromSpec; // 'external' | 'node'
          outId = id;
          if (kindFromSpec === 'node') outId = id; // keep `node:fs` form for clarity
        }
        const key = `${outKind}::${outId}`;
        const prev = counts.get(key);
        if (prev) prev.count++;
        else counts.set(key, { id: outId, kind: outKind, count: 1 });
      }
    }
  }
  await walk(srcDir);
  return [...counts.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ───────── drift hashing ─────────
async function computePackageHash(dir) {
  // hash: sha256 of package.json contents + src/index.ts contents.
  const pjPath = path.join(dir, 'package.json');
  const idxPath = path.join(dir, 'src/index.ts');
  const pj = await fs.readFile(pjPath, 'utf8').catch(() => '');
  const idx = await fs.readFile(idxPath, 'utf8').catch(() => '');
  const h = crypto.createHash('sha256');
  h.update('package.json:'); h.update(pj);
  h.update('\nsrc/index.ts:'); h.update(idx);
  return h.digest('hex');
}

function classifyDriftKind(prev, curr) {
  if (!prev) return 'none';
  const exportsChanged = prev.exportsHash !== curr.exportsHash;
  const depsChanged = prev.depsHash !== curr.depsHash;
  if (exportsChanged && depsChanged) return 'both';
  if (exportsChanged) return 'exports';
  if (depsChanged) return 'deps';
  return 'none';
}

function hashString(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ───────── normalization ─────────
function normalizeBoundaries(boundaries, fallback) {
  const arr = boundaries?.length ? boundaries : fallback;
  return (arr ?? []).map((b) => {
    if (typeof b === 'string') return { id: b, kind: 'edge' };
    // curated YAML uses { id, note }; keep their kind/note as the human label.
    return {
      id: b.id,
      kind: b.kind ?? (b.note && b.note.length ? b.note : (typeof b.count === 'number' ? 'package' : 'edge')),
      ...(typeof b.count === 'number' ? { count: b.count } : {}),
    };
  }).filter(b => b.id);
}

function normalizeExports(exports) {
  return (exports ?? []).map((e) => {
    if (typeof e === 'string') return { name: e, kind: 'value' };
    return { name: e.name, kind: e.kind || 'value' };
  }).filter(e => e.name);
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter(Boolean);
}

// ───────── package build ─────────
async function buildPackage(p, idByNpm, warnings) {
  const pj = await readJson(p.pj);
  const indexFile = path.join(p.dir, 'src/index.ts');
  const srcDir = path.join(p.dir, 'src');
  const { loc, modules } = await countLoc(p.dir);

  // Real exports — recursive across `export *` re-exports.
  let parsedExports = new Map();
  if (await exists(indexFile)) {
    parsedExports = await collectExportsFromIndex(indexFile, warnings);
  }
  const exports = [...parsedExports.entries()]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Boundaries from full src tree (skip when there's no src/).
  let boundaries = [];
  if (await exists(srcDir)) {
    boundaries = await collectBoundaries(srcDir, p.id, idByNpm);
  }

  // Hashes for drift.
  const sourceHash = await computePackageHash(p.dir);
  const exportsHash = hashString(exports.map(e => `${e.kind} ${e.name}`).join('\n'));
  const depsHash = hashString(JSON.stringify({
    deps: pj?.dependencies ?? {},
    peerDeps: pj?.peerDependencies ?? {},
  }));

  const kindGuess =
    p.id === 'sdk-core' ? 'core' :
    p.id === 'sdk-services' ? 'services' :
    p.id === 'cli' ? 'cli' :
    p.id.startsWith('sdk-rs') ? (p.id === 'sdk-rs' ? 'rust' : 'wasm') :
    'sdk';
  const sideGuess =
    p.id.includes('web') ? 'browser' :
    p.id.includes('node') ? 'node' :
    p.id === 'cli' ? 'cli' :
    'iso';
  return {
    id: p.id,
    npm: pj?.name ?? `@tinycloud/${p.id}`,
    kind: kindGuess,
    side: sideGuess,
    modules,
    loc,
    why: '',
    boundaries,
    exports,
    changed: 0,
    hasFsm: false,
    hasSeq: false,
    cmds: [],
    _hash: sourceHash,
    _exportsHash: exportsHash,
    _depsHash: depsHash,
  };
}

async function mergeCurated(pkg) {
  const curated = await readCurated(pkg.id);
  const notableExports = normalizeExports(curated.notable_exports);
  // Curated boundaries override `kind`/`note` per id, but the parsed list
  // from src is the source of truth for which edges exist + counts.
  const curatedById = new Map();
  for (const b of curated.boundaries ?? []) {
    if (typeof b === 'string') curatedById.set(b, { id: b });
    else if (b?.id) curatedById.set(b.id, b);
  }
  // Start from the parsed list; apply curated overrides per id.
  const parsedIds = new Set(pkg.boundaries.map(b => b.id));
  const mergedBoundaries = pkg.boundaries.map(b => {
    const c = curatedById.get(b.id);
    if (!c) return b;
    return {
      ...b,
      // curated kind wins; otherwise curated note becomes the visible label.
      kind: c.kind ?? (c.note && c.note.length ? c.note : b.kind),
      ...(c.note ? { note: c.note } : {}),
    };
  });
  // Append any curated-only edges (logical or aspirational) the parser missed.
  for (const c of curatedById.values()) {
    if (!parsedIds.has(c.id)) {
      mergedBoundaries.push({
        id: c.id,
        kind: c.kind ?? (c.note && c.note.length ? c.note : 'edge'),
        ...(c.note ? { note: c.note } : {}),
      });
    }
  }

  const merged = {
    ...pkg,
    npm: curated.npm ?? pkg.npm,
    kind: curated.kind ?? pkg.kind,
    side: curated.side ?? pkg.side,
    why: curated.why ?? pkg.why,
    boundaries: mergedBoundaries,
    // Parsed exports are the source of truth. Curated `notable_exports` is
    // a highlight list — exposed separately so the chapter prose can pick
    // them out without losing the full surface.
    exports: normalizeExports(pkg.exports),
    ...(notableExports.length ? { notable_exports: notableExports } : {}),
    cmds: normalizeCommands(curated.notable_commands ?? pkg.cmds),
    hasFsm: curated.hasFsm ?? pkg.hasFsm,
    hasSeq: curated.hasSeq ?? pkg.hasSeq,
    ...(curated.central === undefined ? {} : { central: curated.central }),
  };
  return merged;
}

// ───────── main ─────────
async function main() {
  console.log('› atlas: walking packages…');
  const previousInventory = await readJson(path.join(OUT, 'inventory.json'));
  const previousDrift = await readJson(path.join(OUT, 'drift.json'));
  const previousByPkg = new Map();
  if (Array.isArray(previousDrift?.packages)) {
    for (const p of previousDrift.packages) previousByPkg.set(p.id, p);
  }
  const rootPackage = await readJson(path.join(ROOT, 'package.json'));
  const pkgs = await listPackageDirs();

  // First pass: build npm-name → id map for boundary attribution.
  const idByNpm = new Map();
  for (const p of pkgs) {
    const pj = await readJson(p.pj);
    if (pj?.name) idByNpm.set(pj.name, p.id);
  }

  const warnings = [];
  const data = [];
  for (const p of pkgs) {
    process.stdout.write(`  · ${p.id}…`);
    let pkg = await buildPackage(p, idByNpm, warnings);
    pkg = await mergeCurated(pkg);
    data.push(pkg);
    process.stdout.write(` ${pkg.modules} mod / ${pkg.loc} loc / ${pkg.exports.length} exp / ${pkg.boundaries.length} bnd\n`);
  }

  // Drift: compare hashes against previous run.
  const driftPkgs = [];
  let driftCount = 0;
  const isFirstRun = !previousByPkg.size;
  for (const p of data) {
    const prev = previousByPkg.get(p.id);
    const prevHash = prev?.hash ?? null;
    const changed = !isFirstRun && prevHash !== null && prevHash !== p._hash;
    const kind = isFirstRun
      ? 'none'
      : classifyDriftKind(prev, { exportsHash: p._exportsHash, depsHash: p._depsHash });
    if (changed) driftCount++;
    driftPkgs.push({
      id: p.id,
      prev_hash: prevHash,
      hash: p._hash,
      changed,
      kind,
      // expose component hashes so future runs can produce a finer kind.
      exportsHash: p._exportsHash,
      depsHash: p._depsHash,
    });
  }
  const drift = {
    generatedAt: new Date().toISOString(),
    count: driftCount,
    packages: driftPkgs,
  };
  await writeJson(path.join(OUT, 'drift.json'), drift);

  // emit per-package JSON (strip private hash fields).
  for (const p of data) {
    const { _hash, _exportsHash, _depsHash, ...publicFields } = p;
    await writeJson(path.join(OUT, 'pkg', `${p.id.replace(/\//g, '__')}.json`), publicFields);
  }

  // emit inventory
  const sha = sh('git rev-parse HEAD', { cwd: ROOT });
  const ref = sh('git rev-parse --abbrev-ref HEAD', { cwd: ROOT });
  const inventory = {
    $schema: 'https://tinycloud.xyz/atlas/schema/inventory.v1.json',
    generated: { at: new Date().toISOString(), by: 'tc atlas rebuild', recipe: '/atlas/data/meta.json' },
    repo: {
      owner: 'TinyCloudLabs',
      name: 'js-sdk',
      ref,
      sha,
      version: rootPackage?.version ?? previousInventory?.repo?.version ?? '0.0.1',
      builtAt: new Date().toISOString().slice(0,10),
      drift: drift.count,
    },
    packages: data.map(p => ({ id: p.id, npm: p.npm, kind: p.kind, side: p.side, ref: `/atlas/data/pkg/${p.id.replace(/\//g, '__')}.json` })),
    chapters: previousInventory?.chapters?.length
      ? previousInventory.chapters.filter(c => c.id !== '10')
      : DEFAULT_CHAPTERS,
    endpoints: DEFAULT_ENDPOINTS,
  };
  await writeJson(path.join(OUT, 'inventory.json'), inventory);

  if (warnings.length) {
    console.log(`\n› atlas: ${warnings.length} parse warning(s):`);
    for (const w of warnings.slice(0, 20)) console.log(`  ! ${w}`);
    if (warnings.length > 20) console.log(`  … (${warnings.length - 20} more)`);
  }
  console.log(`\n› atlas: wrote ${data.length} packages to ${OUT}`);
  console.log(`› atlas: drift ${drift.count}/${data.length}${isFirstRun ? ' (first run — baselined)' : ''}`);
  console.log('› atlas: run `bun run build` next to publish to ../docs/atlas/');
}

main().catch(e => { console.error(e); process.exit(1); });
