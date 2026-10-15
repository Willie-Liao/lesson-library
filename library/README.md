# Your lesson library (local data)

This folder is **not** shipped with school-specific materials in the public Git repo.

| Path | Purpose |
| --- | --- |
| `materials/` | One Markdown file per drill (`M1.md`, …) |
| `periods/` | Saved class periods by date and grade |
| `media_library/` | Sketches and clips referenced from materials |
| `_calendar.yaml` | Class days, holidays, focus ranges |
| `_foci.yaml` | Unit arc the agent reads but does not invent |
| `_sets.yaml` | Activity sets (skill groupings); grows as you teach |

## Optional starter graph

```bash
npm run seed
```

Creates a small demo graph (M1–M10) for trying MCP and the review UI. Delete `materials/*.md` and `periods/*.md` anytime to go back to empty.

Your real unit data can stay only on your machine or in a **private** git remote; add this directory to your own backup workflow.
