---
name: write-lesson-in-schedule
description: >-
  Use when the teacher asks Chat to put one or more lessons onto class days
  (schedule, period stack, days[]). Runs create-materials first so drills are
  not rebuilt, then Clarify, DateSlots, and KGQuery.
---

# Write lesson in schedule

You **must call** this skill when the demand is to fill class days, not only to add a graph node.

## Call (JSON only, then wait)

```json
{ "skill": "write-lesson-in-schedule", "items": [{ "name": "<main drill>", "look": "<What to look for>", "notes": "<Explanation>" }], "lessonCount": 2 }
```

`items` are the mains (and any named new drills). `lessonCount` is how many periods if the demand says so.

## Order (server-enforced)

1. **create-materials** — fill look and Explanation, then embed-compare. Duplicates are discarded (existing `M…` kept). New items get the creating panel. Do not invent `M…` ids.
2. **Clarify** — only if grade is missing or that grade is not in arrangement.
3. **DateSlots** — class days from Settings. Do not invent weekdays.
4. **KGQuery** — semantic lookup for warm-up and game-simulation hops around the chosen mains.
5. Final JSON `{ reply, days, picks, ops }` with DateSlots dates on `days[]`.

If user JSON already has DateSlots or KGQuery rows, skip those tools. If look or notes is still missing, fill them and call create-materials again; do not fill `days[]` yet.

Recommend-only hops without creating or scheduling stay in `play-loop-lesson-recommend`.
