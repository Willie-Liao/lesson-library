import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatTaskItem, ChatTaskState, ClarifyField, ClassNote, Foci, Link, Material, MaterialSet, PatchOp, Period, Suggestion } from "../web/types.ts";
import { chainHarderOf, eloUpdateLeap, filterMaterials, hopLeap, neighborsOf, validateProgressionHop, validateRelatedHop } from "../web/graph-model.ts";
import { GRADE_TOKEN, listClassDates } from "../web/calendar-model.ts";
import { parseMotorSkills, parseSkillRelatedComponents, type MotorSkill } from "../web/material-taxonomy.ts";
import { clusterByTimeAndContent, searchMaterials } from "./embed.ts";
import {
  attachSketch,
  beginBatch,
  clearChatSession,
  createLink,
  createMaterial,
  createSet,
  deleteLink,
  deleteMaterial,
  deleteSet,
  endBatch,
  getCalendar,
  listLinks,
  listMaterials,
  listPeriods,
  listSets,
  readChatSessionFile,
  savePeriod,
  updateLink,
  updateMaterial,
  updateSet,
} from "./store.ts";

/** Byte-stable system prompt. Do not interpolate request data here. */
export const SYSTEM_PROMPT = `You are a PE teacher's assistant for a Grade 6 / Grade 7 NFL FLAG unit.

You suggest the NEXT 40-minute period. You do not invent the unit arc. The teacher wrote the foci; stay on the current focus unless the reflection explicitly says they are ready to leave it.

A period is a timed stack of activities (start/end clocks). Difficulty is hop leap and duration, not Instant / Skill / Key labels.

Graph: materials are nodes (id like M2). Links:
- regression: from is easier than to
- progression: to is harder than from
- related (has a tag) / tag: same idea, not a step

Rules:
1. Choose only existing material ids from the user message. Never invent an id.
2. Prefer one hop along regression/progression unless the reflection asks for more (too easy / too slow → one hop harder; too hard / too fast → one hop easier). If the reflection does not ask to change, keep the same pin.
3. Prefer a material whose duration and cluster fit the clock you assign. Say so in why if you step off duration.
4. summary must name the current focus number and its text.
5. If the user JSON has "mode": "goal" and a non-empty "goal", choose picks that serve that goal. Still only existing ids. You may step further than one hop when the goal requires it.
6. If mode is "last" or omitted, follow rules 2–4 from this period's pins, reflection, objective, and nextGoal.
7. Return JSON only, matching:
{
  "focus": <number>,
  "summary": "<string>",
  "picks": [{ "id": "M…", "why": "<string>", "start"?: "HH:MM", "end"?: "HH:MM" }]
}`;

function env(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function llmKey() {
  return env("ANTHROPIC_API_KEY") || env("MINIMAX_CN_API_KEY") || env("OPENAI_API_KEY");
}

function messagesUrl(base: string) {
  const trimmed = base.replace(/\/$/, "");
  if (trimmed.endsWith("/v1/messages")) return trimmed;
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return trimmed + "/messages";
  return trimmed + "/v1/messages";
}

type AnthropicBlock = { type?: string; text?: string };

export function extractAnthropicText(data: { content?: string | AnthropicBlock[] }): string {
  const content = data.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n")
    .trim();
}

export function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

function parseJsonValue(raw: string): unknown {
  const trimmed = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const obj = parseJsonObject<Record<string, unknown>>(trimmed);
    if (obj) return obj;
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parametersFromXml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const parsed = parseJsonValue(m[2]);
    out[m[1]] = parsed !== null && parsed !== undefined ? parsed : String(m[2] || "").trim();
  }
  return out;
}

function chainConnected(a: string, b: string, links: Link[]): boolean {
  const walk = (from: string, to: string) => {
    const seen = new Set([from]);
    const q = [from];
    for (let i = 0; i < q.length; i++) {
      for (const u of chainHarderOf(q[i]!, links)) {
        if (u === to) return true;
        if (seen.has(u)) continue;
        seen.add(u);
        q.push(u);
      }
    }
    return false;
  };
  return walk(a, b) || walk(b, a);
}

function variationPair(keep: string, drop: string, links: Link[]): boolean {
  return links.some((L) => {
    if (L.kind !== "related") return false;
    const pair = (L.from === keep && L.to === drop) || (L.from === drop && L.to === keep);
    return pair && String(L.tag || "").toLowerCase().startsWith("variation to");
  });
}

function normalizePatchOp(op: unknown): PatchOp | null {
  if (!op || typeof op !== "object") return null;
  const o = op as Record<string, unknown>;
  const data = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : {};
  if (o.action === "de_dup" || o.op === "de_dup") {
    return {
      entity: "material",
      action: "de_dup",
      keep: o.keep || data.keep,
      drop: o.drop || data.drop,
      name: o.name || data.name,
      look: o.look || data.look,
      notes: o.notes || data.notes,
      why: o.why || data.why,
    } as PatchOp;
  }
  if (o.action === "merge" || o.op === "merge") {
    const rawSources = o.sources ?? data.sources;
    const sources = Array.isArray(rawSources)
      ? rawSources.map(String).filter(Boolean)
      : String(rawSources || "").split(/\s+/).filter(Boolean);
    return {
      entity: "material",
      action: "merge",
      sources,
      keep: o.keep || data.keep,
      drop: o.drop || data.drop,
      name: o.name || data.name,
      look: o.look || data.look,
      notes: o.notes || data.notes,
      why: o.why || data.why,
    } as PatchOp;
  }
  if (o.entity === "material" || o.entity === "link" || o.entity === "set") {
    if (o.entity === "material" && !o.notes) o.notes = o.explanation || data.notes || data.explanation;
    return o as PatchOp;
  }
  if (o.op === "link" || o.type === "link" || o.rtype || (o.from && o.to && !data.name && !o.name)) {
    const kind = String(o.rtype || o.kind || "progression");
    return {
      entity: "link",
      action: "create",
      from: o.from,
      to: o.to,
      kind: kind === "related" || kind === "regression" ? kind : "progression",
      note: o.label || o.note || "",
      tag: o.tag || "",
    } as PatchOp;
  }
  const name = data.name || o.name;
  if (name || o.type === "node" || o.type === "material") {
    return {
      entity: "material",
      action: o.op === "update" ? "update" : o.op === "delete" ? "delete" : "create",
      name,
      look: data.look || o.look || "",
      notes: data.notes || data.explanation || o.notes || o.explanation || "",
      duration: data.duration || o.duration,
      tempId: o.tempId || name,
      setIds: data.setIds || o.setIds,
      motorSkills: data.motorSkills || o.motorSkills,
      skillRelatedComponents: data.skillRelatedComponents || o.skillRelatedComponents,
    } as PatchOp;
  }
  return o as PatchOp;
}

function coerceOps(raw: unknown): PatchOp[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") return coerceOps(parseJsonValue(raw));
  else if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (Array.isArray(rec.ops)) list = rec.ops;
    else if (rec.entity || rec.op || rec.type) list = [rec];
  }
  return list.map(normalizePatchOp).filter((x): x is PatchOp => !!x);
}

/** Count distinct "Lesson N" headings in teacher demand (multi-lesson plans). */
export function lessonCountFromDemand(text: string): number {
  const t = String(text || "");
  const nums = new Set<number>();
  const re = /\bLesson\s+(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5) nums.add(n);
  }
  if (nums.size >= 2) return Math.min(5, Math.max(...nums));
  const word = t.match(/\b(two|three|four|five|\d+)\s+lessons?\b/i);
  if (word) {
    const map: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
    const n = map[word[1]!.toLowerCase()] ?? Number(word[1]);
    if (n >= 2 && n <= 5) return n;
  }
  return nums.size === 1 ? 1 : 0;
}

/** MiniMax may emit several `<invoke name="KGQuery">` blocks in one turn. */
export function extractChatQueryBatch(raw: string): KgQueryArgs[] {
  const out: KgQueryArgs[] = [];
  const re = /<invoke\s+name="KGQuery"[^>]*>([\s\S]*?)<\/invoke>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push(parametersFromXml(m[0]) as KgQueryArgs);
  }
  if (out.length) return out;
  const single = extractChatAction(raw);
  if (single?.tool === "KGQuery") return [(single.args || {}) as KgQueryArgs];
  return [];
}

function chatFailMessage(lastRaw: string, lastErr = ""): string {
  const err = String(lastErr || "").trim();
  if (err) return err.slice(0, 160);
  if (/<invoke|<minimax:tool_call/i.test(lastRaw)) {
    return "Model kept querying instead of returning a lesson draft. Try Retry or shorten the demand.";
  }
  if (/ANTHROPIC_API_KEY|LLM \d+/i.test(lastRaw)) return lastRaw.split("\n")[0]!.slice(0, 160);
  const head = String(lastRaw || "").trim().split("\n")[0] || "";
  if (/^```/.test(head)) return "model returned unusable JSON";
  if (head.length > 160) return head.slice(0, 160) + "…";
  return head || "model returned unusable JSON";
}

const CHAT_LOOP_SKILLS = "create-materials|write-lesson-in-schedule|explore-the-progression";

function isCreateWriteSkill(s: unknown): s is ChatTaskState["skill"] {
  return s === "create-materials" || s === "write-lesson-in-schedule";
}

function isExploreSkill(s: unknown): s is "explore-the-progression" {
  return s === "explore-the-progression";
}

function isChatLoopSkill(s: unknown): s is "create-materials" | "write-lesson-in-schedule" | "explore-the-progression" {
  return isCreateWriteSkill(s) || isExploreSkill(s);
}

export function extractChatAction(raw: string): Record<string, unknown> | null {
  const skillInvoke = new RegExp(`<invoke\\s+name="(${CHAT_LOOP_SKILLS})"`, "i").exec(raw);
  if (skillInvoke) {
    const slice = raw.slice(skillInvoke.index);
    const params = parametersFromXml(slice);
    const items = Array.isArray(params.items) ? params.items : params.items != null ? [params.items] : [];
    return { skill: skillInvoke[1], items, lessonCount: params.lessonCount, from: params.from };
  }
  const invoke = /<invoke\s+name="(KGQuery|KGPatch|DateSlots)"/i.exec(raw);
  if (invoke) {
    const slice = raw.slice(invoke.index);
    const params = parametersFromXml(slice);
    const argsBlock = /<args>([\s\S]*?)<\/args>/i.exec(slice);
    const argsVal = argsBlock ? parseJsonValue(argsBlock[1]) : null;
    const args = argsVal && typeof argsVal === "object" && !Array.isArray(argsVal) ? argsVal as Record<string, unknown> : {};
    const merged = { ...params, ...args };
    const name = invoke[1];
    if (name === "KGQuery") return { tool: "KGQuery", args: Object.keys(merged).length ? merged : (argsVal && typeof argsVal === "object" ? argsVal : {}) };
    if (name === "DateSlots") return { tool: "DateSlots", args: Object.keys(merged).length ? merged : (argsVal && typeof argsVal === "object" ? argsVal : {}) };
    const ops = coerceOps(merged.ops != null ? merged.ops : argsVal);
    return { tool: "KGPatch", ops, reply: merged.reply, picks: merged.picks, objective: merged.objective, days: merged.days };
  }
  const normalized = raw.replace(/=>/g, ":");
  const parsed = parseJsonObject<Record<string, unknown>>(normalized);
  if (!parsed) {
    if (/KGQuery/i.test(raw) && !/KGPatch/i.test(raw)) return { tool: "KGQuery", args: {} };
    return null;
  }
  if (isChatLoopSkill(parsed.skill)) return parsed;
  if (parsed.tool === "KGQuery") return parsed;
  if (parsed.tool === "DateSlots") return parsed;
  if (parsed.tool === "Clarify") {
    return { ...parsed, fields: clarifyFields(parsed.fields), ops: undefined };
  }
  if (parsed.tool === "KGPatch") return { ...parsed, ops: coerceOps(parsed.ops), reply: parsed.reply, picks: parsed.picks, objective: parsed.objective, fields: parsed.fields };
  if (parsed.ops) parsed.ops = coerceOps(parsed.ops);
  if (Array.isArray(parsed.fields) && parsed.fields.length) {
    parsed.tool = "Clarify";
    parsed.fields = clarifyFields(parsed.fields);
  }
  if (parsed.reply != null || parsed.ops || parsed.picks || parsed.objective || parsed.fields || parsed.days) return parsed;
  if (parsed.q != null || parsed.grade != null || parsed.setId != null || parsed.leapMin != null) {
    return { tool: "KGQuery", args: parsed };
  }
  if (/KGQuery/i.test(raw) && !parsed.reply) return { tool: "KGQuery", args: parsed.args && typeof parsed.args === "object" ? parsed.args as Record<string, unknown> : parsed };
  return parsed;
}

function isChatFinal(parsed: Record<string, unknown> | null): boolean {
  if (!parsed || parsed.tool === "KGQuery" || parsed.tool === "KGPatch" || parsed.tool === "DateSlots") return false;
  if (isChatLoopSkill(parsed.skill)) return false;
  if (parsed.tool === "Clarify" || (Array.isArray(parsed.fields) && parsed.fields.length)) return true;
  const ops = parsed.ops;
  const picks = parsed.picks;
  const days = parsed.days;
  return !!(parsed.reply || (Array.isArray(ops) && ops.length) || (Array.isArray(picks) && picks.length) || (Array.isArray(days) && days.length));
}

export type ChatLlmStatus = "understanding" | "looking-up" | "putting-together" | "organising";

export type ChatStatusEvent = {
  status: ChatLlmStatus;
  skill?: "create-materials" | "write-lesson-in-schedule" | "explore-the-progression";
  tool?: "Clarify" | "DateSlots" | "KGQuery" | "KGPatch";
};

export const CHAT_STATUS_LABELS: Record<ChatLlmStatus, string> = {
  understanding: "understanding user's request",
  "looking-up": "looking up in knowledge graph",
  "putting-together": "putting materials together",
  organising: "organising the response",
};

export function clarifyFields(raw: unknown): ClarifyField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const o = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const choices = Array.isArray(o.choices)
      ? o.choices.map((c) => {
        const rec = c && typeof c === "object" ? c as Record<string, unknown> : {};
        return { id: String(rec.id || "").trim(), name: String(rec.name || rec.id || "").trim() };
      }).filter((c) => c.id)
      : undefined;
    const field: ClarifyField = {
      id: String(o.id || "").trim() || "note",
      label: String(o.label || o.id || "").trim() || "Fill in",
      value: String(o.value || ""),
    };
    if (choices && choices.length) field.choices = choices;
    const materialId = String(o.materialId || "").trim();
    if (materialId) field.materialId = materialId;
    return field;
  }).filter((f) => f.id);
}

export function chatStatusSequence(tools: string[]): ChatStatusEvent[] {
  const out: ChatStatusEvent[] = [{ status: "understanding" }];
  let queried = false;
  let skill: ChatStatusEvent["skill"];
  for (const t of tools) {
    if (t === "create-materials" || t === "write-lesson-in-schedule" || t === "explore-the-progression") {
      skill = t;
      out.push({ status: "looking-up", skill });
    } else if (t === "KGQuery" || t === "DateSlots") {
      out.push({ status: "looking-up", skill, tool: t });
      queried = true;
    } else if (t === "Clarify") {
      out.push({ status: "organising", skill, tool: "Clarify" });
    } else if (t === "KGPatch" || t === "final") {
      if (queried) out.push({ status: "putting-together", skill });
      out.push({ status: "organising", skill, tool: t === "KGPatch" ? "KGPatch" : undefined });
    }
  }
  return out;
}

export function compactPeriodIndex(periods: Period[]): { id: string; date: string; grade: string }[] {
  return (periods || []).map((p) => ({ id: p.id, date: p.date, grade: p.grade }));
}

export type DateSlotRow = {
  date: string;
  grade: string;
  id: string;
  exists: boolean;
  empty: boolean;
};

export type LookupCache = {
  demand: string;
  grade: string;
  dateSlots?: DateSlotRow[];
  kg?: { id: string; name?: string; look?: string; notes?: string; duration?: number }[];
  nodes?: number;
  edges?: number;
};

export function lookupCacheMatches(cache: LookupCache | null | undefined, demand: string, grade: string): boolean {
  if (!cache) return false;
  const has = (cache.dateSlots && cache.dateSlots.length) || (cache.kg && cache.kg.length);
  if (!has) return false;
  return String(cache.demand || "").trim() === String(demand || "").trim()
    && String(cache.grade || "") === String(grade || "");
}

export function runDateSlots(
  args: { grade?: string; count?: number; after?: string },
  input: {
    classDays: Record<string, number[]>;
    entries?: import("../web/types.ts").CalendarEntry[];
    periods: Period[];
    grade: string;
    after: string;
    count: number;
  },
): DateSlotRow[] {
  const grade = String(args.grade || input.grade || "").trim();
  const count = Math.min(5, Math.max(1, Number(args.count) || input.count || 1));
  const after = String(args.after || input.after || "").trim();
  if (!after || !/^\d{4}-\d{2}-\d{2}$/.test(after)) return [];
  const slots = listClassDates({
    classDays: input.classDays,
    grade,
    after,
    count,
    entries: input.entries || [],
    includeAfter: true,
  });
  return slots.map((s) => {
    const p = input.periods.find((row) => row.date === s.date && row.grade === s.grade);
    const empty = !p || !(p.activities && p.activities.length);
    return { date: s.date, grade: s.grade, id: s.id, exists: !!p, empty };
  });
}

const CHAT_PROMPT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "kg-chat-system.md"),
  "utf8",
);

const EXPLORE_SKILL = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "explore-the-progression", "SKILL.md"),
  "utf8",
);

function compactMaterials(materials: Material[]) {
  return materials.map((m) => ({
    id: m.id,
    name: m.name,
    look: m.look,
    duration: m.duration,
    motorSkills: m.motorSkills,
    skillRelatedComponents: m.skillRelatedComponents,
  }));
}

function compactLinks(links: Link[]) {
  return links.map((L) => ({
    from: L.from,
    kind: L.kind,
    to: L.to,
    note: L.note,
    tag: L.tag,
    leap: L.kind === "related" ? undefined : hopLeap(L),
    nudgeCount: L.nudgeCount || 0,
  }));
}

export function compactPeriod(p: Period | null) {
  if (!p) return null;
  return {
    id: p.id,
    date: p.date,
    grade: p.grade,
    activities: p.activities || [],
    reflection: p.reflection || { flags: [], text: "" },
    objective: p.objective || "",
    nextGoal: p.nextGoal || "",
  };
}

export type ChatMsg = { role: "user" | "assistant"; content: string };

/** Last `stepCount` user/assistant operation pairs for the model window. */
export function llmHistoryWindow(history: ChatMsg[], stepCount = 3): ChatMsg[] {
  const rows = (history || []).filter((m) => m && (m.role === "user" || m.role === "assistant"));
  const out: ChatMsg[] = [];
  let users = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    out.unshift(rows[i]!);
    if (rows[i]!.role === "user") users += 1;
    if (users >= stepCount) break;
  }
  return out;
}

export const DUP_SCORE = 0.82;

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] || 0) * (b[i] || 0);
  return s;
}

export type SkillItem = { name: string; look?: string; notes?: string };

export function parseSkillItems(raw: unknown): SkillItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    if (typeof row === "string") return { name: row.trim() };
    const o = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const notesRaw = o.notes != null ? o.notes : o.explanation;
    return {
      name: String(o.name || "").trim(),
      look: o.look != null ? String(o.look) : undefined,
      notes: notesRaw != null ? String(notesRaw) : undefined,
    };
  }).filter((x) => x.name);
}

export function scoreHitsForQuery(
  q: string,
  materials: Material[],
  vectors: Record<string, number[]> = {},
  qVec?: number[],
  k = 5,
): { id: string; name: string; score: number }[] {
  const query = String(q || "").trim();
  if (!query) return [];
  const limit = Math.max(1, k);
  if (qVec?.length && Object.keys(vectors).length) {
    return materials
      .map((m) => ({
        id: m.id,
        name: m.name,
        score: vectors[m.id]?.length ? cosine(qVec, vectors[m.id]!) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  const needle = query.toLowerCase();
  const hits: { id: string; name: string; score: number }[] = [];
  for (const m of materials) {
    const blob = (m.id + " " + m.name + " " + (m.look || "") + " " + (m.notes || "")).toLowerCase();
    if (!blob.includes(needle)) continue;
    let score = 0.5;
    if (m.name.toLowerCase().includes(needle)) score = 1;
    else if ((m.look || "").toLowerCase().includes(needle)) score = 0.8;
    hits.push({ id: m.id, name: m.name, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function dupCheckItems(
  items: SkillItem[],
  materials: Material[],
  vectors: Record<string, number[]> = {},
  qVecByItem?: (number[] | undefined)[],
  topHits?: { id: string; name: string; score: number }[][],
): ChatTaskItem[] {
  return items.map((item, i) => {
    const id = "item-" + (i + 1);
    const q = [item.name, item.look, item.notes].filter(Boolean).join(" ");
    const hits = (topHits?.[i] && topHits[i]!.length)
      ? topHits[i]!
      : scoreHitsForQuery(q, materials, vectors, qVecByItem?.[i], 5);
    const top = hits[0];
    const row: ChatTaskItem = { id, name: item.name, look: item.look, notes: item.notes };
    if (top && top.score >= DUP_SCORE) {
      row.existingId = top.id;
      row.existingName = top.name;
      row.score = top.score;
    }
    return row;
  });
}

export function createMaterialsFromDupCheck(
  items: ChatTaskItem[],
  skill: ChatTaskState["skill"],
): { taskState: ChatTaskState; fields?: ClarifyField[]; ops?: PatchOp[]; reply: string } {
  const existing = items.filter((i) => i.existingId);
  const missing = items.filter((i) => !i.existingId);
  const ops: PatchOp[] = missing.map((i) => ({
    entity: "material" as const,
    action: "create" as const,
    name: i.name,
    look: i.look || "",
    notes: i.notes || "",
    tempId: "NEW-" + i.id,
  }));
  const fields: ClarifyField[] | undefined = existing.length
    ? existing.map((i) => ({
      id: i.id,
      label: "Discarded duplicate of " + i.existingId + " " + (i.existingName || ""),
      value: i.existingId || "",
      materialId: i.existingId,
    }))
    : undefined;
  const discarded = existing.map((i) => i.existingId + " " + (i.existingName || "")).join(", ");
  let reply = "New materials — review the creating panel, then Save.";
  if (existing.length && !missing.length) reply = "Already in the graph (" + discarded + "). Discarded the new copies.";
  else if (existing.length) reply = "Discarded duplicates: " + discarded + ". Review the new ones, then Save.";
  return {
    taskState: { skill, phase: ops.length ? "create-missing" : "done", items },
    ops: ops.length ? ops : undefined,
    fields,
    reply,
  };
}

function parseDemandPayload(demandText: string): {
  clarify?: Record<string, string>;
  taskState?: ChatTaskState;
  skill?: string;
  items?: SkillItem[];
  lessonCount?: number;
} | null {
  const parsed = parseJsonObject<Record<string, unknown>>(demandText);
  if (!parsed) return null;
  const clarifyRaw = parsed.clarify;
  let clarify: Record<string, string> | undefined;
  if (clarifyRaw && typeof clarifyRaw === "object" && !Array.isArray(clarifyRaw)) {
    clarify = {};
    for (const [k, v] of Object.entries(clarifyRaw as Record<string, unknown>)) clarify[k] = String(v ?? "").trim();
  }
  const ts = parsed.taskState && typeof parsed.taskState === "object" ? parsed.taskState as ChatTaskState : undefined;
  const skill = isCreateWriteSkill(parsed.skill) ? parsed.skill : undefined;
  const items = parseSkillItems(parsed.items);
  return {
    clarify,
    taskState: ts,
    skill,
    items: items.length ? items : undefined,
    lessonCount: parsed.lessonCount != null ? Number(parsed.lessonCount) : undefined,
  };
}

function materialWriteOps(ops: PatchOp[] | undefined): PatchOp[] {
  return (ops || []).filter((op) => op && op.entity === "material" && (op.action === "create" || op.action === "update"));
}

function dupCheckDone(state: ChatTaskState | undefined): boolean {
  if (!state) return false;
  return state.phase === "create-missing" || state.phase === "done"
    || state.phase === "clarify" || state.phase === "date-slots" || state.phase === "kg-query";
}

export type KgQueryArgs = {
  q?: string;
  qVec?: number[];
  hitScores?: Record<string, number>;
  grade?: string;
  setId?: string;
  leapMin?: number;
  leapMax?: number;
};

export type KgHopCard = {
  id: string;
  name: string;
  look?: string;
  hopNote?: string;
  tag?: string;
};

export type KgRanked = {
  id: string;
  name: string;
  look: string;
  notes: string;
  duration: number;
  depth: number;
  leap: number;
  cluster: number;
  motorSkills: MotorSkill[];
  easier: KgHopCard[];
  harder: KgHopCard[];
  related: KgHopCard[];
};

export function kgQuery(
  args: KgQueryArgs,
  materials: Material[],
  links: Link[],
  sets: MaterialSet[] = [],
  periods: Period[] = [],
  vectors: Record<string, number[]> = {},
): { ranked: KgRanked[]; ids: string[] } {
  let pool = materials.slice();
  const q = String(args.q || "").trim();
  const qVec = args.qVec;
  const hitScores = args.hitScores || {};
  const hasVec = Object.keys(vectors).length > 0;
  const semScore = new Map<string, number>();
  if (q) {
    if (qVec?.length && hasVec) {
      for (const m of pool) {
        semScore.set(m.id, vectors[m.id]?.length ? cosine(qVec, vectors[m.id]!) : 0);
      }
      pool = pool.slice().sort((a, b) => (semScore.get(b.id) || 0) - (semScore.get(a.id) || 0));
    } else if (Object.keys(hitScores).length) {
      for (const [id, score] of Object.entries(hitScores)) semScore.set(id, Number(score) || 0);
      const hitPool = pool.filter((m) => hitScores[m.id] != null);
      pool = hitPool.length ? hitPool.sort((a, b) => (hitScores[b.id] || 0) - (hitScores[a.id] || 0)) : filterMaterials(q, pool, "");
    } else {
      const hits = new Set(filterMaterials(q, pool, "").map((m) => m.id));
      pool = pool.filter((m) => hits.has(m.id));
    }
  }
  if (args.grade && args.grade !== "all" && GRADE_TOKEN.test(args.grade)) {
    const used = new Set<string>();
    for (const p of periods.filter((x) => x.grade === args.grade)) {
      for (const a of p.activities || []) used.add(a.id);
    }
    if (used.size) pool = pool.filter((m) => used.has(m.id));
  }
  if (args.setId) {
    const set = sets.find((s) => s.id === args.setId);
    const members = new Set(set?.members || []);
    pool = pool.filter((m) => members.has(m.id));
  }
  const leapOf = (id: string) => {
    const n = neighborsOf(id, links);
    const hops = [...n.regression, ...n.progression];
    if (!hops.length) return 1;
    return hops.reduce((s, h) => s + hopLeap(h), 0) / hops.length;
  };
  if (args.leapMin != null && Number.isFinite(args.leapMin)) {
    pool = pool.filter((m) => leapOf(m.id) >= args.leapMin!);
  }
  if (args.leapMax != null && Number.isFinite(args.leapMax)) {
    pool = pool.filter((m) => leapOf(m.id) <= args.leapMax!);
  }
  const roots = pool.filter((m) => !neighborsOf(m.id, links).regression.length);
  const depth = new Map<string, number>();
  const qIds = roots.length ? roots.map((m) => m.id) : pool.map((m) => m.id);
  for (const id of qIds) {
    if (!depth.has(id)) depth.set(id, 0);
  }
  const queue = [...qIds];
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!;
    const d = depth.get(v) || 0;
    for (const u of chainHarderOf(v, links)) {
      if (!pool.some((m) => m.id === u)) continue;
      if (depth.has(u)) continue;
      depth.set(u, d + 1);
      queue.push(u);
    }
  }
  const clusters = clusterByTimeAndContent(
    pool.map((m) => ({ id: m.id, duration: m.duration })),
    vectors,
    3,
  );
  const byId = new Map(materials.map((m) => [m.id, m]));
  const hopCards = (id: string): { easier: KgHopCard[]; harder: KgHopCard[]; related: KgHopCard[] } => {
    const n = neighborsOf(id, links);
    const cap = 4;
    const withLook = (hops: { id: string; note: string }[]): KgHopCard[] =>
      hops.slice(0, cap).map((h) => {
        const card = byId.get(h.id);
        return {
          id: h.id,
          name: card?.name || h.id,
          look: (card?.look || "").slice(0, 240),
          hopNote: h.note || "",
        };
      });
    const related = n.related.slice(0, cap).map((h) => {
        const card = byId.get(h.id);
        const row: KgHopCard = {
          id: h.id,
          name: card?.name || h.id,
          look: (card?.look || "").slice(0, 240),
        };
        if (h.tag) row.tag = h.tag;
        return row;
      });
    return { easier: withLook(n.regression), harder: withLook(n.progression), related };
  };
  const ranked: KgRanked[] = pool.map((m) => ({
    id: m.id,
    name: m.name,
    look: m.look,
    notes: m.notes || "",
    duration: m.duration || 20,
    depth: depth.get(m.id) ?? 0,
    leap: leapOf(m.id),
    cluster: clusters.get(m.id) ?? 0,
    motorSkills: m.motorSkills || [],
    ...hopCards(m.id),
  }));
  ranked.sort((a, b) => (semScore.get(b.id) || 0) - (semScore.get(a.id) || 0) || a.depth - b.depth || a.leap - b.leap || a.duration - b.duration || a.id.localeCompare(b.id));
  return { ranked: ranked.slice(0, 24), ids: ranked.slice(0, 24).map((r) => r.id) };
}

function compactKgRows(rows: KgRanked[]) {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    look: (r.look || "").slice(0, 240),
    notes: (r.notes || "").slice(0, 360),
    duration: r.duration,
    depth: r.depth,
    leap: r.leap,
    cluster: r.cluster,
    motorSkills: r.motorSkills || [],
    easier: r.easier,
    harder: r.harder,
    related: r.related,
  }));
}

export function buildUserMessage(input: {
  foci: Foci;
  materials: Material[];
  links: Link[];
  period: Period;
  previous: Period | null;
  mode?: string;
  goal?: string;
}): string {
  return JSON.stringify(
    {
      foci: input.foci,
      materials: compactMaterials(input.materials),
      links: compactLinks(input.links),
      thisPeriod: compactPeriod(input.period),
      previousPeriod: compactPeriod(input.previous),
      mode: input.mode === "goal" ? "goal" : "last",
      goal: String(input.goal || "").trim(),
    },
    null,
    2,
  );
}

type ModelJson = {
  focus?: number;
  summary?: string;
  reply?: string;
  picks?: { id?: string; why?: string; start?: string; end?: string; date?: string; grade?: string }[];
  days?: { date?: string; grade?: string; picks?: ModelJson["picks"]; objective?: string }[];
  objective?: string;
  ops?: PatchOp[];
  fields?: { id?: string; label?: string; value?: string }[];
  periodTarget?: Suggestion["periodTarget"];
  ranked?: Suggestion["ranked"];
  instant?: { id?: string; why?: string; start?: string; end?: string };
  skill?: { id?: string; why?: string; start?: string; end?: string };
  key?: { id?: string; why?: string; start?: string; end?: string };
};

function asPick(p: { id?: string; why?: string; start?: string; end?: string; date?: string; grade?: string } | undefined) {
  if (!p?.id) return null;
  const row: Suggestion["picks"][number] = { id: p.id, why: String(p.why || "") };
  if (p.start) row.start = p.start;
  if (p.end) row.end = p.end;
  if (p.date) row.date = String(p.date);
  if (p.grade && p.grade !== "all" && GRADE_TOKEN.test(p.grade)) row.grade = p.grade;
  return row;
}

export function validateSuggestion(
  raw: ModelJson,
  materials: Material[],
  foci: Foci,
  opts?: { allowEmptyPicks?: boolean; knownIds?: Set<string>; links?: Link[] },
): Suggestion | string {
  const ids = new Set(opts?.knownIds || materials.map((m) => m.id));
  const ops = Array.isArray(raw.ops) ? raw.ops : undefined;
  if (ops) {
    for (const op of ops) {
      if (!op || typeof op !== "object" || op.entity !== "material" || op.action !== "create") continue;
      if (op.tempId) ids.add(String(op.tempId));
      if (op.id) ids.add(String(op.id));
    }
  }
  let picks = Array.isArray(raw.picks) ? raw.picks.map(asPick).filter(Boolean) as Suggestion["picks"] : [];
  let days: NonNullable<Suggestion["days"]> = [];
  if (Array.isArray(raw.days)) {
    for (const day of raw.days) {
      if (!day || typeof day !== "object" || !day.date) continue;
      const grade = day.grade && day.grade !== "all" && GRADE_TOKEN.test(day.grade) ? day.grade : undefined;
      const dayPicks = Array.isArray(day.picks) ? day.picks.map(asPick).filter(Boolean) as Suggestion["picks"] : [];
      dayPicks.forEach((row) => {
        row.date = String(day.date);
        if (grade) row.grade = grade;
      });
      days.push({ date: String(day.date), grade, picks: dayPicks, objective: day.objective != null ? String(day.objective) : undefined });
    }
    if (days.length) picks = days.flatMap((d) => d.picks.map((row) => ({ ...row, date: d.date, grade: d.grade || row.grade })));
  }
  if (!picks.length) {
    for (const legacy of [raw.instant, raw.skill, raw.key]) {
      const row = asPick(legacy);
      if (row) picks.push(row);
    }
  }
  if (!opts?.allowEmptyPicks && !picks.length) return "picks is empty";
  if (opts?.allowEmptyPicks) {
    picks = picks.filter((p) => ids.has(p.id));
    if (days.length) {
      days = days.map((d) => ({ ...d, picks: d.picks.filter((p) => ids.has(p.id)) })).filter((d) => d.picks.length);
      picks = days.flatMap((d) => d.picks.map((row) => ({ ...row, date: d.date, grade: d.grade || row.grade })));
    }
  } else {
    for (const p of picks) {
      if (!ids.has(p.id)) return `invalid or unknown id: ${p.id}`;
    }
  }
  const names: Record<string, string> = {};
  for (const m of materials) names[m.id] = m.name;
  if (ops) {
    for (const op of ops) {
      if (!op || typeof op !== "object" || op.entity !== "material" || op.action !== "create") continue;
      const tid = String(op.tempId || op.id || "");
      if (tid) names[tid] = String(op.name || tid);
    }
  }
  const working: Link[] = (opts?.links || []).slice();
  if (ops) {
    for (const op of ops) {
      if (!op || typeof op !== "object") return "invalid op";
      if (op.entity === "material" && op.action !== "create") {
        const id = String(op.id || "");
        if (id && !ids.has(id)) return "unknown material " + id;
      }
      if (op.entity === "link") {
        const from = String(op.from || "");
        const to = String(op.to || "");
        if (op.action !== "create") {
          if (from && !ids.has(from)) return "unknown id: " + from;
          if (to && !ids.has(to)) return "unknown id: " + to;
        } else {
          if (from && to && from === to) return "from and to must differ";
          const kind = op.kind === "regression" ? "regression" : op.kind === "related" ? "related" : "progression";
          if (kind === "progression" || kind === "regression") {
            const hopFrom = kind === "regression" ? to : from;
            const hopTo = kind === "regression" ? from : to;
            const err = validateProgressionHop(hopFrom, hopTo, working, names);
            if (err) return err;
            working.push({ from: hopFrom, kind: "progression", to: hopTo, note: String(op.note || "") });
          } else {
            const err = validateRelatedHop(from, to, working, names);
            if (err) return err;
            working.push({ from, kind: "related", to, note: String(op.note || ""), tag: String(op.tag || "") });
          }
        }
      }
    }
  }
  const focus = Number(raw.focus);
  const now = foci.items.find((f) => f.n === foci.now) || foci.items[0];
  const summary = String(raw.summary || raw.reply || "");
  if (!summary.trim() && !opts?.allowEmptyPicks) return "summary is empty";
  if (!opts?.allowEmptyPicks && now && !summary.includes(String(now.n)) && !summary.toLowerCase().includes(now.text.toLowerCase())) {
    return "summary must name the current focus";
  }
  if (!opts?.allowEmptyPicks && !Number.isFinite(focus)) return "focus must be a number";
  const fields = clarifyFields(raw.fields);
  const periodTarget = raw.periodTarget && typeof raw.periodTarget === "object" ? raw.periodTarget as Suggestion["periodTarget"] : undefined;
  return {
    focus: Number.isFinite(focus) ? focus : foci.now || 0,
    summary: summary || String(raw.reply || ""),
    picks,
    days: days.length ? days : undefined,
    objective: raw.objective != null && String(raw.objective).trim() ? String(raw.objective).trim() : undefined,
    reply: raw.reply ? String(raw.reply) : undefined,
    ops,
    fields: fields.length ? fields : undefined,
    periodTarget,
    ranked: raw.ranked,
    reads: {
      foci: foci.items.length,
      nodes: materials.length,
      edges: 0,
      layout: false,
      reflection: false,
    },
  };
}

let chatOnceOverride: ((user: string, opts?: { system?: string; temperature?: number; maxTokens?: number; messages?: ChatMsg[]; signal?: AbortSignal }) => Promise<string>) | null = null;

/** Test hook. Production calls the model. */
export function setChatOnceForTests(
  fn: ((user: string, opts?: { system?: string; temperature?: number; maxTokens?: number; messages?: ChatMsg[]; signal?: AbortSignal }) => Promise<string>) | null,
) {
  chatOnceOverride = fn;
}

async function chatOnce(user: string, opts?: { system?: string; temperature?: number; maxTokens?: number; messages?: ChatMsg[]; signal?: AbortSignal }): Promise<string> {
  if (chatOnceOverride) return chatOnceOverride(user, opts);
  const base = env("ANTHROPIC_BASE_URL", "https://api.minimax.cn/anthropic");
  const key = llmKey();
  const model = env("LLM_MODEL", "MiniMax-M2.7");
  if (!key) {
    const err = new Error("ANTHROPIC_API_KEY is not set") as Error & { status: number };
    err.status = 503;
    throw err;
  }
  const payload = {
    model,
    max_tokens: opts?.maxTokens ?? 2048,
    temperature: opts?.temperature ?? 0.2,
    system: opts?.system || SYSTEM_PROMPT,
    messages: opts?.messages?.length ? opts.messages : [{ role: "user" as const, content: user }],
  };
  const r = await fetch(messagesUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer " + key,
      "x-api-key": key,
    },
    body: JSON.stringify(payload),
    signal: opts?.signal,
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error("LLM " + r.status + " " + text) as Error & { status: number };
    err.status = 502;
    throw err;
  }
  return extractAnthropicText(JSON.parse(text) as { content?: string | AnthropicBlock[] });
}

export const OBJECTIVE_PROMPT = `You write the objective of the day for a Grade 6 / Grade 7 NFL FLAG PE period.

The user JSON has:
- draft: optional teacher wording already in the box
- context: pinned materials for this period (JSON)

Write two labeled blocks inside "text". Keep these English labels and a newline after each label:

user's input:
<if draft is empty: (none). Else: a concise summary of the teacher's own wording. If draft already contains these labels, use only the text under "user's input:" as the teacher wording.>

class content:
<if context has no materials: (none). Else: 2–4 short sentences naming the pinned drills from context.>

Rules:
1. Do not invent a drill, rule, or material that is not in context.
2. Do not copy class drills into user's input unless the teacher wrote them in draft.
3. Keep FLAG terms in English (snap, LOS, QB, WR, RB, Center, route names).
4. Keep the language of the draft and of material notes (do not translate).
5. Return JSON only: { "text": "<the two blocks>" }`;

export const POLISH_PROMPT = `You polish PE teacher wording for a Grade 6 / Grade 7 NFL FLAG unit.

Keep the teacher's meaning. Follow the rule that matches \`kind\` only.

Rules:
1. Keep FLAG terms in English (snap, LOS, QB, WR, RB, Center, route names).
2. Keep the language of the draft (do not translate).
3. Do not invent a new drill, rule, or hop.
4. look: freeze this game-moment — the slice of a real 5v5 down this drill still is after stripping extra players. One short phrase (~3–8 words). Isolated skills (throw, catch, pull) are ingredients, not the idea. If context JSON has "chain", first infer this drill's play-loop slice (snap → pass or handoff → run) and one aspect (ball | second action | space | opposition | numbers). Chain easier/harder is contrast only — do not copy neighbour look or name. Keep every observable cue from the draft; only shorten wording. Plain text only — no markdown, no labels like look:, no trailing period.
5. name: a short activity title for THIS slice (roles/action), not a procedure. Same chain-as-contrast as look. Do not copy neighbour name. Distinct from easier/harder titles. FLAG terms English. Keep the draft's meaning; only shorten. Plain text only — no markdown, no labels like name:, no trailing period.
6. note: hop teacher note = the drill's barebone, same job as look for **to**. If context JSON has "toLook" or "chain", freeze this drill's play-loop slice (snap → pass or handoff → run) and one aspect (ball | second action | space | opposition | numbers) from **to** only. Neighbour look is contrast only — do not copy from. Keep every observable cue from the draft and from toLook; only shorten wording. Telegraphic: one short phrase or 2–4 comma fragments (~6–12 words). Not how the drill is run. Plain text only — no markdown, no labels, no trailing period.
7. explanation: how the drill is done. 2–6 short sentences, informative for a 40-minute class. Stations, roles, the next cue. Keep line breaks if the draft has them. Not the hop-note style (not one terse line). If context JSON has "tagged", those cards are similar activities (not a copy). Combine the teacher's draft with each tagged look and explanation into one complete explanation for THIS activity. Do not invent stations or rules that appear in neither draft nor tagged cards. Keep @M… tokens from the draft in the output.
8. Return JSON only: { "text": "<polished>" }`;

export function trimPolishLook(text: string, hardMaxWords = 12): string {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(look|name):\s*/i, "");
  t = t.replace(/^["']|["']$/g, "");
  while (t.endsWith(".")) t = t.slice(0, -1).trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > hardMaxWords) t = words.slice(0, hardMaxWords).join(" ");
  return t;
}

/** Strip labels and periods only; hard-cap runaway model output without dropping comma fragments. */
export function trimPolishNote(text: string, hardMaxWords = 16): string {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^note:\s*/i, "");
  t = t.replace(/^["']|["']$/g, "");
  while (t.endsWith(".")) t = t.slice(0, -1).trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > hardMaxWords) t = words.slice(0, hardMaxWords).join(" ");
  return t;
}

/** @deprecated use trimPolishLook or trimPolishNote */
export function trimPolishPhrase(text: string, maxWords = 10): string {
  return trimPolishNote(text, maxWords);
}

export async function polish(input: { kind?: string; text?: string; context?: string }): Promise<{ text: string }> {
  const kind = input.kind === "look" ? "look"
    : input.kind === "name" ? "name"
    : input.kind === "objective" ? "objective"
    : input.kind === "explanation" ? "explanation"
    : "note";
  const draft = String(input.text || "").trim();
  const context = String(input.context || "").trim();
  if (kind !== "objective" && !draft) {
    const tagged = kind === "explanation" && /"tagged"\s*:/.test(context);
    if (!tagged) {
      const err = new Error("text is required") as Error & { status: number };
      err.status = 400;
      throw err;
    }
  }
  if (kind === "objective" && !draft && !context) {
    const err = new Error("context is required") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const user = JSON.stringify({
    kind,
    draft: draft || undefined,
    context: context || undefined,
    ...(kind === "note"
      ? { preserve: "Every observable cue in draft and toLook must remain; compress words only. Do not copy from." }
      : kind === "look"
        ? { preserve: "Freeze this game-moment (5v5 slice), not a skill list. Every observable cue in draft must remain; compress words only. Do not copy neighbour look or name." }
        : kind === "name"
          ? { preserve: "Title this slice only; do not copy neighbour name; compress words only." }
        : kind === "explanation"
          ? { preserve: "If tagged similar cards are in context, combine their look and explanation with the draft into one complete explanation; keep @M tokens." }
          : {}),
  });
  const system = kind === "objective" ? OBJECTIVE_PROMPT : POLISH_PROMPT;
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    lastRaw = await chatOnce(user, { system, temperature: 0.2, maxTokens: 2048 });
    const parsed = parseJsonObject<{ text?: string }>(lastRaw);
    const rawText = String(parsed?.text || "");
    const cleaned = rawText.replace(/\s+/g, " ").trim();
    const text = (kind === "objective" || kind === "explanation")
      ? rawText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
      : kind === "look"
        ? trimPolishLook(cleaned)
        : kind === "name"
          ? trimPolishLook(cleaned, 12)
        : trimPolishNote(cleaned);
    if (text) return { text };
  }
  const err = new Error(lastRaw || "model returned unusable JSON") as Error & { status: number };
  err.status = 422;
  throw err;
}

export async function suggest(
  base: string,
  periodId: string,
  opts?: { mode?: string; goal?: string; demand?: string; paste?: string; history?: ChatMsg[]; onStatus?: (s: ChatStatusEvent) => void; signal?: AbortSignal; lookupCache?: LookupCache; taskState?: ChatTaskState },
): Promise<Suggestion> {
  const { getFoci, getPeriod } = await import("./store.ts");
  const foci = getFoci(base);
  const materials = listMaterials(base);
  const links = listLinks(base);
  const sets = listSets(base);
  if (opts?.mode === "chat") {
    return chatSuggest(base, { foci, materials, links, sets, periodId, demand: opts.demand, paste: opts.paste, history: opts.history, onStatus: opts.onStatus, signal: opts.signal, lookupCache: opts.lookupCache, taskState: opts.taskState });
  }
  const period = getPeriod(base, periodId);
  if (!period) {
    const err = new Error("unknown period " + periodId) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const prevList = listPeriods(base, period.grade).filter((p) => p.date < period.date);
  const previous = prevList[prevList.length - 1] || null;
  const user = buildUserMessage({
    foci,
    materials,
    links,
    period,
    previous,
    mode: opts?.mode,
    goal: opts?.goal,
  });

  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    lastRaw = await chatOnce(user, { maxTokens: 2048 });
    const parsed = parseJsonObject<ModelJson>(lastRaw);
    if (!parsed) continue;
    const result = validateSuggestion(parsed, materials, foci, { links });
    if (typeof result !== "string") {
      result.reads = {
        foci: foci.items.length,
        nodes: materials.length,
        edges: links.length,
        layout: !!(period.activities && period.activities.length),
        reflection: !!(period.reflection?.text || period.reflection?.flags?.length),
      };
      return result;
    }
  }
  const err = new Error(lastRaw || "model returned unusable JSON") as Error & { status: number; body?: string };
  err.status = 422;
  throw err;
}

async function chatSuggest(
  base: string,
  input: {
    foci: Foci;
    materials: Material[];
    links: Link[];
    sets: MaterialSet[];
    periodId?: string;
    demand?: string;
    paste?: string;
    history?: ChatMsg[];
    onStatus?: (s: ChatStatusEvent) => void;
    signal?: AbortSignal;
    lookupCache?: LookupCache;
    taskState?: ChatTaskState;
  },
): Promise<Suggestion> {
  const throwIfAborted = () => {
    if (!input.signal?.aborted) return;
    const err = new Error("Chat stopped") as Error & { status: number; name: string };
    err.status = 499;
    err.name = "AbortError";
    throw err;
  };
  const { getPeriod, getCalendar } = await import("./store.ts");
  const period = input.periodId ? getPeriod(base, input.periodId) : null;
  let known = new Set(input.materials.map((m) => m.id));
  const vectors: Record<string, number[]> = {};
  try {
    const cachePath = path.join(base, "library", "_embeddings.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { items?: Record<string, { vector?: number[] }> };
    for (const [id, row] of Object.entries(cache.items || {})) {
      if (row.vector?.length) vectors[id] = row.vector;
    }
  } catch {
    /* no embeddings */
  }
  const cal = getCalendar(base);
  const roster = Object.keys(cal.classDays || { G6: [], G7: [] });
  const grades = roster.length ? roster : ["G6", "G7"];
  const periodIndex = compactPeriodIndex(grades.flatMap((g) => listPeriods(base, g)));
  const arrangement = cal.classDays || { G6: [], G7: [] };
  const periods = grades.flatMap((g) => listPeriods(base, g));
  const demandText = String(input.demand || "").trim();
  const payload = parseDemandPayload(demandText);
  // handle_user_message: first skill call. Duplicate hits are discarded; no keep/overwrite round.
  let taskState: ChatTaskState | undefined = payload?.taskState || input.taskState;
  const lessonCount = payload?.lessonCount || lessonCountFromDemand(demandText);
  const multiLesson = lessonCount >= 2;
  const now = new Date();
  const todayIso = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const gradeDefault = (period && period.grade !== "all" && GRADE_TOKEN.test(period.grade))
    ? period.grade
    : (grades[0] || "G6");
  const afterDefault = (period && period.date) || todayIso;
  const user = JSON.stringify({
    demand: demandText,
    paste: String(input.paste || "").trim() || undefined,
    lessonCount: lessonCount || undefined,
    multiLesson: multiLesson || undefined,
    thisPeriod: multiLesson ? null : compactPeriod(period),
    arrangement,
    periodIndex,
    foci: input.foci,
    taskState: taskState || undefined,
  });
  const messages: ChatMsg[] = [...llmHistoryWindow(input.history || []), { role: "user", content: user }];
  let queried = false;
  let lastRows: KgRanked[] = [];
  let lastSlots: DateSlotRow[] = [];
  let lastRaw = "";
  let lastValidateErr = "";
  let fromCache = false;
  let pendingOps: PatchOp[] = [];
  const cacheGrade = input.lookupCache?.grade || gradeDefault;
  if (lookupCacheMatches(input.lookupCache, demandText, cacheGrade)) {
    fromCache = true;
    lastSlots = input.lookupCache!.dateSlots || [];
    const kg = input.lookupCache!.kg || [];
    if (kg.length) {
      queried = true;
      for (const row of kg) if (row.id) known.add(row.id);
    }
    if (lastSlots.length) messages.push({ role: "user", content: JSON.stringify({ DateSlots: lastSlots }) });
    if (kg.length) messages.push({ role: "user", content: JSON.stringify({ KGQuery: kg }) });
    messages.push({ role: "user", content: "Lookup already done. Return final JSON only: { reply, picks, days, ops }. Put DateSlots dates on days[]. Do not call DateSlots or KGQuery again." });
  }
  const slotInput = {
    classDays: arrangement,
    entries: cal.entries || [],
    periods,
    grade: gradeDefault,
    after: afterDefault,
    count: Math.max(lessonCount || 1, 1),
  };
  const reads = () => ({
    foci: input.foci.items.length,
    nodes: input.materials.length,
    edges: input.links.length,
    layout: !!(period?.activities?.length),
    reflection: !!(period?.reflection?.text || period?.reflection?.flags?.length),
    fromCache,
  });
  const stampLookup = (result: Suggestion) => {
    const kg = lastRows.length ? compactKgRows(lastRows) : (fromCache ? input.lookupCache?.kg : undefined);
    const slots = lastSlots.length ? lastSlots : (fromCache ? input.lookupCache?.dateSlots : undefined);
    if ((slots && slots.length) || (kg && kg.length)) {
      result.lookupCache = {
        demand: demandText,
        grade: gradeDefault,
        dateSlots: slots,
        kg,
        nodes: input.materials.length,
        edges: input.links.length,
      };
    }
    if (taskState) result.taskState = taskState;
    result.reads = reads();
    return result;
  };
  const finishClarify = (parsed: Record<string, unknown>): Suggestion => {
    const fields = clarifyFields(parsed.fields);
    const reply = String(parsed.reply || "Fill in the fields, then Continue.");
    return stampLookup({
      focus: input.foci.now || 0,
      summary: reply,
      reply,
      picks: [],
      fields,
      taskState,
      periodTarget: parsed.periodTarget && typeof parsed.periodTarget === "object" ? parsed.periodTarget as Suggestion["periodTarget"] : undefined,
      reads: reads(),
    });
  };
  let activeSkill: ChatStatusEvent["skill"];
  let exploreInjected = false;
  let exploreAwaitingClarify = false;
  const emitStatus = (status: ChatLlmStatus, tool?: ChatStatusEvent["tool"]) => {
    input.onStatus?.({ status, skill: activeSkill, tool });
  };
  const runCreateSkill = async (skill: ChatTaskState["skill"], items: SkillItem[]) => {
    if (items.some((i) => !String(i.look || "").trim() || !String(i.notes || "").trim())) return "bounce" as const;
    activeSkill = skill;
    emitStatus("looking-up");
    const topHits: { id: string; name: string; score: number }[][] = [];
    for (const item of items) {
      const q = [item.name, item.look, item.notes].filter(Boolean).join(" ");
      try {
        const search = await searchMaterials(base, q, 5);
        topHits.push((search.hits || []).map((h) => ({ id: h.id, name: h.name, score: h.score })));
      } catch {
        topHits.push([]);
      }
    }
    const checked = dupCheckItems(items, input.materials, vectors, undefined, topHits);
    return createMaterialsFromDupCheck(checked, skill);
  };
  const pauseOrContinueWrite = (pause: ReturnType<typeof createMaterialsFromDupCheck>, lastSkillRaw: string): Suggestion | "continue" => {
    taskState = pause.taskState;
    for (const i of pause.taskState.items) {
      if (i.existingId) known.add(i.existingId);
    }
    if (pause.taskState.skill === "create-materials") {
      emitStatus("organising");
      return stampLookup({
        focus: input.foci.now || 0,
        summary: pause.reply,
        reply: pause.reply,
        picks: [],
        ops: pause.ops,
        fields: pause.fields,
        taskState: pause.taskState,
        reads: reads(),
      });
    }
    pendingOps = pause.ops || [];
    for (const op of pendingOps) {
      if (op.tempId) known.add(String(op.tempId));
      if (op.id) known.add(String(op.id));
    }
    taskState = { ...pause.taskState, phase: "clarify" };
    messages.push({ role: "assistant", content: lastSkillRaw });
    messages.push({ role: "user", content: JSON.stringify({ createMaterials: pause, taskState }) });
    messages.push({ role: "user", content: "Materials resolved. Duplicates were discarded. Clarify grade if needed, else DateSlots then KGQuery, then days[]. Include any create ops already drafted. Do not call create-materials again." });
    return "continue";
  };
  emitStatus(fromCache ? "putting-together" : "understanding");
  for (let round = 0; round < 5; round++) {
    throwIfAborted();
    lastRaw = await chatOnce(user, { system: CHAT_PROMPT, messages, maxTokens: 4096, signal: input.signal });
    const queryBatch = extractChatQueryBatch(lastRaw);
    const parsed = extractChatAction(lastRaw);
    if (!parsed && !queryBatch.length) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: "That was not usable. Return {\"skill\":\"create-materials\"|\"write-lesson-in-schedule\"|\"explore-the-progression\"}, {\"tool\":\"DateSlots\"|\"KGQuery\"|\"Clarify\"}, or final JSON { reply, picks, days, ops }." });
      continue;
    }
    if (parsed && isExploreSkill(parsed.skill)) {
      const from = String(parsed.from || "").trim();
      if (!from) {
        emitStatus("organising", "Clarify");
        return stampLookup({
          focus: input.foci.now || 0,
          summary: "Name the drill (an M-id or name) in from.",
          reply: "Name the drill (an M-id or name) in from.",
          picks: [],
          ops: [],
        });
      }
      activeSkill = "explore-the-progression";
      if (exploreInjected) {
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "Hops are already in KGQuery. Name the game-moment, propose one extra, then Clarify. Empty ops. Do not call create-materials on this turn." });
        continue;
      }
      emitStatus("looking-up", "KGQuery");
      let hitScores: Record<string, number> | undefined;
      try {
        const search = await searchMaterials(base, from, 24);
        hitScores = {};
        for (const h of search.hits) hitScores[h.id] = h.score;
      } catch {
        hitScores = undefined;
      }
      const hops = kgQuery({ q: from, hitScores }, input.materials, input.links, input.sets, periods, vectors);
      for (const id of hops.ids) known.add(id);
      lastRows = hops.ranked;
      queried = true;
      exploreInjected = true;
      exploreAwaitingClarify = true;
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: JSON.stringify({ KGQuery: compactKgRows(hops.ranked), from }) });
      messages.push({
        role: "user",
        content: EXPLORE_SKILL + "\n\nHops are in KGQuery. Name the game-moment, propose one extra, then Clarify. Empty ops. Do not call create-materials on this turn.",
      });
      continue;
    }
    if (parsed && isCreateWriteSkill(parsed.skill)) {
      if (exploreAwaitingClarify) {
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "Clarify first. Do not call create-materials on this turn. Empty ops." });
        continue;
      }
      const items = parseSkillItems(parsed.items);
      if (!items.length) {
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "Skill items was empty. Return {\"skill\":\"create-materials\",\"items\":[{ \"name\": \"...\", \"look\": \"...\", \"notes\": \"...\" }]}." });
        continue;
      }
      activeSkill = parsed.skill;
      const filled = await runCreateSkill(parsed.skill, items);
      if (filled === "bounce") {
        emitStatus("putting-together");
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "Fill look (What to look for) and notes (Explanation) on every item, then call the skill again." });
        continue;
      }
      const next = pauseOrContinueWrite(filled, lastRaw);
      if (next === "continue") continue;
      return next;
    }
    if (parsed && (parsed.tool === "Clarify" || (Array.isArray(parsed.fields) && parsed.fields.length && parsed.tool !== "KGQuery" && parsed.tool !== "KGPatch" && parsed.tool !== "DateSlots"))) {
      exploreAwaitingClarify = false;
      emitStatus("organising", "Clarify");
      return finishClarify(parsed);
    }
    if (exploreAwaitingClarify) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: "Hops are in KGQuery. Name the game-moment, propose one extra, then Clarify. Empty ops. Do not call create-materials on this turn." });
      continue;
    }
    if (parsed?.tool === "DateSlots") {
      emitStatus("looking-up", "DateSlots");
      const args = (parsed.args && typeof parsed.args === "object" ? parsed.args : parsed) as { grade?: string; count?: number; after?: string };
      lastSlots = runDateSlots(args, slotInput);
      if (taskState) taskState = { ...taskState, phase: "date-slots" };
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: JSON.stringify({ DateSlots: lastSlots }) });
      messages.push({ role: "user", content: lastSlots.length
        ? "Use these dates on days[] (one lesson per date). KGQuery next if you still need graph rows, else return final JSON { reply, picks, days, ops }."
        : "No class days in arrangement for that grade. Clarify grade or arrangement." });
      continue;
    }
    if (queryBatch.length || parsed?.tool === "KGQuery") {
      emitStatus("looking-up", "KGQuery");
      const queries = queryBatch.length ? queryBatch : [((parsed!.args || {}) as KgQueryArgs)];
      const mergedRanked: KgRanked[] = [];
      const seenRank = new Set<string>();
      for (const args of queries) {
        let hitScores: Record<string, number> | undefined;
        const q = String(args.q || "").trim();
        if (q) {
          try {
            const search = await searchMaterials(base, q, 24);
            hitScores = {};
            for (const h of search.hits) hitScores[h.id] = h.score;
          } catch {
            hitScores = undefined;
          }
        }
        const result = kgQuery({ ...args, hitScores }, input.materials, input.links, input.sets, periods, vectors);
        for (const id of result.ids) known.add(id);
        for (const row of result.ranked) {
          if (seenRank.has(row.id)) continue;
          seenRank.add(row.id);
          mergedRanked.push(row);
        }
      }
      if (taskState) taskState = { ...taskState, phase: "kg-query" };
      lastRows = mergedRanked;
      queried = true;
      const compact = compactKgRows(mergedRanked);
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: JSON.stringify({ KGQuery: compact }) });
      const lessonHint = multiLesson
        ? ` Demand lists ${lessonCount} lessons — return days[] with one 40-minute pick stack per lesson (max 5). Do not merge every lesson into a single picks list.`
        : " Use days[] when the demand names multiple dates (max 5).";
      messages.push({ role: "user", content: "Stop KGQuery. Return final JSON only: { reply, picks, days, ops }." + lessonHint });
      continue;
    }
    if (parsed?.tool === "KGPatch") {
      if (!queried) {
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "KGQuery first, then KGPatch." });
        continue;
      }
      const ops = coerceOps(parsed.ops) as PatchOp[];
      if (!ops.length) {
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: "KGPatch ops was empty. Return {\"tool\":\"KGPatch\",\"ops\":[...]} with filled material and link drafts." });
        continue;
      }
      const blocked = materialWriteOps(ops).length && !dupCheckDone(taskState)
        ? "Call create-materials (or write-lesson-in-schedule) before create/update ops. The server must run the duplicate check."
        : "";
      if (blocked) {
        lastValidateErr = blocked;
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: blocked });
        continue;
      }
      emitStatus("putting-together", "KGPatch");
      emitStatus("organising", "KGPatch");
      const merged = pendingOps.concat(ops);
      const final: ModelJson = {
        reply: String(parsed.reply || "Draft ready — review and Save."),
        picks: Array.isArray(parsed.picks) ? parsed.picks as ModelJson["picks"] : [],
        days: Array.isArray(parsed.days) ? parsed.days as ModelJson["days"] : undefined,
        objective: parsed.objective != null ? String(parsed.objective) : undefined,
        periodTarget: parsed.periodTarget as ModelJson["periodTarget"],
        ops: merged,
      };
      const result = validateSuggestion(final, input.materials, input.foci, { allowEmptyPicks: true, knownIds: known, links: input.links });
      if (typeof result === "string") {
        lastValidateErr = result;
        messages.push({ role: "assistant", content: lastRaw });
        messages.push({ role: "user", content: result });
        continue;
      }
      result.reads = reads();
      return stampLookup(result);
    }
    if (queried) emitStatus("putting-together");
    emitStatus("organising");
    const coerced = parsed.ops ? coerceOps(parsed.ops) : [];
    const blockedFinal = materialWriteOps(coerced).length && !dupCheckDone(taskState)
      ? "Call create-materials (or write-lesson-in-schedule) before create/update ops. The server must run the duplicate check."
      : "";
    if (blockedFinal) {
      lastValidateErr = blockedFinal;
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: blockedFinal });
      continue;
    }
    const result = validateSuggestion(
      (parsed.ops || pendingOps.length) ? { ...parsed, ops: pendingOps.concat(coerced) } as ModelJson : parsed as ModelJson,
      input.materials,
      input.foci,
      { allowEmptyPicks: true, knownIds: known, links: input.links },
    );
    if (typeof result === "string") lastValidateErr = result;
    if (typeof result !== "string" && parsed && isChatFinal(parsed)) {
      if (!result.reply && result.summary) result.reply = result.summary;
      if (!result.ranked && lastRows.length) {
        result.ranked = lastRows.map((r) => ({ id: r.id, depth: r.depth, leap: r.leap, duration: r.duration, cluster: r.cluster }));
      }
      stampLookup(result);
      return result;
    }
    messages.push({ role: "assistant", content: lastRaw });
    messages.push({
      role: "user",
      content: typeof result === "string" ? result : "Stop KGQuery. Return final JSON only: { reply, picks, ops }.",
    });
  }
  const failMsg = chatFailMessage(lastRaw, lastValidateErr);
  const err = new Error(failMsg) as Error & { status: number };
  err.status = 422;
  throw err;
}

function resolveId(raw: unknown, ids: Record<string, string>): string {
  const s = String(raw || "");
  return ids[s] || s;
}

/**
 * The old id stays, the name becomes the new name, and links and other fields are the union.
 */
export function applyMergeMaterial(
  base: string,
  keepRaw: string,
  dropRaw: string,
  ids: Record<string, string>,
  draft?: Record<string, unknown>,
) {
  const keep = resolveId(keepRaw, ids);
  const drop = resolveId(dropRaw, ids);
  if (!keep) throw new Error("merge needs a keep id");
  if (drop && keep === drop) throw new Error("merge needs distinct keep and drop ids");
  const mats = listMaterials(base);
  const keepM = mats.find((m) => m.id === keep);
  if (!keepM) throw new Error("merge ids must exist");
  const dropM = drop ? mats.find((m) => m.id === drop) : undefined;
  const draftName = String(draft?.name || "").trim();
  const draftLook = String(draft?.look || "");
  const draftNotes = String(draft?.notes || "");
  if (!dropM && !draftName && !draftLook.trim() && !draftNotes.trim()) throw new Error("merge ids must exist");
  if (dropM) {
    const links = listLinks(base);
    if (variationPair(keep, drop, links)) throw new Error("refuse variation: keep and drop are variation-tagged");
    if (chainConnected(keep, drop, links)) throw new Error("refuse chain: keep and drop sit on a progression path");
  }
  const newName = (dropM?.name || draftName || keepM.name).trim();
  const newLook = dropM ? dropM.look || "" : draftLook;
  const newNotes = dropM ? dropM.notes || "" : draftNotes;
  const joinText = (older: string, newer: string) => {
    const a = (older || "").trim();
    const b = (newer || "").trim();
    if (a && b) return a + "\n" + b;
    return a || b;
  };
  const unionList = (older: string[] = [], newer: string[] = []) => {
    const out = older.slice();
    for (const item of newer) if (item && !out.includes(item)) out.push(item);
    return out;
  };
  const newMotors = dropM ? dropM.motorSkills : parseMotorSkills(draft?.motorSkills, "drop");
  const newComps = dropM ? dropM.skillRelatedComponents : parseSkillRelatedComponents(draft?.skillRelatedComponents, "drop");
  const newNotesList = dropM ? dropM.classNotes || [] : [];
  const classNotes = (keepM.classNotes || []).slice();
  for (const note of newNotesList) {
    if (!classNotes.some((n) => n.date === note.date && n.grade === note.grade && n.text === note.text)) classNotes.push(note);
  }
  const duration = dropM ? dropM.duration : typeof draft?.duration === "number" ? draft.duration : keepM.duration;
  const sketch = (dropM?.sketch || (draft?.sketch ? String(draft.sketch) : "")) || keepM.sketch || "";
  updateMaterial(base, keep, {
    name: newName,
    look: joinText(keepM.look || "", newLook),
    notes: joinText(keepM.notes || "", newNotes),
    duration,
    motorSkills: unionList(keepM.motorSkills, newMotors),
    skillRelatedComponents: unionList(keepM.skillRelatedComponents, newComps),
    classNotes,
    sketch,
  });
  if (!dropM) return;
  for (const set of listSets(base)) {
    if (!set.members.includes(drop)) continue;
    const members = set.members.includes(keep)
      ? set.members.filter((id) => id !== drop)
      : set.members.map((id) => (id === drop ? keep : id));
    updateSet(base, set.id, { members });
  }
  const roster = Object.keys(getCalendar(base).classDays || { G6: [], G7: [] });
  for (const grade of (roster.length ? roster : ["G6", "G7"])) {
    for (const p of listPeriods(base, grade)) {
      let dirty = false;
      const rewrite = (id: string) => {
        if (id !== drop) return id;
        dirty = true;
        return keep;
      };
      const activities = (p.activities || []).map((a) => ({
        ...a,
        id: rewrite(a.id),
        easier: (a.easier || []).map(rewrite),
        harder: (a.harder || []).map(rewrite),
        alts: (a.alts || []).map(rewrite),
      }));
      if (dirty) savePeriod(base, p.id, { ...p, activities });
    }
  }
  for (const L of listLinks(base).filter((row) => row.from === drop || row.to === drop)) {
    try {
      deleteLink(base, L.from, L.kind, L.to);
    } catch {
      /* already gone */
    }
    const from = L.from === drop ? keep : L.from;
    const to = L.to === drop ? keep : L.to;
    if (from === to) continue;
    try {
      createLink(base, { from, kind: L.kind, to, note: L.note || "", tag: L.tag, leap: L.leap });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409) throw err;
    }
  }
  deleteMaterial(base, drop);
}

function dropChain(base: string, from: string, to: string) {
  try {
    deleteLink(base, from, "progression", to);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }
}

function putChain(base: string, from: string, to: string, note: string, leap?: number, nudgeCount?: number) {
  try {
    createLink(base, { from, kind: "progression", to, note, leap, nudgeCount });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 409) throw err;
  }
}

/**
 * A new harder node stores the caller's combined idea. Every source stays, and each one progresses to the new node.
 */
export function applyCompositeMerge(base: string, sourcesRaw: string[], ids: Record<string, string>, name?: string, look?: string, notes?: string) {
  const sources = [...new Set(sourcesRaw.map((id) => resolveId(id, ids)).filter(Boolean))];
  if (sources.length < 2) throw new Error("merge needs at least two sources");
  const mats = listMaterials(base);
  const sourceMats = sources.map((id) => {
    const found = mats.find((m) => m.id === id);
    if (!found) throw new Error("merge ids must exist");
    return found;
  });
  const sourceIds = new Set(sources);
  const unionList = (lists: string[][]) => {
    const out: string[] = [];
    for (const list of lists) for (const item of list) if (item && !out.includes(item)) out.push(item);
    return out;
  };
  const classNotes: ClassNote[] = [];
  for (const mat of sourceMats) {
    for (const note of mat.classNotes || []) {
      if (!classNotes.some((row) => row.date === note.date && row.grade === note.grade && row.text === note.text)) classNotes.push(note);
    }
  }
  const migratedName = (name || "").trim();
  const migratedLook = (look || "").trim();
  const migratedNotes = (notes || "").trim();
  if (!migratedName || !migratedLook || !migratedNotes) throw new Error("merge needs a name, look, and notes");
  const sourceLooks = sourceMats.map((m) => (m.look || "").trim()).filter(Boolean);
  const sourceNotes = sourceMats.map((m) => (m.notes || "").trim()).filter(Boolean);
  const joinText = (parts: string[]) => {
    const out: string[] = [];
    for (const part of parts) if (part && !out.includes(part)) out.push(part);
    return out.join("\n");
  };
  const joinedLooks = joinText(sourceLooks);
  const joinedNotes = joinText(sourceNotes);
  const blocks: string[] = [];
  for (const sourceLook of sourceLooks) if (sourceLook.length >= 40) blocks.push(sourceLook);
  for (const sourceNote of sourceNotes) {
    for (const para of sourceNote.split(/\n\n+/)) {
      const block = para.trim();
      if (block.length >= 40) blocks.push(block);
    }
  }
  const copiesSource = (field: string) =>
    sourceLooks.includes(field) || sourceNotes.includes(field)
    || (!!joinedLooks && field === joinedLooks)
    || (!!joinedNotes && field === joinedNotes)
    || blocks.some((block) => field.includes(block));
  if (copiesSource(migratedLook) || copiesSource(migratedNotes)) throw new Error("merge needs a rewritten idea, not a pasted source");
  const durations = sourceMats.map((m) => (typeof m.duration === "number" ? m.duration : 0));
  const duration = Math.max(...durations, 0) || undefined;
  const sketch = sourceMats.map((m) => (m.sketch || "").trim()).find(Boolean) || "";
  const created = createMaterial(base, {
    name: migratedName,
    look: migratedLook,
    notes: migratedNotes,
    duration,
    motorSkills: unionList(sourceMats.map((m) => m.motorSkills || [])),
    skillRelatedComponents: unionList(sourceMats.map((m) => m.skillRelatedComponents || [])),
    sketch: sketch || undefined,
  });
  if (classNotes.length) updateMaterial(base, created.id, { classNotes });
  for (const set of listSets(base)) {
    if (!set.members.some((id) => sourceIds.has(id)) || set.members.includes(created.id)) continue;
    updateSet(base, set.id, { members: [...set.members, created.id] });
  }
  const links = listLinks(base);
  const seen = new Set<string>();
  const incoming: Link[] = [];
  const outgoing: Link[] = [];
  for (const L of links) {
    if (L.kind !== "progression" && L.kind !== "regression") continue;
    const key = L.from + "\0" + L.to;
    if (seen.has(key)) continue;
    seen.add(key);
    const fromIn = sourceIds.has(L.from);
    const toIn = sourceIds.has(L.to);
    if (fromIn && toIn) dropChain(base, L.from, L.to);
    else if (toIn) {
      dropChain(base, L.from, L.to);
      incoming.push(L);
    } else if (fromIn) {
      dropChain(base, L.from, L.to);
      outgoing.push(L);
    }
  }
  for (const L of incoming) putChain(base, L.from, created.id, L.note || "", L.leap, L.nudgeCount);
  for (const L of outgoing) putChain(base, created.id, L.to, L.note || "", L.leap, L.nudgeCount);
  for (const L of links) {
    if (L.kind !== "related") continue;
    const tag = String(L.tag || "");
    if (!tag.toLowerCase().startsWith("variation to") || !sourceIds.has(L.to) || sourceIds.has(L.from)) continue;
    try {
      deleteLink(base, L.from, "related", L.to);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err;
    }
    try {
      createLink(base, { from: L.from, kind: "related", to: created.id, note: L.note || "", tag });
    } catch {
      try {
        createLink(base, { from: L.from, kind: "related", to: L.to, note: L.note || "", tag });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 409) throw err;
      }
    }
  }
  for (const src of sourceMats) putChain(base, src.id, created.id, src.look || "");
  ids[created.name] = created.id;
  ids[created.id] = created.id;
  return created;
}

export function applyKgOps(base: string, ops: PatchOp[]): {
  applied: number;
  errors: string[];
  ids: Record<string, string>;
  created: { nodes: number; links: number };
} {
  const ids: Record<string, string> = {};
  const errors: string[] = [];
  const created = { nodes: 0, links: 0 };
  beginBatch(base);
  try {
  const list = (Array.isArray(ops) ? ops.slice() : []).map((op) => normalizePatchOp(op) || op);
  const order = (op: PatchOp) => {
    if (op.entity === "material") {
      if (op.action === "create") return 0;
      if (op.action === "update") return 1;
      if (op.action === "de_dup" || op.action === "merge") return 2;
      return 3;
    }
    if (op.entity === "link") return 4;
    return 5;
  };
  list.sort((a, b) => order(a) - order(b));
  let applied = 0;
  const sketches: { id: string; sketch: string }[] = [];
  for (const op of list) {
    try {
      if (op.entity === "material") {
        if (op.action === "create") {
          const mat = createMaterial(base, {
            name: String(op.name || "").trim(),
            look: String(op.look || ""),
            notes: String(op.notes || ""),
            duration: typeof op.duration === "number" ? op.duration : undefined,
            motorSkills: parseMotorSkills(op.motorSkills, "drop"),
            skillRelatedComponents: parseSkillRelatedComponents(op.skillRelatedComponents, "drop"),
          });
          if (op.tempId) ids[String(op.tempId)] = mat.id;
          ids[mat.name] = mat.id;
          if (op.sketch) sketches.push({ id: mat.id, sketch: String(op.sketch) });
          const setIds = Array.isArray(op.setIds) ? op.setIds.map(String) : [];
          if (setIds.length) {
            for (const sid of setIds) {
              const set = listSets(base).find((s) => s.id === sid || s.name === sid);
              if (!set || set.members.includes(mat.id)) continue;
              updateSet(base, set.id, { members: [...set.members, mat.id] });
            }
          }
          created.nodes += 1;
          applied += 1;
        } else if (op.action === "update") {
          const id = resolveId(op.id, ids);
          updateMaterial(base, id, {
            name: op.name != null ? String(op.name) : undefined,
            look: op.look != null ? String(op.look) : undefined,
            notes: op.notes != null ? String(op.notes) : undefined,
            duration: typeof op.duration === "number" ? op.duration : undefined,
          } as Partial<Material>);
          if (op.sketch) sketches.push({ id, sketch: String(op.sketch) });
          applied += 1;
        } else if (op.action === "delete") {
          deleteMaterial(base, resolveId(op.id, ids));
          applied += 1;
        } else if (op.action === "de_dup") {
          applyMergeMaterial(base, String(op.keep || ""), String(op.drop || ""), ids, op as Record<string, unknown>);
          applied += 1;
        } else if (op.action === "merge") {
          const rawSources = (op as { sources?: unknown }).sources;
          const sources = Array.isArray(rawSources)
            ? rawSources.map(String).filter(Boolean)
            : String(rawSources || "").split(/\s+/).filter(Boolean);
          if (op.keep || op.drop) throw new Error("use de_dup");
          applyCompositeMerge(
            base,
            sources,
            ids,
            op.name != null ? String(op.name) : "",
            op.look != null ? String(op.look) : "",
            op.notes != null ? String(op.notes) : "",
          );
          created.nodes += 1;
          applied += 1;
        }
      } else if (op.entity === "link") {
        const from = resolveId(op.from, ids);
        const to = resolveId(op.to, ids);
        const kind = (op.kind === "regression" ? "regression" : op.kind === "related" ? "related" : "progression") as Link["kind"];
        if (op.action === "create") {
          if (kind === "regression") {
            createLink(base, { from, kind: "progression", to, note: String(op.note || ""), leap: typeof op.leap === "number" ? op.leap : undefined });
          } else if (kind === "related") {
            createLink(base, { from, kind: "related", to, note: String(op.note || ""), tag: String(op.tag || "") });
          } else {
            createLink(base, { from, kind: "progression", to, note: String(op.note || ""), leap: typeof op.leap === "number" ? op.leap : undefined });
          }
          created.links += 1;
          applied += 1;
        } else if (op.action === "update") {
          updateLink(base, from, kind === "regression" ? "progression" : kind, to, {
            note: op.note != null ? String(op.note) : undefined,
            tag: op.tag != null ? String(op.tag) : undefined,
            leap: typeof op.leap === "number" ? op.leap : undefined,
          });
          applied += 1;
        } else if (op.action === "delete") {
          deleteLink(base, from, kind === "regression" ? "progression" : kind, to);
          applied += 1;
        }
      } else if (op.entity === "set") {
        if (op.action === "create") {
          createSet(base, {
            name: String(op.name || "Cluster"),
            note: String(op.note || ""),
            members: Array.isArray(op.members) ? (op.members as string[]).map((id) => resolveId(id, ids)) : [],
            parent: op.parent ? resolveId(op.parent, ids) : null,
          });
          applied += 1;
        } else if (op.action === "update") {
          updateSet(base, String(op.id || ""), {
            name: op.name != null ? String(op.name) : undefined,
            note: op.note != null ? String(op.note) : undefined,
            members: Array.isArray(op.members) ? (op.members as string[]).map((id) => resolveId(id, ids)) : undefined,
            parent: op.parent === undefined ? undefined : op.parent ? resolveId(op.parent, ids) : null,
          });
          applied += 1;
        } else if (op.action === "delete") {
          deleteSet(base, String(op.id || ""));
          applied += 1;
        }
      }
    } catch (err) {
      errors.push((err as Error).message || String(err));
    }
  }
  for (const row of sketches) {
    const sketchPath = String(row.sketch || "");
    const buf = path.isAbsolute(sketchPath) && existsSync(sketchPath)
      ? readFileSync(sketchPath)
      : readChatSessionFile(base, path.basename(sketchPath));
    if (!buf) continue;
    try {
      attachSketch(base, row.id, buf, path.basename(row.sketch));
    } catch (err) {
      errors.push((err as Error).message || String(err));
    }
  }
  clearChatSession(base);
  return { applied, errors, ids, created };
  } finally {
    endBatch(base);
  }
}

export const REFLECT_PROMPT = `You parse a FLAG PE teacher's after-class reflection.

You receive one ReflectInput JSON object (that day's pinned materials only). Return one ReflectOutput JSON object. Do not rewrite material files. Do not output leap, nudgeCount, look, notes, or sketches.

Rules:
1. tags: exactly one "@" + id for every materials[].id in the input, even if the teacher did not name that drill.
2. observations: exactly one object per materials[].id.
3. judgment: still only "too_easy" | "too_hard" | "unclear" (never too_slow / too_fast). Prose that names that pin wins. If the teacher said nothing about that pin, leave it "unclear" and let code apply dock flags: too easy / too slow → same as too_easy; too hard / too fast → same as too_hard; if both pairs are on, difficulty beats pace.
4. nextGoalLlm: one or two sentences for the next period. Do not invent material ids that are not in the input.
5. Return JSON only, matching ReflectOutput. No extra top-level keys.

ReflectInput schema:
{"type":"object","required":["periodId","feedback","flags","materials"],"additionalProperties":false,"properties":{"periodId":{"type":"string"},"feedback":{"type":"string"},"flags":{"type":"array","items":{"enum":["too slow","too fast","too easy","too hard"]}},"userNextGoal":{"type":"string"},"materials":{"type":"array","minItems":1,"items":{"type":"object","required":["id","name","duration","hops"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^M[0-9]+$"},"name":{"type":"string"},"duration":{"type":"number"},"hops":{"type":"array","items":{"type":"object","required":["from","to","kind","leap","nudgeCount"],"additionalProperties":false,"properties":{"from":{"type":"string"},"to":{"type":"string"},"kind":{"enum":["progression","regression"]},"leap":{"type":"number"},"nudgeCount":{"type":"integer","minimum":0}}}}}}}}}

ReflectOutput schema:
{"type":"object","required":["tags","observations","nextGoalLlm"],"additionalProperties":false,"properties":{"tags":{"type":"array","minItems":1,"items":{"type":"string","pattern":"^@M[0-9]+$"}},"observations":{"type":"array","minItems":1,"items":{"type":"object","required":["id","judgment"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^M[0-9]+$"},"judgment":{"enum":["too_easy","too_hard","unclear"]},"why":{"type":"string"}}}},"nextGoalLlm":{"type":"string"}}}`;

export type ReflectJudgment = "too_easy" | "too_hard" | "unclear";

export type ReflectOutput = {
  tags: string[];
  observations: { id: string; judgment: ReflectJudgment; why?: string }[];
  nextGoalLlm: string;
};

const PIN_RE = /^M\d+$/;
const TAG_RE = /^@M\d+$/;

export function periodPinIds(p: Period): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id?: string) => {
    if (!id || !PIN_RE.test(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const a of p.activities || []) add(a.id);
  return ids;
}

function incidentChainHops(id: string, links: Link[]) {
  return links
    .filter((L) => (L.kind === "progression" || L.kind === "regression") && (L.from === id || L.to === id))
    .map((L) => ({
      from: L.from,
      to: L.to,
      kind: L.kind as "progression" | "regression",
      leap: hopLeap(L),
      nudgeCount: L.nudgeCount || 0,
    }));
}

export function buildReflectInput(period: Period, materials: Material[], links: Link[]) {
  const pins = periodPinIds(period);
  const byId = new Map(materials.map((m) => [m.id, m]));
  return {
    periodId: period.id,
    feedback: period.reflection?.text || "",
    flags: period.reflection?.flags || [],
    userNextGoal: userNextGoalBlock(period.nextGoal || ""),
    materials: pins.map((id) => {
      const m = byId.get(id);
      return {
        id,
        name: m?.name || id,
        duration: m?.duration || 20,
        hops: incidentChainHops(id, links),
      };
    }),
  };
}

export function validateReflectOutput(raw: unknown, pinIds: string[]): ReflectOutput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "not an object";
  const o = raw as Record<string, unknown>;
  if ("leap" in o) return "leap is not allowed in ReflectOutput";
  const keys = Object.keys(o);
  for (const k of keys) {
    if (k !== "tags" && k !== "observations" && k !== "nextGoalLlm") return "extra key: " + k;
  }
  if (!Array.isArray(o.tags) || !Array.isArray(o.observations) || typeof o.nextGoalLlm !== "string") {
    return "missing tags, observations, or nextGoalLlm";
  }
  const pinSet = new Set(pinIds);
  const tagIds = new Set<string>();
  for (const t of o.tags) {
    if (typeof t !== "string" || !TAG_RE.test(t)) return "invalid tag: " + String(t);
    tagIds.add(t.slice(1));
  }
  if (tagIds.size !== pinSet.size || [...pinSet].some((id) => !tagIds.has(id))) return "tags must cover every pin";
  const seen = new Set<string>();
  const observations: ReflectOutput["observations"] = [];
  for (const row of o.observations) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return "invalid observation";
    const rec = row as Record<string, unknown>;
    if ("leap" in rec) return "leap is not allowed on an observation";
    for (const k of Object.keys(rec)) {
      if (k !== "id" && k !== "judgment" && k !== "why") return "extra observation key: " + k;
    }
    const id = String(rec.id || "");
    const judgment = rec.judgment;
    if (!PIN_RE.test(id) || !pinSet.has(id)) return "invalid or unknown id: " + id;
    if (seen.has(id)) return "duplicate observation: " + id;
    if (judgment !== "too_easy" && judgment !== "too_hard" && judgment !== "unclear") return "invalid judgment";
    seen.add(id);
    const item: ReflectOutput["observations"][0] = { id, judgment };
    if (typeof rec.why === "string" && rec.why) item.why = rec.why;
    observations.push(item);
  }
  if (seen.size !== pinSet.size) return "observations must cover every pin";
  return {
    tags: pinIds.map((id) => "@" + id),
    observations,
    nextGoalLlm: o.nextGoalLlm,
  };
}

export function userNextGoalBlock(text: string): string {
  const raw = String(text || "");
  const m = /user's input:\s*([\s\S]*?)(?:\n\s*next period:|$)/i.exec(raw);
  if (m) {
    const block = m[1].trim();
    return !block || block === "(none)" ? "" : block;
  }
  return raw.trim();
}

export function mergeNextGoal(user: string, llm: string): string {
  const u = user.trim() || "(none)";
  const n = llm.trim() || "(none)";
  return "user's input:\n" + u + "\n\nnext period:\n" + n;
}

export function appendMaterialTags(text: string, tags: string[]): string {
  let t = (text || "").trim();
  for (const tag of tags) {
    const re = new RegExp("(^|\\s)" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)");
    if (!re.test(t)) t = (t + " " + tag).trim();
  }
  return t;
}

function hopsToUpdate(id: string, pinSet: Set<string>, links: Link[]): Link[] {
  const chain = links.filter(
    (L) => (L.kind === "progression" || L.kind === "regression") && (L.from === id || L.to === id),
  );
  const both = chain.filter((L) => pinSet.has(L.from) && pinSet.has(L.to));
  return both.length ? both : chain;
}

export function judgmentToS(j: ReflectJudgment, flags: string[] = []): number {
  if (j === "too_easy") return 1;
  if (j === "too_hard") return 0;
  const set = new Set(flags);
  if (set.has("too easy")) return 1;
  if (set.has("too hard")) return 0;
  if (set.has("too slow")) return 1;
  if (set.has("too fast")) return 0;
  return 0.5;
}

export function applyReflectElo(
  base: string,
  output: ReflectOutput,
  pinIds: string[],
  links: Link[],
  flags: string[] = [],
): Link[] {
  const pinSet = new Set(pinIds);
  const seen = new Set<string>();
  for (const obs of output.observations) {
    const s = judgmentToS(obs.judgment, flags);
    for (const L of hopsToUpdate(obs.id, pinSet, links)) {
      const key = L.from + "\0" + L.kind + "\0" + L.to;
      if (seen.has(key)) continue;
      seen.add(key);
      const next = eloUpdateLeap(hopLeap(L), s, L.nudgeCount || 0);
      updateLink(base, L.from, L.kind, L.to, { leap: next.leap, nudgeCount: next.nudgeCount });
    }
  }
  return listLinks(base);
}

export async function reflect(base: string, periodId: string, parsedOutput?: unknown): Promise<{
  period: Period;
  links: Link[];
  output: ReflectOutput;
}> {
  const { getPeriod, savePeriod } = await import("./store.ts");
  const period = getPeriod(base, periodId);
  if (!period) {
    const err = new Error("unknown period " + periodId) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const materials = listMaterials(base);
  const links = listLinks(base);
  const pins = periodPinIds(period);
  if (!pins.length) {
    const err = new Error("pin activities before reflecting") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const user = JSON.stringify(buildReflectInput(period, materials, links));
  let lastRaw = "";
  let output: ReflectOutput | null = null;
  if (parsedOutput !== undefined) {
    const result = validateReflectOutput(parsedOutput, pins);
    if (typeof result === "string") {
      const err = new Error(result) as Error & { status: number };
      err.status = 422;
      throw err;
    }
    output = result;
  } else {
  for (let attempt = 0; attempt < 2; attempt++) {
    lastRaw = await chatOnce(user, { system: REFLECT_PROMPT, temperature: 0.2, maxTokens: 2048 });
    const parsed = parseJsonObject<unknown>(lastRaw);
    if (parsed == null) continue;
    const result = validateReflectOutput(parsed, pins);
    if (typeof result !== "string") {
      output = result;
      break;
    }
  }
  if (!output) {
    const err = new Error(lastRaw || "model returned unusable JSON") as Error & { status: number };
    err.status = 422;
    throw err;
  }
  }
  const nextLinks = applyReflectElo(base, output, pins, links, period.reflection?.flags || []);
  const text = appendMaterialTags(period.reflection?.text || "", output.tags);
  const nextGoal = mergeNextGoal(userNextGoalBlock(period.nextGoal || ""), output.nextGoalLlm);
  const saved = savePeriod(base, period.id, {
    ...period,
    reflection: { ...(period.reflection || { flags: [], text: "" }), text, savedAt: period.reflection?.savedAt },
    nextGoal,
  });
  return { period: saved, links: nextLinks, output };
}
