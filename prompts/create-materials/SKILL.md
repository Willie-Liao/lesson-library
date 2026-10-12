---
name: create-materials
description: >-
  Use when the teacher asks Chat to create, add, or batch-add FLAG material
  nodes (drills). Must run before any create or update op. Fills look and
  Explanation, then looks up similar graph cards with embeddings so existing
  nodes are not rebuilt.
---

# Create materials

You **must call** this skill before emitting material create or update ops.

Script (already in the app — do not reimplement):

`2026-2027 Fall/lesson-library/server/embed.ts` `searchMaterials`

The server runs that lookup. You only emit the skill JSON, then wait.

## Call (JSON only, then wait)

```json
{ "skill": "create-materials", "items": [{ "name": "<drill title>", "look": "<What to look for>", "notes": "<Explanation>" }] }
```

One object per requested node. **look** and **notes** are required. Never invent an `M…` id.

- look — What to look for: freeze this **game-moment** (the 5v5 slice still true after stripping players). Not a generic cue or setup. Isolated skills (throw, catch, pull) are ingredients, not the idea.
- notes — Explanation: how the drill is done (groups, steps, rotate, why)

If the server bounces, fill both fields and call the skill again. Do not skip notes.

## What the server does

1. Rejects the call until every item has look and notes.
2. Embedding search on name + look + notes (keyword fallback if the embed sidecar is down).
3. Top hit at or above `DUP_SCORE` → **discard** the new node; keep the existing `M…`.
4. Below the score → creating panel with look and notes filled.

Do not emit `ops` yourself for those items. Do not skip the skill because a name “looks new”.
