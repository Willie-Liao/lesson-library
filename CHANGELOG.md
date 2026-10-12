# Changelog

## v0.3.2 — 2026-10-12

### Added
- **`<agent-note>` library guard** — materials, periods, sets, and calendar files carry a short banner telling agents to use MCP (`update_material`, `save_period`, `save_calendar`, etc.) instead of editing Markdown directly.
- **Guard tooling** — `scripts/check-agent-note.ts`, `check-library-guard.py`, `install-library-guard.py`, `library-mcp-only.py`, and `hooks/minimax/library-mcp-only.md` for MiniMax/Codex-style workflows.
- MCP read helpers append the same guidance on `get_material`, `list_sets`, `get_period`, and `get_calendar` responses.

### Changed
- **`merge`** — stores the caller's rewritten name, look, and notes, and rejects a pasted source block. Sources stay.
- **Store** — strip agent notes when parsing YAML; re-insert on write; history index includes a system note.
- **MCP HITL** — session handling and debug logging refinements.

### Install / upgrade
```bash
git pull
npm install
pip install -r mcp/requirements.txt
npm run build
npm run dev
```

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
