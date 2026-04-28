// scripts/rebuild.mjs — `bun run atlas:rebuild`
//
// Walks the monorepo for structural facts and merges them with hand-curated
// prose under atlas/curated/*.yaml. Emits public/atlas/data/*.json which the
// Astro build then bundles into the static site verbatim.
//
// THIS IS A SCAFFOLD. Sections marked TODO are where the real work lives —
// see HANDOFF.md for the concrete tasks Claude Code should pick up.

import fs from 'node:fs/promises';
import path from 'node:path';
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

async function listPackageDirs() {
  const entries = await fs.readdir(PKGS, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PKGS, e.name);
    const pj = path.join(dir, 'package.json');
    if (await exists(pj)) out.push({ id: e.name, dir, pj });
    // sdk-rs has nested web/ and node/ subprojects — list those too
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
  // Cheap line counter — no external deps. Skips dist/, target/, node_modules/.
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

async function readIndex(dir) {
  return fs.readFile(path.join(dir, 'src/index.ts'), 'utf8').catch(() => '');
}

function packageIdFromSpecifier(spec) {
  if (spec === '@tinycloud/web-sdk-wasm') return 'sdk-rs/web';
  if (spec === '@tinycloud/node-sdk-wasm') return 'sdk-rs/node';
  if (spec.startsWith('@tinycloud/')) return spec.replace('@tinycloud/', '');
  return spec;
}

function inferBoundaryKind(spec) {
  if (spec.startsWith('@tinycloud/')) return 'package';
  if (spec.startsWith('node:')) return 'node';
  return 'external';
}

function extractBoundaries(source) {
  const out = new Map();
  const re = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
    out.set(packageIdFromSpecifier(spec), { id: packageIdFromSpecifier(spec), kind: inferBoundaryKind(spec) });
  }
  return [...out.values()];
}

function extractExports(source) {
  const names = new Set();
  const blockRe = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]+['"])?/g;
  for (const match of source.matchAll(blockRe)) {
    for (const raw of match[1].split(',')) {
      const item = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!item) continue;
      const name = item.replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  const directRe = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(directRe)) names.add(match[1]);
  return [...names].sort().map(name => ({ name, kind: 'export' }));
}

function normalizeBoundaries(boundaries) {
  return (boundaries ?? []).map((b) => {
    if (typeof b === 'string') return { id: b, kind: 'edge' };
    return { id: b.id, kind: b.kind || b.note || 'edge' };
  }).filter(b => b.id);
}

function normalizeExports(exports) {
  return (exports ?? []).map((e) => {
    if (typeof e === 'string') return { name: e, kind: 'export' };
    return { name: e.name, kind: e.kind || 'export' };
  }).filter(e => e.name);
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter(Boolean);
}

async function buildPackage(p) {
  const pj = await readJson(p.pj);
  const source = await readIndex(p.dir);
  const { loc, modules } = await countLoc(p.dir);
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
    why: '',                 // filled by curated merge below
    boundaries: extractBoundaries(source),
    exports: extractExports(source),
    changed: 0,              // TODO: compare hash to last build
    hasFsm: false,
    hasSeq: false,
    cmds: [],
  };
}

async function mergeCurated(pkg) {
  const curated = await readCurated(pkg.id);
  const notableExports = normalizeExports(curated.notable_exports);
  return {
    ...pkg,
    npm: curated.npm ?? pkg.npm,
    kind: curated.kind ?? pkg.kind,
    side: curated.side ?? pkg.side,
    why: curated.why ?? pkg.why,
    boundaries: normalizeBoundaries(curated.boundaries?.length ? curated.boundaries : pkg.boundaries),
    exports: notableExports.length ? notableExports : normalizeExports(pkg.exports),
    cmds: normalizeCommands(curated.notable_commands ?? pkg.cmds),
    hasFsm: curated.hasFsm ?? pkg.hasFsm,
    hasSeq: curated.hasSeq ?? pkg.hasSeq,
    ...(curated.central === undefined ? {} : { central: curated.central }),
  };
}

async function main() {
  console.log('› atlas: walking packages…');
  const previousInventory = await readJson(path.join(OUT, 'inventory.json'));
  const drift = await readJson(path.join(OUT, 'drift.json'));
  const rootPackage = await readJson(path.join(ROOT, 'package.json'));
  const pkgs = await listPackageDirs();
  const data = [];
  for (const p of pkgs) {
    process.stdout.write(`  · ${p.id}…`);
    let pkg = await buildPackage(p);
    pkg = await mergeCurated(pkg);
    data.push(pkg);
    process.stdout.write(` ${pkg.modules} mod / ${pkg.loc} loc\n`);
  }

  // emit per-package JSON
  for (const p of data) {
    await writeJson(path.join(OUT, 'pkg', `${p.id.replace(/\//g, '__')}.json`), p);
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
      drift: drift?.count ?? previousInventory?.repo?.drift ?? 0,
    },
    packages: data.map(p => ({ id: p.id, npm: p.npm, kind: p.kind, side: p.side, ref: `/atlas/data/pkg/${p.id.replace(/\//g, '__')}.json` })),
    chapters: previousInventory?.chapters?.length
      ? previousInventory.chapters.filter(c => c.id !== '10')
      : DEFAULT_CHAPTERS,
    endpoints: DEFAULT_ENDPOINTS,
  };
  await writeJson(path.join(OUT, 'inventory.json'), inventory);

  console.log(`\n› atlas: wrote ${data.length} packages to ${OUT}`);
  console.log('› atlas: run `bun run build` next to publish to ../docs/atlas/');
}

main().catch(e => { console.error(e); process.exit(1); });
