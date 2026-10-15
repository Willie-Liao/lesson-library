---
name: explore-the-progression
description: >-
  Use when the teacher asks what is harder than a named drill (same
  game-moment plus one extra the real 5v5 also has). KGQuery first; talk with
  Clarify before any create-materials call.
---

# Explore the progression

Harder means the **same game-moment** plus **one** extra thing a real 5v5 down also has. Isolated skills (“throw farther”) are not a hop.

Moving concept / look: which slice of a real down this drill still is (Initiate the play = start the down: cadence → snap → catchable ball). Isolated skills (throw, catch, pull) are ingredients, not the idea.

Examples of one extra: Center goes **forward only** → Center runs a **named route**; QB catches the snap in place → **2-step drop then throw**.

## Call (JSON only, then wait)

```json
{ "skill": "explore-the-progression", "from": "<M91 or Initiate the play>" }
```

Never invent an `M…` id. Empty `from` is invalid — the server bounces “name the drill.”

## After hops are in the user JSON

Combo cards hide ingredients. Empty `motorSkills` does **not** mean the drill has no skills — read look and notes.

1. Name the **game-moment** of `from` (one sentence).
2. **Inventory isolated skills** for `from` and each browsed hop. Use catalog names (Throwing, Catching, Snapping, Flag pulling, Guarding, Route running, …). Prefer `motorSkills[]` when present; otherwise infer from look/notes (hidden combo). Example: Initiate the play notes snap + catch + run-to-plates even when tags are blank — not Flag pulling.
3. Advise **one** extra the real 5v5 also has (example: add a defender / Flag pulling). Isolated skills are ingredients, not the hop themselves.
4. **Already in this node?** Check look, notes, and tags of `from` before calling the extra missing. If this card already can do it (a rusher already pulls a flag), say so — do **not** create; advise a different extra or an existing hop.
5. If this node cannot already do it, check harder/related ids for that extra. If one hop is it, name the `M…` and why.
6. **Stop.** Return `{ "tool":"Clarify", "reply":"<inventory + advice>", "fields":[{ "id":"extra", "label":"This extra, a different extra, or not yet?", "value":"" }] }` (optional `choices`: agree / different extra / stop). Empty `ops`. **Do not call create-materials** on this turn.
7. Next teacher message: if they tweak the extra, Clarify again. If they agree and a hop already is that extra, final JSON can pick that id / draft a progression link. If they agree and it is still missing, **then** `{ "skill":"create-materials", "items":[{ "name", "look", "notes" }] }`.

Do not skip hops. Linear progression only. Same-difficulty = related `variation to <parent>`, not a second progression. Do not open the creating panel until step 7.

Creating nodes is **create-materials**. Ranking a 40-minute stack of existing ids is **play-loop-lesson-recommend**.
