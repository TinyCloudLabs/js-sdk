// src/components/CmdK.tsx — agent-first command palette React island.
// Loads /atlas/data/inventory.json at runtime so it always reflects the
// freshest atlas — no rebuild needed for content edits.
import { useEffect, useMemo, useState } from 'react';

interface Pkg { id: string; npm: string; kind: string; side: string; ref: string }
interface Chapter { id: string; title: string; voice: string; read: string }
interface Endpoint { method: string; path: string; desc: string }
interface Inventory {
  packages: Pkg[]; chapters: Chapter[]; endpoints: Endpoint[];
  repo: { ref: string; sha: string; version: string };
}

const BASE = (import.meta as any).env?.BASE_URL?.replace(/\/$/, '') ?? '';

function endpointHref(path: string) {
  return `${BASE}${path.replace(/^\/atlas/, '')}`;
}

export default function CmdK() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [inv, setInv] = useState<Inventory | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen(v => !v);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!open || inv) return;
    fetch(`${BASE}/data/inventory.json`).then(r => r.json()).then(setInv).catch(() => {});
  }, [open, inv]);

  const results = useMemo(() => {
    if (!inv) return null;
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    return {
      pkgs:      inv.packages.filter(p => match(p.id) || match(p.npm)),
      chapters:  inv.chapters.filter(c => match(c.title) || match(c.id)),
      endpoints: inv.endpoints.filter(e => match(e.path) || match(e.desc)),
    };
  }, [inv, q]);

  if (!open) return null;

  return (
    <div onClick={() => setOpen(false)} style={{
      position:'fixed', inset:0, background:'rgba(28,24,20,0.55)',
      display:'flex', alignItems:'flex-start', justifyContent:'center',
      paddingTop:'10vh', zIndex:50, backdropFilter:'blur(4px)',
    }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{
        width:'min(720px, 90vw)', background:'var(--paper)', boxShadow:'0 20px 60px rgba(0,0,0,0.45)',
      }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--ink-4)' }}>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="search packages · chapters · /atlas/* endpoints …"
            style={{
              width:'100%', border:0, outline:0, background:'transparent',
              fontFamily:"'JetBrains Mono', monospace", fontSize:14, color:'var(--ink)',
            }}
          />
        </div>
        <div className="scroll" style={{ maxHeight:'60vh', padding:'8px 0' }}>
          {!inv && <div style={{ padding:'14px 16px', color:'var(--ink-3)' }}>loading inventory…</div>}
          {inv && results && (
            <>
              <Section title="packages">
                {results.pkgs.map(p => (
                  <Row key={p.id} href={`${BASE}/pkg/${p.id.replace(/\//g, '--')}/`} kind={p.kind}
                       primary={p.id} secondary={p.npm} tag="↵" />
                ))}
              </Section>
              <Section title="chapters">
                {results.chapters.map(c => (
                  <Row key={c.id} href={`${BASE}/${c.id === '00' ? '' : c.id + '/'}`}
                       kind={c.voice} primary={`${c.id} · ${c.title}`} secondary={c.read} tag="↵" />
                ))}
              </Section>
              <Section title="agent endpoints">
                {results.endpoints.map(e => (
                  <Row key={e.path} href={endpointHref(e.path)}
                       kind={e.method.toLowerCase()} primary={e.path} secondary={e.desc} tag="json" />
                ))}
              </Section>
            </>
          )}
        </div>
        <div style={{
          padding:'10px 16px', borderTop:'1px solid var(--ink-4)',
          display:'flex', justifyContent:'space-between',
          fontFamily:"'JetBrains Mono', monospace", fontSize:11, color:'var(--ink-3)',
        }}>
          <span>↑↓ navigate · ↵ open · esc close</span>
          {inv && <span>ref @ {inv.repo.sha?.slice(0,7)}</span>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  const items = Array.isArray(children) ? children : [children];
  if (!items.length || items.every(c => !c)) return null;
  return (
    <div style={{ padding:'4px 0' }}>
      <div className="label" style={{ padding:'8px 16px 4px' }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ href, primary, secondary, kind, tag }: any) {
  return (
    <a href={href} style={{
      display:'flex', alignItems:'center', gap:10, padding:'8px 16px',
      textDecoration:'none', color:'var(--ink)',
    }}>
      <span className={`pill kind-${kind}`}>{kind}</span>
      <span style={{ fontFamily:"'JetBrains Mono', monospace", fontSize:13 }}>{primary}</span>
      <span style={{ color:'var(--ink-3)', fontSize:12, fontFamily:"'Outfit', sans-serif" }}>{secondary}</span>
      <span style={{ marginLeft:'auto' }} className="pill faint">{tag}</span>
    </a>
  );
}
