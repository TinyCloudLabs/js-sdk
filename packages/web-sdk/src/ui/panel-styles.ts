/**
 * Panel stylesheet. Loaded with the lazy panel chunk and appended to the open
 * shadow root on first open. Launcher rules stay in styles.ts.
 * Order matters: focus rings, desktop panel rules, phone, reduced motion, dark.
 * Focus rings come first so the equal-specificity state rules below
 * (aria-current, .ring) keep winning box-shadow where they did before the split.
 * The drawer edge (#e4e4e7 / #69696b) is decorative, not a 3:1 target.
 */
export const PANEL_CSS = `
.glance-row:focus-visible,.nav-i:focus-visible,.action:focus-visible,.switch:focus-visible,.icon-btn:focus-visible,.menu-i:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
.panel{position:fixed;top:0;bottom:0;right:0;box-sizing:border-box;width:min(420px,100%);display:grid;grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:"head" "nav" "main";overflow:hidden;border-left:1px solid #e4e4e7;background:#fff;color:#111827;box-shadow:-18px 0 48px -18px rgba(0,0,0,.35);pointer-events:auto;animation:tc-in .42s cubic-bezier(.22,1,.36,1)}
.layer[data-position="bottom-left"] .panel{left:0;right:auto;border-left:0;border-right:1px solid #e4e4e7;box-shadow:18px 0 48px -18px rgba(0,0,0,.35);animation-name:tc-in-l}
.layer .panel[data-layout="page"]{top:0;bottom:0;left:0;right:0;width:auto;border:0;box-shadow:none;grid-template-rows:auto minmax(0,1fr);grid-template-columns:288px minmax(0,1fr);grid-template-areas:"head head" "nav main"}
.head{grid-area:head;display:flex;flex-wrap:nowrap;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;min-height:68px;padding:14px 12px 10px 20px}
.brand{display:flex;flex-direction:column;min-width:0;flex:1 1 0}
.title{margin:0;font-size:15px;font-weight:600}
.ctx{overflow:hidden;font-size:12.5px;color:#71717a;text-overflow:ellipsis;white-space:nowrap}
.head-actions{display:flex;flex-wrap:nowrap;align-items:center;flex-shrink:0;gap:6px}
.icon-btn{display:inline-flex;flex:none;align-items:center;justify-content:center;box-sizing:border-box;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.icon-btn.ring{box-shadow:inset 0 0 0 1px #71717a}
.icon-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.status{font-size:12px;color:#4b5563}
.nav{grid-area:nav;display:flex;flex-wrap:wrap;gap:6px;padding:6px 20px 14px}
.nav-i{display:inline-flex;align-items:center;min-height:44px;padding:0 13px;border:0;border-radius:999px;background:#f4f4f5;color:#09090b;font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;cursor:pointer}
.nav-i[aria-current="page"]{background:#fff;font-weight:700;box-shadow:inset 0 0 0 2px #09090b}
.nav-n,.nav-ic,.nav-m{display:none}
.main{grid-area:main;min-height:0;overflow:auto;box-sizing:border-box;padding:24px 20px 56px;border-top:2px solid #09090b}
.sec-title{margin:0 0 28px;font-family:"Literata Variable","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:1.5rem;font-weight:400;line-height:1.2;letter-spacing:-.005em}
.section+.section{margin-top:12px;padding-top:12px;border-top:1px solid #e4e4e7}
.action{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;min-height:44px;padding:0 20px;border:1px solid;border-color:#71717a;border-radius:999px;background:#fff;color:#09090b;font:inherit;font-size:13.5px;font-weight:700;white-space:nowrap;cursor:pointer}
.action:hover{background:#f4f4f5}
.layout-switch{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.layout-switch[hidden]{display:none}
.layout-switch svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px}
.label{font-weight:500}
.switch{display:inline-flex;align-items:center;width:56px;min-width:44px;height:44px;padding:0;border:0;background:none;cursor:pointer}
.switch:disabled{cursor:default;opacity:.6}
/* The mockup switch: a 56x30 track with a 1px #71717a edge (the .knob background, so it clears 3:1 on the panel) around a muted fill (::before), and a 22px thumb that is black when off and white on a black track when on. */
.knob{position:relative;display:block;width:56px;height:30px;border-radius:999px;background:#71717a}
.knob::before{content:"";position:absolute;inset:1px;border-radius:999px;background:#f4f4f5}
.knob::after{content:"";position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;background:#09090b;transition:transform .3s cubic-bezier(.22,1,.36,1)}
.switch[aria-checked="true"] .knob{background:#09090b}
.switch[aria-checked="true"] .knob::before{background:#09090b}
.switch[aria-checked="true"] .knob::after{transform:translateX(26px);background:#fff}
.busy,.note,.error{margin:6px 0 0;font-size:12px;color:#4b5563}
.note{text-wrap:pretty}
.action+.note,.note:not([hidden])+.action,.row~.action{margin-top:8px}
.error{color:#111827}
.confirm{margin-top:8px}
.confirm .actions{display:flex;gap:8px;margin:8px 0}
.layer .panel[data-layout="page"] .head{padding:12px 24px;border-bottom:1px solid #e4e4e7;background:#fff}
.layer .panel[data-layout="page"] .nav{flex-direction:column;flex-wrap:nowrap;width:288px;box-sizing:border-box;padding:24px 16px;border-right:1px solid #e4e4e7;background:#fafafa}
.layer .panel[data-layout="page"] .nav-i{width:100%;min-height:48px;padding:0 12px;border-radius:14px;background:transparent;font-size:14.5px}
.layer .panel[data-layout="page"] .nav-i[aria-current="page"]{background:#fff}
.layer .panel[data-layout="page"] .nav-i{gap:8px}
.layer .panel[data-layout="page"] .nav-ic{display:inline-block;width:16px;height:16px}
.layer .panel[data-layout="page"] .nav-m{display:inline;max-width:90px;margin-left:auto;overflow:hidden;color:#71717a;font-size:12.5px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.layer .panel[data-layout="page"] .nav-i[aria-current="page"] .nav-m{color:#09090b}
.layer .panel[data-layout="page"] .nav-n{display:inline-block;width:18px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:#71717a}
.layer .panel[data-layout="page"] .main{padding:40px 40px 80px;border-top:0;max-width:960px;width:100%;margin:0 auto}
.layer .panel[data-layout="page"] .sec-title{font-size:1.75rem;line-height:2.125rem;font-weight:600}
@keyframes tc-in{from{transform:translateX(104%)}to{transform:none}}
@keyframes tc-in-l{from{transform:translateX(-104%)}to{transform:none}}
.menu-wrap{display:none;position:relative}
.menu{position:absolute;top:calc(100% + 6px);right:0;z-index:2;box-sizing:border-box;width:min(280px,calc(100vw - 24px));padding:6px;border-radius:16px;background:#fff;box-shadow:inset 0 0 0 1px #e4e4e7,0 12px 32px -8px rgba(0,0,0,.3)}
.menu[hidden]{display:none}
.menu-i{display:flex;align-items:center;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.menu-i[aria-current="page"]{font-weight:700;background:#f4f4f5}
.layer[data-phone] .menu-wrap{display:block}
.layer[data-phone] .nav{display:none}
.layer[data-phone] .panel[data-layout="page"]{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "main"}
.layer[data-phone] .panel[data-layout="page"] .head{padding:12px 12px 12px 16px}
.layer[data-phone] .panel[data-layout="page"] .main{padding:24px 16px 56px}
.layer{--tc-color-overlay:rgb(9 9 11 / .4)}
.scrim{position:fixed;inset:0;background:var(--tc-color-overlay);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .35s cubic-bezier(.22,1,.36,1),visibility 0s .35s}
.layer[data-panel-open][data-layout="drawer"] .scrim{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .35s cubic-bezier(.22,1,.36,1)}
@media (prefers-reduced-motion:reduce){
.panel,.knob::after,.scrim,.layer[data-panel-open][data-layout="drawer"] .scrim{animation:none;transition:none}
}
@media (prefers-color-scheme: dark){
.layer{--tc-color-overlay:rgb(0 0 0 / .6)}
.glance-row:focus-visible,.nav-i:focus-visible,.action:focus-visible,.switch:focus-visible,.icon-btn:focus-visible,.menu-i:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
.panel{border-left-color:#69696b;background:#151517;color:#fafafa}
.main{border-top-color:#fafafa}
.ctx,.status,.busy,.note{color:#a1a1aa}
.nav-i{background:#27272a;color:#fafafa}
.nav-i[aria-current="page"]{background:#151517;box-shadow:inset 0 0 0 2px #fafafa}
.icon-btn.ring{box-shadow:inset 0 0 0 1px #71717a}
.section+.section{border-top-color:#69696b}
.action{border-color:#71717a;background:#151517;color:#fafafa}
.action:hover{background:#27272a}
.error{color:#fafafa}
.knob::before{background:#27272a}
.knob::after{background:#fafafa}
.switch[aria-checked="true"] .knob{background:#fafafa}
.switch[aria-checked="true"] .knob::before{background:#fafafa}
.switch[aria-checked="true"] .knob::after{background:#09090b}
.layer .panel[data-layout="page"] .head{background:#151517;border-bottom-color:#69696b}
.layer .panel[data-layout="page"] .nav{background:#151517;border-right-color:#69696b}
.layer .panel[data-layout="page"] .nav-i{background:transparent}
.layer .panel[data-layout="page"] .nav-i[aria-current="page"]{background:#27272a}
.layer .panel[data-layout="page"] .nav-n,.layer .panel[data-layout="page"] .nav-m{color:#a1a1aa}
.layer .panel[data-layout="page"] .nav-i[aria-current="page"] .nav-m{color:#fafafa}
.menu{background:#151517;box-shadow:inset 0 0 0 1px #69696b,0 12px 32px -8px rgba(0,0,0,.6)}
.menu-i[aria-current="page"]{background:#27272a}
}
`;
