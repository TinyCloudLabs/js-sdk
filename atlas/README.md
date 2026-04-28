# TinyCloud SDK Atlas

A working map of the [TinyCloudLabs/js-sdk](https://github.com/TinyCloudLabs/js-sdk)
codebase. Internals, not surface — built for architects and agents working
inside the repo, not for SDK consumers.

> The repo is the truth. The atlas is the truth, *arranged*.

## Two artifacts in one tree

The atlas serves the same facts to two audiences:

- **Humans** read the website at <https://tinycloudlabs.github.io/js-sdk/atlas/>
- **Agents** read the same data as plain JSON, curl-able from `/atlas/data/*.json`

Every human page is regenerable from the JSON, so they can't drift apart.

## Local development

    cd atlas
    bun install
    bun run atlas:rebuild   # walk packages/* → public/data/*.json
    bun run dev             # serve the human site at http://localhost:4321/js-sdk/atlas/

## Building & deploying

The atlas builds to `../docs/atlas/`. GitHub Pages serves from `/docs`,
so a merge to `master` publishes automatically via
[`.github/workflows/atlas.yml`](.github/workflows/atlas.yml).

A nightly cron job rebuilds the atlas even with no pushes — so
`drift.json` reflects current reality.

## Source layout

    atlas/
    ├── astro.config.mjs        # outDir → ../docs/atlas, base: /js-sdk/atlas
    ├── scripts/
    │   └── rebuild.mjs         # `bun run atlas:rebuild` — generator scaffold
    ├── curated/                # YAML overlays — the only prose we hand-write
    │   ├── sdk-core.yaml       # (TODO — see HANDOFF.md)
    │   └── …
    ├── public/
    │   └── data/               # JSON artifacts — bundled into the build verbatim
    │       ├── inventory.json
    │       ├── pkg/<id>.json
    │       ├── flow/siwe-login.json
    │       ├── state/session.json
    │       ├── cmds.json
    │       ├── drift.json
    │       ├── artifacts.json
    │       ├── meta.json       # the rebuild recipe
    │       └── llms.txt        # agent quickstart
    └── src/
        ├── styles/atlas.css    # both themes via [data-theme]
        ├── lib/atlas.ts        # build-time JSON loader
        ├── layouts/Atlas.astro # shell + TOC + chrome
        ├── components/
        │   ├── ThemeToggle.astro  # vanilla JS island
        │   └── CmdK.tsx           # React island, fetches inventory.json
        └── pages/
            ├── index.astro          # cover
            ├── 01/index.astro       # 01 · three surfaces, one core ✅ ported
            ├── 02..09/index.astro   # stubs — see HANDOFF.md
            ├── pkg/[pkg]/index.astro  # dynamic per-package detail ✅ ported
            └── agents/index.astro     # /atlas/data/* endpoints reference

## Status

This is a **scaffold**. The visual system, data layer, layout, ⌘K, and
two routes (index + chapter 01 + per-package detail) are wired and working.
Eight chapter routes are stubbed with TODO markers pointing to the
prototype screen they should port.

See [`HANDOFF.md`](HANDOFF.md) for the concrete next steps.
