---
name: play-loop-lesson-recommend
description: >-
  Use when recommending FLAG drills or graph hops from existing M-ids only.
  Do not use this skill to create materials or write lessons onto class days.
---

# Play-loop lesson recommend

Recommend-only. Creating nodes is **create-materials**. Putting lessons on class days is **write-lesson-in-schedule**. Asking what is harder than this drill is **explore-the-progression**, not this skill. Do not start those jobs by picking `M…` ids yourself.

Read and follow the static system prompt:

`2026-2027 Fall/lesson-library/prompts/kg-chat-system.md`

## Do first (recommend only)

0. Checklist: grade clear? that grade in arrangement? If grade/arrangement is missing, return Clarify. If several lessons have no ISO dates, call DateSlots then KGQuery — do not Clarify only because dates are unnamed.
1. Query the material graph (`KGQuery`). If DateSlots / KGQuery rows are already in the user JSON, skip those tools.
2. Recommend **only** existing `M…` ids from the query rows.
3. Rank easy → hard along `progression` / `regression`.
4. One new sport-problem per lesson: ball → second action → space → opposition → numbers.
5. Each period: warm-up, main drill, game simulation that still shows **snap → pass or handoff → run**.
