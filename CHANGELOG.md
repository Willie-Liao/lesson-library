# Changelog

## v0.3.1 — 2026-10-12

### Added
- **`merge` MCP tool** — combine two or more source materials into one new harder node while keeping every source id in the op.
- **Tag-aware related links** — update and delete related hops match on `tag` when several related edges share the same target.

### Changed
- **Store / graph validation** — `validateRelatedHop` receives the proposed tag; related-link patches no longer collide when multiple `related` edges point at the same material.
- **Web** — trim unused timeline/graph UI paths; tests for graph model and LLM patch parsing.

### Install / upgrade
```bash
git pull
npm install
pip install -r mcp/requirements.txt
npm run build
npm run dev
```

## v0.3.0 — 2026-10-12

### Added
- **`de_dup` MCP tool** — fold a near-duplicate material into a keeper and drop the redundant id (replaces ambiguous `merge_material` naming).
- **Graph `?peek=` deep links** — visiting with `peek=M…` keeps that node visible in the saved graph view (`extraIds`).
- **LLM `de_dup` / merge patch ops** — server applies dedup and multi-source merge flows with expanded tests.

### Changed
- **Timeline activity cards** — mid-column layout for look / explanation / class note / sketches; removed per-card “Differentiation” hop block from plan cells.
- **kg-chat-system** prompt — documents `de_dup` vs merge behavior.
- Removed obsolete **`keep-buttons.html`** agent reference page from the distribution.

### Install / upgrade
```bash
git pull
npm install
pip install -r mcp/requirements.txt
npm run build
npm run dev
```

## v0.2.0 — 2026-10-12

- MCP-only GitHub export with empty `library/` skeleton.
- Dev supervisor (`mcp_supervisor.py`), port-aware `npm run dev`.
- General-audience README (all subjects, not PE-only).
