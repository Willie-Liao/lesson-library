# GitHub export (MCP-only)

The public repo [lesson-preparing-graph](https://github.com/Willie-Liao/lesson-preparing-graph) is built from this folder’s rules, **not** by pushing the whole monorepo `lesson-library/` tree.

## Included

- `mcp/` — Cursor MCP server and HITL staging
- `server/` + `web/` — API and review UI the MCP calls (`http://127.0.0.1:8787`)
- `prompts/` — agent skills
- `scripts/` — dev server, embeddings sidecar, tests, optional `npm run seed`
- Empty `library/` skeleton (`export/skeleton/library/`)

## Excluded

- All `library/materials/*.md` and `library/periods/*.md` (your unit data)
- `library/media_library/` binaries
- `paper/`, `Lesson Library.app/`, local `.history`, embeddings cache

Teachers keep materials in a **private** clone or only on disk; `export/github.gitignore` keeps them out of the public remote if they run `git add` locally.

## Publish

```bash
./scripts/push-to-github.sh
```
