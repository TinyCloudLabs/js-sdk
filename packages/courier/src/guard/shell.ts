/**
 * A small, conservative POSIX-shell reader for the guard. It does not run anything. It turns a command string into the
 * flat list of simple commands that string could execute (including command substitutions, subshells, groups and loop
 * bodies), with every word split into literal and dynamic parts so the policy can tell "I know this word" from "this word
 * is decided at run time". Anything it cannot read exactly becomes dynamic; unterminated constructs are reported as
 * errors (the guard denies on them).
 */

export type Part =
  | { t: 'lit'; s: string; q: boolean }
  /** `$NAME` or `${NAME}`; `q` = inside double quotes (no word splitting). */
  | { t: 'var'; name: string; q: boolean }
  /** Anything decided at run time: command substitution, arithmetic, special parameters, globs, braces, tilde. */
  | { t: 'dyn' };

export interface RawWord { parts: Part[] }

export interface RawAssign { name: string; append: boolean; value: RawWord }

export interface RawRedirect { op: string; fd?: string; target: RawWord }

export interface RawCmd {
  assigns: RawAssign[];
  words: RawWord[];
  redirs: RawRedirect[];
  heredocs: string[];
  hereStrings: RawWord[];
  inLoop: boolean;
  inFunc: boolean;
  /** stdin comes from the previous command of a pipeline */
  piped: boolean;
  /** `for NAME in …` / `select NAME`: NAME is assigned at run time */
  forVars: string[];
}

export interface ParseResult { cmds: RawCmd[]; errors: string[] }

const MAX_DEPTH = 16;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPECIAL = new Set(['@', '*', '#', '?', '$', '!', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const RESERVED_SKIP = new Set(['if', 'then', 'elif', 'else', 'do', 'time', '!', 'coproc']);

interface State { cmds: RawCmd[]; errors: string[] }
interface Base { loop: number; func: boolean; depth: number }

export function parseShell(src: string): ParseResult {
  const st: State = { cmds: [], errors: [] };
  parseScript(src, st, { loop: 0, func: false, depth: 0 });
  return { cmds: st.cmds, errors: st.errors };
}

function newCmd(loop: number, func: boolean, piped: boolean): RawCmd {
  return { assigns: [], words: [], redirs: [], heredocs: [], hereStrings: [], inLoop: loop > 0, inFunc: func, piped, forVars: [] };
}

const isBlank = (c: string) => c === ' ' || c === '\t' || c === '\r';
const isWordEnd = (c: string) => c === undefined || isBlank(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>';

/** Index of the `)` matching the `(` that opened at `start - 1`, or -1. Honours quotes, escapes and nesting. */
function matchParen(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '(') {
          const e = matchParen(src, i + 2);
          if (e < 0) return -1;
          i = e + 1;
          continue;
        }
        i++;
      }
      if (i >= src.length) return -1;
      i++;
      continue;
    }
    if (c === '`') { const e = closeBacktick(src, i + 1); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function closeBacktick(src: string, start: number): number {
  for (let i = start; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
  }
  return -1;
}

/** Index of the `}` closing a `${`, or -1. */
function matchBrace(src: string, start: number): number {
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue; }
    if (c === '$' && src[i + 1] === '(') { const e = matchParen(src, i + 2); if (e < 0) return -1; i = e; continue; }
    if (c === '`') { const e = closeBacktick(src, i + 1); if (e < 0) return -1; i = e; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Parse every `$(…)`, backtick and process substitution found in `text` (heredoc bodies, `${…}` words, arithmetic). */
function harvest(text: string, st: State, base: Base): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const e = matchParen(text, i + 2);
      if (e < 0) { st.errors.push('unterminated $('); return; }
      sub(text.slice(i + 2, e), st, base);
      i = e;
    } else if (c === '$' && text[i + 1] === '(') {
      const e = matchParen(text, i + 2);
      if (e < 0) { st.errors.push('unterminated $(('); return; }
      harvest(text.slice(i + 3, Math.max(i + 3, e - 1)), st, base);
      i = e;
    } else if (c === '`') {
      const e = closeBacktick(text, i + 1);
      if (e < 0) { st.errors.push('unterminated backtick'); return; }
      sub(unescapeBacktick(text.slice(i + 1, e)), st, base);
      i = e;
    } else if ((c === '<' || c === '>') && text[i + 1] === '(') {
      const e = matchParen(text, i + 2);
      if (e < 0) { st.errors.push('unterminated process substitution'); return; }
      sub(text.slice(i + 2, e), st, base);
      i = e;
    }
  }
}

function unescapeBacktick(s: string): string {
  return s.replace(/\\([`\\$])/g, '$1');
}

function sub(inner: string, st: State, base: Base): void {
  if (base.depth + 1 > MAX_DEPTH) { st.errors.push('substitutions nested too deeply'); return; }
  parseScript(inner, st, { ...base, depth: base.depth + 1 });
}

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** Decode the body of `$'…'`. */
function ansiC(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) { out += '\\'; break; }
    if (n in ANSI) { out += ANSI[n]; continue; }
    if (n === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
      if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    }
    if (n === 'u' || n === 'U') {
      const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(body.slice(i + 1));
      if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
    }
    if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i));
      out += String.fromCharCode(parseInt(m![0], 8) & 0xff);
      i += m![0].length - 1;
      continue;
    }
    out += `\\${n}`;
  }
  return out;
}

interface Lexed { word: RawWord; end: number }

/** Read one word starting at `i`. Never throws; unterminated constructs go to `st.errors`. */
function lexWord(src: string, i: number, st: State, base: Base, allowAssignParen = true): Lexed {
  const parts: Part[] = [];
  const lit = (s: string, q: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q === q) last.s += s;
    else parts.push({ t: 'lit', s, q });
  };
  let wordStart = true;
  while (i < src.length) {
    const c = src[i];
    // Process substitution `<(` `>(` at the very start of a word.
    if ((c === '<' || c === '>') && src[i + 1] === '(' && wordStart) {
      const e = matchParen(src, i + 2);
      if (e < 0) { st.errors.push('unterminated process substitution'); return { word: { parts: [...parts, { t: 'dyn' }] }, end: src.length }; }
      sub(src.slice(i + 2, e), st, base);
      parts.push({ t: 'dyn' });
      i = e + 1;
      wordStart = false;
      continue;
    }
    if (isWordEnd(c)) break;
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 >= src.length) { lit('\\', true); i++; continue; }
      lit(src[i + 1], true);
      i += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) { st.errors.push('unterminated single quote'); lit(src.slice(i + 1), true); i = src.length; break; }
      lit(src.slice(i + 1, e), true);
      i = e + 1;
    } else if (c === '"') {
      i = lexDouble(src, i + 1, parts, st, base);
    } else if (c === '$' && src[i + 1] === "'") {
      let e = i + 2;
      while (e < src.length && src[e] !== "'") e += src[e] === '\\' ? 2 : 1;
      if (e >= src.length) { st.errors.push("unterminated $'"); i = src.length; break; }
      lit(ansiC(src.slice(i + 2, e)), true);
      i = e + 1;
    } else if (c === '$' && src[i + 1] === '"') {
      i = lexDouble(src, i + 2, parts, st, base);
    } else if (c === '$') {
      i = lexDollar(src, i, parts, false, st, base);
    } else if (c === '`') {
      const e = closeBacktick(src, i + 1);
      if (e < 0) { st.errors.push('unterminated backtick'); i = src.length; break; }
      sub(unescapeBacktick(src.slice(i + 1, e)), st, base);
      parts.push({ t: 'dyn' });
      i = e + 1;
    } else if (c === '[' && !/^\[[^\s\]]*\]/.test(src.slice(i, i + 256))) {
      // `[` and `[[` are the test command; a glob bracket needs its closing `]` inside the same word.
      lit(c, false);
      i++;
    } else if (c === '*' || c === '?' || c === '[') {
      parts.push({ t: 'dyn' });
      i++;
    } else if (c === '~' && wordStart) {
      parts.push({ t: 'dyn' });
      i++;
    } else if (c === '{' && !(wordStart && isWordEnd(src[i + 1] ?? ' '))) {
      // Brace expansion `{a,b}` / `{1..3}` inside a word: dynamic. A lone `{` stays literal (grouping).
      const stop = (() => { let j = i; while (j < src.length && !/[\s;&|()<>]/.test(src[j])) j++; return j; })();
      const chunk = src.slice(i, stop);
      const close = chunk.indexOf('}');
      if (close > 0 && (/,/.test(chunk.slice(0, close)) || /\.\./.test(chunk.slice(0, close)))) {
        parts.push({ t: 'dyn' });
        i += close + 1;
      } else {
        lit('{', false);
        i++;
      }
    } else if (c === '(' ) {
      break;
    } else if (c === '=' && allowAssignParen && src[i + 1] === '(' && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(partsText(parts))) {
      // Array assignment `NAME=( … )`.
      const e = matchParen(src, i + 2);
      if (e < 0) { st.errors.push('unterminated array assignment'); i = src.length; break; }
      harvest(src.slice(i + 2, e), st, base);
      lit('=', false);
      parts.push({ t: 'dyn' });
      i = e + 1;
    } else {
      lit(c, false);
      i++;
    }
    wordStart = false;
  }
  return { word: { parts }, end: i };
}

const partsText = (parts: Part[]) => parts.map((p) => (p.t === 'lit' ? p.s : '\u0001')).join('');

/** Read a double-quoted string body starting just after the opening quote; returns the index after the closing quote. */
function lexDouble(src: string, start: number, parts: Part[], st: State, base: Base): number {
  const lit = (s: string) => {
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q) last.s += s;
    else parts.push({ t: 'lit', s, q: true });
  };
  let i = start;
  lit('');
  while (i < src.length && src[i] !== '"') {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') { i += 2; continue; }
      if (n === '$' || n === '`' || n === '"' || n === '\\') { lit(n); i += 2; continue; }
      lit('\\');
      i++;
    } else if (c === '$') {
      i = lexDollar(src, i, parts, true, st, base);
    } else if (c === '`') {
      const e = closeBacktick(src, i + 1);
      if (e < 0) { st.errors.push('unterminated backtick'); return src.length; }
      sub(unescapeBacktick(src.slice(i + 1, e)), st, base);
      parts.push({ t: 'dyn' });
      i = e + 1;
    } else {
      lit(c);
      i++;
    }
  }
  if (i >= src.length) { st.errors.push('unterminated double quote'); return src.length; }
  return i + 1;
}

/** `$…` at src[i]. Pushes a part and returns the next index. */
function lexDollar(src: string, i: number, parts: Part[], q: boolean, st: State, base: Base): number {
  const n = src[i + 1];
  const lit = (s: string) => {
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q === q) last.s += s;
    else parts.push({ t: 'lit', s, q });
  };
  if (n === '(') {
    const arith = src[i + 2] === '(';
    const e = matchParen(src, i + 2);
    if (e < 0) { st.errors.push('unterminated $('); parts.push({ t: 'dyn' }); return src.length; }
    if (arith) harvest(src.slice(i + 3, Math.max(i + 3, e - 1)), st, base);
    else sub(src.slice(i + 2, e), st, base);
    parts.push({ t: 'dyn' });
    return e + 1;
  }
  if (n === '{') {
    const e = matchBrace(src, i + 2);
    if (e < 0) { st.errors.push('unterminated ${'); parts.push({ t: 'dyn' }); return src.length; }
    const body = src.slice(i + 2, e);
    if (NAME.test(body)) parts.push({ t: 'var', name: body, q });
    else { harvest(body, st, base); parts.push({ t: 'dyn' }); }
    return e + 1;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1, i + 1 + 256));
  if (m) { parts.push({ t: 'var', name: m[0], q }); return i + 1 + m[0].length; }
  if (n !== undefined && SPECIAL.has(n)) { parts.push({ t: 'dyn' }); return i + 2; }
  lit('$');
  return i + 1;
}

/** Plain text of a word if every part is literal, else undefined. */
export function wordLiteral(w: RawWord): string | undefined {
  let s = '';
  for (const p of w.parts) { if (p.t !== 'lit') return undefined; s += p.s; }
  return s;
}

function hasQuoted(w: RawWord): boolean {
  return w.parts.some((p) => p.t === 'lit' && p.q);
}

interface Heredoc { delim: string; strip: boolean; quoted: boolean; cmd: RawCmd }

function parseScript(src: string, st: State, base: Base): void {
  if (src.length > 1_000_000) { st.errors.push('command too large to inspect'); return; }
  let i = 0;
  let loop = base.loop;
  const stack: ('func' | 'sub' | 'group')[] = base.func ? ['func'] : [];
  let cur: RawCmd | null = null;
  let atCmd = true;
  let nextPiped = false;
  let pendingFunc = false;
  let skipWords: 'do' | 'in' | null = null;
  const heredocs: Heredoc[] = [];
  const inFunc = () => stack.includes('func');

  const start = (): RawCmd => {
    if (!cur) {
      cur = newCmd(loop, inFunc(), nextPiped);
      nextPiped = false;
    }
    return cur;
  };
  const flush = () => {
    if (cur && (cur.words.length || cur.assigns.length || cur.redirs.length || cur.hereStrings.length || cur.heredocs.length || cur.forVars.length)) st.cmds.push(cur);
    cur = null;
    atCmd = true;
  };

  while (i < src.length) {
    const c = src[i];
    if (isBlank(c)) { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      flush();
      skipWords = skipWords === 'do' ? null : skipWords;
      i++;
      for (const h of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < src.length) {
          let e = src.indexOf('\n', i);
          if (e < 0) e = src.length;
          const line = src.slice(i, e);
          i = Math.min(src.length, e + 1);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(h.strip ? line.replace(/^\t+/, '') : line);
        }
        const body = lines.join('\n');
        h.cmd.heredocs.push(body);
        if (!h.quoted) harvest(body, st, base.depth >= MAX_DEPTH ? base : { loop, func: inFunc(), depth: base.depth });
      }
      continue;
    }
    if (c === ';') {
      flush();
      skipWords = skipWords === 'do' ? null : skipWords;
      i += src[i + 1] === ';' ? (src[i + 2] === '&' ? 3 : 2) : src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      // `&>file` / `&>>file`
      const op = src[i + 2] === '>' ? '&>>' : '&>';
      i += op.length;
      while (isBlank(src[i])) i++;
      const { word, end } = lexWord(src, i, st, base);
      i = end;
      start().redirs.push({ op, target: word });
      continue;
    }
    if (c === '&' || c === '|') {
      const two = src[i + 1] === c;
      flush();
      if (c === '|') nextPiped = true;
      i += two ? 2 : c === '|' && src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '(') {
      // `name () {` function definition?
      const rest = src.slice(i + 1);
      const m = /^\s*\)/.exec(rest);
      if (m && cur && (cur as RawCmd).words.length === 1 && !(cur as RawCmd).assigns.length) {
        cur = null;
        pendingFunc = true;
        atCmd = true;
        i += 1 + m[0].length;
        continue;
      }
      flush();
      stack.push(pendingFunc ? 'func' : 'sub');
      pendingFunc = false;
      i++;
      continue;
    }
    if (c === ')') {
      flush();
      stack.pop();
      i++;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] !== '(') {
      i = lexRedirect(src, i, undefined);
      continue;
    }

    const { word, end } = lexWord(src, i, st, base);
    i = end;
    if (!word.parts.length) { i = Math.max(i, i + 1); continue; }
    // `2>file` / `3<&0`: a bare digit word glued to a redirect operator.
    const text = wordLiteral(word);
    if (text !== undefined && /^[0-9]+$/.test(text) && (src[i] === '<' || src[i] === '>') && src[i + 1] !== '(') {
      i = lexRedirect(src, i, text);
      continue;
    }
    if (skipWords) {
      if (skipWords === 'do' && text === 'do') { skipWords = null; atCmd = true; }
      else if (skipWords === 'in' && text === 'in') { skipWords = null; atCmd = true; }
      continue;
    }
    if (atCmd && text !== undefined && !hasQuoted(word)) {
      if (RESERVED_SKIP.has(text)) continue;
      if (text === 'fi' || text === 'esac') continue;
      if (text === 'done') { loop = Math.max(0, loop - 1); continue; }
      if (text === 'while' || text === 'until') { loop++; continue; }
      if (text === 'for' || text === 'select') {
        loop++;
        // The next word is the loop variable; the words up to `do` are data, not commands.
        while (isBlank(src[i])) i++;
        const v = lexWord(src, i, st, base);
        i = v.end;
        const name = wordLiteral(v.word);
        const cmd = start();
        if (name && NAME.test(name)) cmd.forVars.push(name);
        flush();
        skipWords = 'do';
        continue;
      }
      if (text === 'case') { skipWords = 'in'; continue; }
      if (text === 'function') {
        while (isBlank(src[i])) i++;
        const v = lexWord(src, i, st, base);
        i = v.end;
        pendingFunc = true;
        continue;
      }
      if (text === '{') { stack.push(pendingFunc ? 'func' : 'group'); pendingFunc = false; continue; }
      if (text === '}') { stack.pop(); continue; }
    }
    const cmd = start();
    if (atCmd) {
      const eq = word.parts[0].t === 'lit' && !word.parts[0].q ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(word.parts[0].s) : null;
      if (eq && cmd.words.length === 0) {
        const first = word.parts[0] as { t: 'lit'; s: string; q: boolean };
        const rest: Part[] = [];
        const tail = first.s.slice(eq[0].length);
        if (tail || word.parts.length === 1) rest.push({ t: 'lit', s: tail, q: false });
        rest.push(...word.parts.slice(1));
        cmd.assigns.push({ name: eq[1], append: eq[2] === '+', value: { parts: rest } });
        continue;
      }
    }
    atCmd = false;
    cmd.words.push(word);
  }
  flush();

  function lexRedirect(s: string, at: number, fd: string | undefined): number {
    let j = at;
    let op = s[j];
    if (s[j] === '<' && s[j + 1] === '<' && s[j + 2] === '<') op = '<<<';
    else if (s[j] === '<' && s[j + 1] === '<') op = s[j + 2] === '-' ? '<<-' : '<<';
    else if (s[j] === '>' && s[j + 1] === '>') op = '>>';
    else if ((s[j] === '<' || s[j] === '>') && s[j + 1] === '&') op = `${s[j]}&`;
    else if (s[j] === '<' && s[j + 1] === '>') op = '<>';
    else if (s[j] === '>' && s[j + 1] === '|') op = '>|';
    j += op.length;
    while (isBlank(s[j])) j++;
    const lexed = lexWord(s, j, st, base);
    j = lexed.end;
    const command = start();
    if (op === '<<' || op === '<<-') {
      const delim = lexed.word.parts.map((p) => (p.t === 'lit' ? p.s : '')).join('');
      heredocs.push({ delim, strip: op === '<<-', quoted: hasQuoted(lexed.word), cmd: command });
    } else if (op === '<<<') {
      command.hereStrings.push(lexed.word);
    } else {
      command.redirs.push({ op, ...(fd !== undefined ? { fd } : {}), target: lexed.word });
    }
    return j;
  }
}
