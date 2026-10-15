import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml, Scalar } from "yaml";
import { emptyCalendar, GRADE_TOKEN, hydrateCalendar, validateCalendar } from "../web/calendar-model.ts";
import { MOTOR_ROOT_NAME, COMPONENT_ROOT_NAME, childrenOf, wouldCycle } from "../web/set-tree.ts";
import {
  MOTOR_SKILLS,
  SKILL_RELATED_COMPONENTS,
  parseMotorSkills,
  parseSkillRelatedComponents,
  type MotorSkill,
  type SkillRelatedComponent,
} from "../web/material-taxonomy.ts";
import { validateProgressionHop, validateRelatedHop } from "../web/graph-model.ts";
import type { ClassNote, Link, LinkKind, Material, Neighbor, Neighbors, Period, PeriodActivity } from "../web/types.ts";

const LEGACY_LANES = ["instant", "skill", "key"] as const;
export const KINDS: LinkKind[] = ["regression", "progression", "related"];

export type HttpError = Error & { status: number };

export function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}

type RelHop = { id: string; note?: string; tag?: string; leap?: number; nudgeCount?: number };
type Relations = {
  regression?: RelHop[];
  progression?: RelHop[];
  related?: RelHop[];
  similar_body?: RelHop[];
  tags?: RelHop[];
};

function tagFromNote(note: string): string {
  const t = (note || "").replace(/\s+/g, " ").replace(/[.]+$/, "").trim();
  if (!t) return "related";
  return t.length > 48 ? t.slice(0, 45).trimEnd() + "…" : t;
}

function normalizeKind(kind: string): LinkKind {
  if (kind === "similar_body" || kind === "tag") return "related";
  return kind as LinkKind;
}

function migrateRelations(rel: Relations): Relations {
  const related = [...(rel.related || [])];
  for (const hop of rel.tags || []) {
    const id = hop.id;
    if (!id) continue;
    const tag = (hop as RelHop & { name?: string }).name || hop.tag || "";
    if (!related.some((h) => h.id === id)) related.push({ id, note: hop.note || "", tag });
  }
  delete rel.tags;
  rel.related = related.length ? related : undefined;
  return rel;
}

type MaterialFm = {
  id: string;
  name: string;
  look: string;
  motorSkills?: unknown;
  skillRelatedComponents?: unknown;
  duration?: number;
  sketch?: string;
  classNotes?: unknown;
  explanation?: unknown;
  relations?: Relations;
};

function facetsOrThrow(rawMotors: unknown, rawComponents: unknown): {
  motorSkills: MotorSkill[];
  skillRelatedComponents: SkillRelatedComponent[];
} {
  try {
    return {
      motorSkills: parseMotorSkills(rawMotors, "reject"),
      skillRelatedComponents: parseSkillRelatedComponents(rawComponents, "reject"),
    };
  } catch (err) {
    throw httpError(400, err instanceof Error ? err.message : "invalid skill facets");
  }
}

export function defaultDuration(): number {
  return 20;
}

function parseDuration(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return defaultDuration();
  return Math.min(40, Math.round(n));
}

export function libraryRoot(base: string): string {
  return path.join(base, "library");
}

function materialsDir(base: string) {
  return path.join(libraryRoot(base), "materials");
}
function periodsDir(base: string) {
  return path.join(libraryRoot(base), "periods");
}
function fociPath(base: string) {
  return path.join(libraryRoot(base), "_foci.yaml");
}
function setsPath(base: string) {
  return path.join(libraryRoot(base), "_sets.yaml");
}
function calendarPath(base: string) {
  return path.join(libraryRoot(base), "_calendar.yaml");
}

export type CalendarFsOps = {
  writeFileSync: (file: string, contents: string) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (file: string) => void;
  existsSync: (file: string) => boolean;
};

const defaultCalendarFs: CalendarFsOps = {
  writeFileSync: (file, contents) => writeFileSync(file, contents),
  renameSync,
  unlinkSync,
  existsSync,
};

export type HistoryEntry = { id: string; at: string; label: string };

type Snap = { rel: string; existed: boolean };

type OpenBatch = {
  base: string;
  explicit: boolean;
  label: string;
  snaps: Map<string, Snap>;
};

let openBatch: OpenBatch | null = null;
let historySuppress = 0;

function withoutHistory<T>(fn: () => T): T {
  historySuppress += 1;
  try {
    return fn();
  } finally {
    historySuppress -= 1;
  }
}

function historyDir(base: string) {
  return path.join(libraryRoot(base), ".history");
}

function historyIndexPath(base: string) {
  return path.join(historyDir(base), "index.json");
}

function encodeRel(rel: string) {
  return rel.split(path.sep).join("__");
}

function stagingDir(base: string) {
  return path.join(historyDir(base), ".staging");
}

function libraryBaseOf(file: string): string | null {
  const norm = path.normalize(file);
  const marker = path.sep + "library" + path.sep;
  const i = norm.lastIndexOf(marker);
  if (i < 0) return null;
  return norm.slice(0, i);
}

function readHistoryIndex(base: string): { id: string; at: string; label: string; files: Snap[] }[] {
  const p = historyIndexPath(base);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { entries?: { id: string; at: string; label: string; files: Snap[] }[] };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function writeHistoryIndex(base: string, entries: { id: string; at: string; label: string; files: Snap[] }[]) {
  mkdirSync(historyDir(base), { recursive: true });
  writeFileSync(historyIndexPath(base), JSON.stringify({ _agent: HISTORY_AGENT_NOTE, entries }, null, 2));
}

function dropHistoryDir(base: string, id: string) {
  rmSync(path.join(historyDir(base), id), { recursive: true, force: true });
}

const HISTORY_KEEP_MS = 24 * 60 * 60 * 1000;

function pruneHistory(base: string, entries: { id: string; at: string; label: string; files: Snap[] }[]) {
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  const kept: { id: string; at: string; label: string; files: Snap[] }[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at < cutoff) dropHistoryDir(base, entry.id);
    else kept.push(entry);
  }
  return kept;
}

function snapLabel(base: string, snap: Snap) {
  const name = path.basename(snap.rel).replace(/\.md$/, "");
  const now = existsSync(path.join(base, snap.rel));
  if (!snap.existed && now) return "write " + name;
  if (snap.existed && !now) return "delete " + name;
  return "write " + name;
}

function settleImplicit() {
  if (openBatch && !openBatch.explicit) closeBatch();
}

function closeBatch(): HistoryEntry | null {
  const batch = openBatch;
  openBatch = null;
  if (!batch || batch.snaps.size === 0) {
    if (batch) rmSync(stagingDir(batch.base), { recursive: true, force: true });
    return null;
  }
  const stage = stagingDir(batch.base);
  const entries = readHistoryIndex(batch.base);
  let last: HistoryEntry | null = null;
  let n = 0;
  for (const snap of batch.snaps.values()) {
    const id = "h" + Date.now().toString(36) + n.toString(36) + Math.random().toString(36).slice(2, 6);
    n += 1;
    const dest = path.join(historyDir(batch.base), id);
    mkdirSync(dest, { recursive: true });
    const blobName = encodeRel(snap.rel);
    const from = path.join(stage, blobName);
    if (existsSync(from)) renameSync(from, path.join(dest, blobName));
    const entry = { id, at: new Date().toISOString(), label: batch.label || snapLabel(batch.base, snap), files: [snap] };
    entries.push(entry);
    last = { id: entry.id, at: entry.at, label: entry.label };
  }
  rmSync(stage, { recursive: true, force: true });
  writeHistoryIndex(batch.base, pruneHistory(batch.base, entries));
  return last;
}

function trackWrite(file: string) {
  if (historySuppress) return;
  const abs = path.resolve(file);
  const base = libraryBaseOf(abs);
  if (!base) return;
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith("..") || rel.split(path.sep).includes(".history")) return;
  if (!openBatch || openBatch.base !== base) {
    if (openBatch?.explicit) return;
    if (openBatch) closeBatch();
    openBatch = { base, explicit: false, label: "", snaps: new Map() };
  }
  if (openBatch.snaps.has(rel)) return;
  const existed = existsSync(abs);
  openBatch.snaps.set(rel, { rel, existed });
  if (!existed) return;
  const blob = path.join(stagingDir(base), encodeRel(rel));
  mkdirSync(path.dirname(blob), { recursive: true });
  copyFileSync(abs, blob);
}

/** One agreed commit is one history round. Joins an open batch instead of starting another. */
export function beginBatch(base: string): { ok: true } {
  if (openBatch && !openBatch.explicit) closeBatch();
  if (openBatch && openBatch.explicit && openBatch.base === base) return { ok: true };
  if (openBatch) closeBatch();
  openBatch = { base, explicit: true, label: "", snaps: new Map() };
  return { ok: true };
}

let implicitDepth = 0;

function enterWrite(): boolean {
  if (openBatch?.explicit) return false;
  implicitDepth += 1;
  return implicitDepth === 1;
}

function leaveWrite(owned: boolean) {
  if (openBatch?.explicit) return;
  if (!owned) {
    implicitDepth = Math.max(0, implicitDepth - 1);
    return;
  }
  implicitDepth = 0;
  if (openBatch && !openBatch.explicit) closeBatch();
}

/** Closes the open round. An empty round is not stored. */
export function endBatch(base?: string): HistoryEntry | null {
  if (!openBatch) return null;
  if (base && openBatch.base !== base) return null;
  return closeBatch();
}

export function listHistory(base: string): HistoryEntry[] {
  settleImplicit();
  const entries = readHistoryIndex(base);
  const kept = pruneHistory(base, entries);
  if (kept.length !== entries.length) writeHistoryIndex(base, kept);
  return kept.map(({ id, at, label }) => ({ id, at, label }));
}

export function restoreHistory(base: string, id: string): { entry: HistoryEntry; ids: string[] } {
  settleImplicit();
  const entries = pruneHistory(base, readHistoryIndex(base));
  const chosen = entries.find((e) => e.id === id);
  if (!chosen) throw httpError(404, "unknown patch " + id);
  const restoreId = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const restoreDir = path.join(historyDir(base), restoreId);
  mkdirSync(restoreDir, { recursive: true });
  const left: Snap[] = [];
  for (const snap of chosen.files) {
    const abs = path.join(base, snap.rel);
    const existed = existsSync(abs);
    left.push({ rel: snap.rel, existed });
    if (existed) {
      const blob = path.join(restoreDir, encodeRel(snap.rel));
      mkdirSync(path.dirname(blob), { recursive: true });
      copyFileSync(abs, blob);
    }
    if (!snap.existed) {
      if (existsSync(abs)) unlinkSync(abs);
      continue;
    }
    const blob = path.join(historyDir(base), chosen.id, encodeRel(snap.rel));
    if (!existsSync(blob)) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    copyFileSync(blob, abs);
  }
  const entry = { id: restoreId, at: new Date().toISOString(), label: "restore", files: left };
  entries.push(entry);
  writeHistoryIndex(base, pruneHistory(base, entries));
  const ids = chosen.files.map((snap) => {
    const m = /materials\/(M\d+)\.md$/.exec(snap.rel.split(path.sep).join("/"));
    return m ? m[1] : "";
  }).filter(Boolean);
  return { entry: { id: entry.id, at: entry.at, label: entry.label }, ids };
}

export function atomicWriteCalendar(file: string, contents: string, ops: CalendarFsOps = defaultCalendarFs) {
  if (ops === defaultCalendarFs) trackWrite(file);
  const tmp = file + "." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8) + ".tmp";
  try {
    ops.writeFileSync(tmp, contents);
    ops.renameSync(tmp, file);
  } catch (err) {
    try {
      if (ops.existsSync(tmp)) ops.unlinkSync(tmp);
    } catch {
      /* keep the original write/rename error */
    }
    throw err;
  }
}

function mediaDir(base: string) {
  return path.join(libraryRoot(base), "media_library", "flag football");
}

/** Absolute path on disk. Accepts short `library/media_library/flag football/…`, `media_library/…`, `canva-sketches/…`, `library/sketches/…`, or an already-complete path. */
export function completeSketchPath(base: string, sketch: string): string {
  const raw = (sketch || "").trim();
  if (!raw) return "";
  const n = raw.replace(/\\/g, "/").split("?")[0];
  const name = path.basename(n);
  const dest = path.resolve(mediaDir(base), name);
  if (existsSync(dest)) return dest;
  if (path.isAbsolute(raw)) {
    const abs = path.normalize(n);
    if (existsSync(abs)) return abs;
  }
  return dest;
}

export function persistMissingDurations(base: string) {
  withoutHistory(() => persistMissingDurationsBody(base));
}

function persistMissingDurationsBody(base: string) {
  for (const file of listMaterialFiles(base)) {
    const raw = readFileSync(file, "utf8");
    if (/(^|\n)duration:/.test(raw)) continue;
    writeMaterialFile(file, readMaterialFile(file));
  }
}

/** Fold `similar_body` into `related` (required tag). Fill missing related tags. */
export function migrateSimilarBodyToRelated(base: string) {
  withoutHistory(() => migrateSimilarBodyToRelatedBody(base));
}

function migrateSimilarBodyToRelatedBody(base: string) {
  for (const file of listMaterialFiles(base)) {
    const m = readMaterialFile(file);
    const rel = m.relations || {};
    const related = [...(rel.related || [])];
    const bodyTag = m.motorSkills[0] || "";
    let dirty = false;
    for (const hop of related) {
      if ((hop.tag || "").trim()) continue;
      hop.tag = (hop.note || "").trim() ? tagFromNote(hop.note || "") : (bodyTag || "related");
      dirty = true;
    }
    for (const hop of rel.similar_body || []) {
      const tag = (hop.tag || "").trim() || bodyTag || tagFromNote(hop.note || "") || "related";
      const dup = related.some((h) => h.id === hop.id && (h.tag || "") === tag);
      if (!dup) related.push({ id: hop.id, note: hop.note || "", tag });
      dirty = true;
    }
    if (rel.similar_body) {
      delete rel.similar_body;
      dirty = true;
    }
    if (!dirty) continue;
    m.relations = { ...rel, related };
    writeMaterialFile(file, m);
  }
}

export function persistCompleteSketchPaths(base: string) {
  withoutHistory(() => persistCompleteSketchPathsBody(base));
}

function persistCompleteSketchPathsBody(base: string) {
  for (const m of loadAllMaterials(base)) {
    if (!m.sketch) continue;
    const abs = completeSketchPath(base, m.sketch);
    if (path.isAbsolute(m.sketch) && abs === m.sketch) continue;
    m.sketch = abs;
    writeMaterialFile(materialPath(base, m.id), m);
  }
}

const SKETCH_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".m4v", ".webm", ".mov"]);
const SKETCH_MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-m4v": ".m4v",
};

export function ensureLibrary(base: string) {
  mkdirSync(materialsDir(base), { recursive: true });
  mkdirSync(periodsDir(base), { recursive: true });
  mkdirSync(mediaDir(base), { recursive: true });
}

const AGENT_NOTE_RE = /^<agent-note>[\s\S]*?<\/agent-note>\s*/;

function agentNoteBlock(call: string): string {
  return `<agent-note>\n[System note: This file is lesson content. To change it, call ${call}. Do not write this file.]\n</agent-note>\n`;
}

const MATERIAL_AGENT_CALL = "update_material for the text, create_link for a hop on this card, and attach_sketch for its picture";
const PERIOD_AGENT_CALL = "save_period";
const SET_AGENT_CALL = "update_set";
const CALENDAR_AGENT_CALL = "save_calendar";
const HISTORY_AGENT_NOTE = "[System note: This file is lesson content. To change it, call restore_patch. Do not write this file.]";

function stripAgentNote(raw: string): string {
  return raw.replace(AGENT_NOTE_RE, "");
}

function splitFrontmatter(raw: string): { fm: string; body: string } {
  raw = stripAgentNote(raw);
  if (!raw.startsWith("---")) return { fm: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { fm: "", body: raw };
  const fm = raw.slice(3, end).trim();
  let body = raw.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  return { fm, body: body.replace(/\s+$/, "") + (body.trim() ? "\n" : "") };
}

export function readMaterialFile(file: string): Material & { relations: Relations } {
  const { fm, body } = splitFrontmatter(readFileSync(file, "utf8"));
  const data = (parseYaml(fm) || {}) as MaterialFm;
  return {
    id: data.id,
    name: data.name,
    look: data.look || "",
    motorSkills: parseMotorSkills(data.motorSkills, "drop"),
    skillRelatedComponents: parseSkillRelatedComponents(data.skillRelatedComponents, "drop"),
    duration: parseDuration(data.duration),
    notes: body.trim(),
    explanation: String(data.explanation || body.trim() || ""),
    sketch: data.sketch,
    classNotes: Array.isArray(data.classNotes)
      ? (data.classNotes as unknown[]).flatMap((row) => {
          if (!row || typeof row !== "object") return [];
          const rec = row as Record<string, unknown>;
          const rawDate = rec.date;
          const date =
            rawDate instanceof Date && !Number.isNaN(rawDate.getTime())
              ? rawDate.toISOString().slice(0, 10)
              : String(rawDate || "").trim();
          const grade = rec.grade;
          const text = String(rec.text ?? "");
          if (!date || typeof grade !== "string" || grade === "all" || !GRADE_TOKEN.test(grade)) return [];
          return [{ date, grade, text }];
        })
      : [],
    relations: migrateRelations(data.relations || {}),
  };
}

function linkFromHop(from: string, kind: LinkKind, to: string, hop: RelHop): Link {
  const L: Link = { from, kind, to, note: hop.note || "" };
  if (hop.tag) L.tag = hop.tag;
  if (hop.leap != null && Number.isFinite(hop.leap)) L.leap = hop.leap;
  if (hop.nudgeCount && hop.nudgeCount > 0) L.nudgeCount = hop.nudgeCount;
  return L;
}

function writeHop(h: RelHop): RelHop {
  const out: RelHop = { id: h.id };
  if (h.note) out.note = h.note;
  if (h.tag) out.tag = h.tag;
  const n = h.nudgeCount && h.nudgeCount > 0 ? Math.round(h.nudgeCount) : 0;
  const leap = h.leap;
  const omitLeap = leap == null || (leap === 1 && n === 0);
  if (!omitLeap && leap != null && Number.isFinite(leap)) out.leap = leap;
  if (n > 0) out.nudgeCount = n;
  return out;
}

function omitEmptyRelations(rel: Relations): Relations | undefined {
  const out: Relations = {};
  if (rel.regression?.length) out.regression = rel.regression.map(writeHop);
  if (rel.progression?.length) out.progression = rel.progression.map(writeHop);
  if (rel.related?.length) out.related = rel.related.map(writeHop);
  return Object.keys(out).length ? out : undefined;
}

export function writeMaterialFile(file: string, m: Material & { relations?: Relations }) {
  trackWrite(file);
  const front: Record<string, unknown> = {
    id: m.id,
    name: m.name,
    look: m.look || "",
    duration: parseDuration(m.duration),
  };
  if (m.sketch) {
    const s = new Scalar(completeSketchPath(path.resolve(path.dirname(file), "..", ".."), m.sketch));
    s.type = Scalar.QUOTE_DOUBLE;
    front.sketch = s;
  }
  const classNotes = (m.classNotes || []).filter((n): n is ClassNote => Boolean(n && n.date && n.grade && n.grade !== "all" && GRADE_TOKEN.test(n.grade) && String(n.text ?? "").trim()));
  if (classNotes.length) front.classNotes = classNotes;
  const rel = omitEmptyRelations(m.relations || {});
  if (rel) front.relations = rel;
  const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
  const notes = (m.notes || m.explanation || "").replace(/\s+$/, "");
  writeFileSync(file, agentNoteBlock(MATERIAL_AGENT_CALL) + `---\n${yaml}\n---\n${notes ? "\n" + notes + "\n" : ""}`);
}

function materialPath(base: string, id: string) {
  return path.join(materialsDir(base), `${id}.md`);
}

function listMaterialFiles(base: string): string[] {
  if (!existsSync(materialsDir(base))) return [];
  return readdirSync(materialsDir(base))
    .filter((n) => /^M\d+\.md$/.test(n))
    .map((n) => path.join(materialsDir(base), n));
}

export function idNumber(id: string): number {
  const m = /^M(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function loadAllMaterials(base: string): Array<Material & { relations: Relations }> {
  return listMaterialFiles(base)
    .map(readMaterialFile)
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function listMaterials(base: string): Material[] {
  ensureDefaultSets(base);
  const sets = listSetsRaw(base);
  return loadAllMaterials(base).map(({ relations: _r, ...m }) => {
    const derived = facetsFromSets(sets, m.id, m.motorSkills, m.skillRelatedComponents);
    return {
      ...m,
      ...derived,
      sketch: m.sketch ? completeSketchPath(base, m.sketch) : "",
    };
  });
}

export function createMaterial(
  base: string,
  input: {
    name: string;
    look?: string;
    motorSkills?: unknown;
    skillRelatedComponents?: unknown;
    duration?: number;
    notes?: string;
    explanation?: string;
    sketch?: string;
  },
): Material {
  const owned = enterWrite();
  try {
  if (!input.name?.trim()) throw httpError(400, "name is required");
  ensureLibrary(base);
  const max = loadAllMaterials(base).reduce((n, m) => Math.max(n, idNumber(m.id)), 0);
  const id = "M" + (max + 1);
  const facets = facetsOrThrow(input.motorSkills, input.skillRelatedComponents);
  const body = input.notes || input.explanation || "";
  const mat: Material & { relations: Relations } = {
    id,
    name: input.name.trim(),
    look: input.look?.trim() || "",
    motorSkills: facets.motorSkills,
    skillRelatedComponents: facets.skillRelatedComponents,
    duration: parseDuration(input.duration),
    notes: body,
    explanation: input.explanation || input.notes || "",
    sketch: input.sketch ? completeSketchPath(base, input.sketch) : undefined,
    relations: {},
  };
  writeMaterialFile(materialPath(base, id), mat);
  applyFacetMembership(base, id, facets.motorSkills, facets.skillRelatedComponents);
  return listMaterials(base).find((m) => m.id === id)!;
  } finally {
    leaveWrite(owned);
  }
}

export function updateMaterial(base: string, id: string, patch: Partial<Material>): Material {
  const owned = enterWrite();
  try {
  const file = materialPath(base, id);
  if (!existsSync(file)) throw httpError(404, "unknown material " + id);
  const cur = readMaterialFile(file);
  const oldName = cur.name;
  const oldSketch = cur.sketch || "";
  const { sketch, motorSkills, skillRelatedComponents, ...rest } = patch;
  Object.assign(cur, rest);
  if (rest.explanation != null && rest.notes == null) cur.notes = String(rest.explanation);
  if (motorSkills !== undefined || skillRelatedComponents !== undefined) {
    const facets = facetsOrThrow(
      motorSkills !== undefined ? motorSkills : cur.motorSkills,
      skillRelatedComponents !== undefined ? skillRelatedComponents : cur.skillRelatedComponents,
    );
    cur.motorSkills = facets.motorSkills;
    cur.skillRelatedComponents = facets.skillRelatedComponents;
    applyFacetMembership(base, id, facets.motorSkills, facets.skillRelatedComponents);
  }
  if (sketch !== undefined) cur.sketch = sketch ? completeSketchPath(base, sketch) : undefined;
  else if (rest.name != null && String(rest.name).trim() && String(rest.name).trim() !== oldName && oldSketch) {
    const abs = path.resolve(completeSketchPath(base, oldSketch));
    if (insideMedia(base, abs) && existsSync(abs)) {
      const ext = path.extname(abs);
      const dest = sketchDest(base, id, sketchFileStem(cur.name), ext);
      if (dest !== abs) {
        trackWrite(abs);
        trackWrite(dest);
        renameSync(abs, dest);
        cur.sketch = dest;
      }
    }
  }
  if (rest.duration !== undefined) cur.duration = parseDuration(rest.duration);
  writeMaterialFile(file, cur);
  return listMaterials(base).find((m) => m.id === id)!;
  } finally {
    leaveWrite(owned);
  }
}

function assertMaterial(base: string, id: string) {
  if (!existsSync(materialPath(base, id))) throw httpError(404, "unknown material " + id);
}

export function sketchFileStem(name: string): string {
  const cleaned = String(name || "").replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "sketch";
}

function insideMedia(base: string, abs: string): boolean {
  const dir = path.resolve(mediaDir(base));
  const file = path.resolve(abs);
  return file === dir || file.startsWith(dir + path.sep);
}

function unlinkTracked(file: string) {
  if (!existsSync(file)) return;
  trackWrite(file);
  unlinkSync(file);
}

export function removeAttachedSketchFiles(base: string, id: string, keep?: string) {
  const dir = mediaDir(base);
  if (!existsSync(dir)) return;
  const keepAbs = keep ? path.resolve(keep) : "";
  const file = materialPath(base, id);
  if (existsSync(file)) {
    const current = readMaterialFile(file).sketch || "";
    if (current) {
      const abs = path.resolve(completeSketchPath(base, current));
      if (abs !== keepAbs && insideMedia(base, abs)) unlinkTracked(abs);
    }
  }
  for (const n of readdirSync(dir)) {
    if (n.startsWith(id + ".") && SKETCH_EXTS.has(path.extname(n).toLowerCase())) {
      const attached = path.join(dir, n);
      if (path.resolve(attached) !== keepAbs) unlinkTracked(attached);
    }
  }
}

function sketchDest(base: string, id: string, stem: string, ext: string): string {
  const plain = path.resolve(mediaDir(base), stem + ext);
  if (!existsSync(plain)) return plain;
  return path.resolve(mediaDir(base), stem + " (" + id + ")" + ext);
}

export function attachSketch(base: string, id: string, data: Buffer, filename: string, mimeType?: string): Material {
  const owned = enterWrite();
  try {
  assertMaterial(base, id);
  let ext = path.extname(filename || "").toLowerCase();
  if (!SKETCH_EXTS.has(ext) && mimeType) ext = SKETCH_MIME_EXT[mimeType.split(";")[0].trim().toLowerCase()] || ext;
  if (!SKETCH_EXTS.has(ext)) throw httpError(400, "file must be png, jpg, webp, gif, mp4, webm, or mov");
  const video = ext === ".mp4" || ext === ".m4v" || ext === ".webm" || ext === ".mov";
  const max = video ? 1024 * 1024 * 1024 : 8 * 1024 * 1024;
  if (data.length > max) throw httpError(400, video ? "video is too large (1 GB max)" : "picture is too large (8 MB max)");
  ensureLibrary(base);
  removeAttachedSketchFiles(base, id);
  const ownedMat = readMaterialFile(materialPath(base, id));
  const dest = sketchDest(base, id, sketchFileStem(ownedMat.name), ext);
  trackWrite(dest);
  writeFileSync(dest, data);
  return updateMaterial(base, id, { sketch: dest });
  } finally {
    leaveWrite(owned);
  }
}

export function setSketchRel(base: string, id: string, rel: string): Material {
  const owned = enterWrite();
  try {
  assertMaterial(base, id);
  const abs = completeSketchPath(base, rel);
  const name = path.basename(abs);
  if (!SKETCH_EXTS.has(path.extname(name).toLowerCase())) throw httpError(400, "file must be png, jpg, webp, gif, mp4, webm, or mov");
  if (!name || name === "." || name === "..") throw httpError(400, "bad sketch name");
  if (!existsSync(abs)) throw httpError(400, "sketch file missing");
  removeAttachedSketchFiles(base, id, abs);
  return updateMaterial(base, id, { sketch: abs });
  } finally {
    leaveWrite(owned);
  }
}

export function clearSketch(base: string, id: string): Material {
  const owned = enterWrite();
  try {
  assertMaterial(base, id);
  removeAttachedSketchFiles(base, id);
  return updateMaterial(base, id, { sketch: "" });
  } finally {
    leaveWrite(owned);
  }
}

function flattenOne(owner: Material & { relations: Relations }): Link[] {
  const rel = owner.relations || {};
  const links: Link[] = [];
  for (const hop of rel.regression || []) {
    links.push(linkFromHop(hop.id, "regression", owner.id, hop));
  }
  for (const hop of rel.progression || []) {
    links.push(linkFromHop(owner.id, "progression", hop.id, hop));
  }
  for (const hop of rel.related || []) {
    links.push(linkFromHop(owner.id, "related", hop.id, { ...hop, leap: undefined, nudgeCount: undefined }));
  }
  for (const hop of rel.similar_body || []) {
    links.push({
      from: owner.id,
      kind: "related",
      to: hop.id,
      note: hop.note || "",
      tag: hop.tag || owner.motorSkills[0] || tagFromNote(hop.note || ""),
    });
  }
  return links;
}

export function listLinks(base: string): Link[] {
  return loadAllMaterials(base).flatMap(flattenOne);
}

function ownerIdFor(kind: LinkKind, from: string, to: string): string {
  return kind === "regression" ? to : from;
}

function linkMatches(L: Link, from: string, kind: string, to: string) {
  return L.from === from && L.kind === kind && L.to === to;
}

export function createLink(base: string, L: Link): Link {
  const owned = enterWrite();
  try {
  L = { ...L, kind: normalizeKind(L.kind) };
  if (!L.from || !L.to || L.from === L.to) throw httpError(400, "from and to must differ");
  if (!KINDS.includes(L.kind)) throw httpError(400, "unknown kind");
  if (L.kind === "related" && !(L.tag || "").trim()) throw httpError(400, "related links need a tag");
  const mats = loadAllMaterials(base);
  if (!mats.some((m) => m.id === L.from) || !mats.some((m) => m.id === L.to)) {
    throw httpError(400, "from and to must be existing material ids");
  }
  const existing = listLinks(base);
  if (L.kind === "progression" || L.kind === "regression") {
    const names: Record<string, string> = {};
    for (const m of mats) names[m.id] = m.name;
    const err = validateProgressionHop(L.from, L.to, existing, names);
    if (err) throw httpError(400, err);
    if (existing.some((x) => (x.kind === "progression" || x.kind === "regression") && x.from === L.from && x.to === L.to)) {
      throw httpError(409, "link already exists");
    }
    const hop: RelHop = { id: L.to, note: L.note || "" };
    if (L.leap != null && Number.isFinite(L.leap)) hop.leap = L.leap;
    if (L.nudgeCount && L.nudgeCount > 0) hop.nudgeCount = L.nudgeCount;
    const easier = mats.find((m) => m.id === L.from)!;
    const harder = mats.find((m) => m.id === L.to)!;
    easier.relations = easier.relations || {};
    harder.relations = harder.relations || {};
    easier.relations.progression = [...(easier.relations.progression || []), { ...hop, id: L.to }];
    harder.relations.regression = [...(harder.relations.regression || []), { ...hop, id: L.from }];
    writeMaterialFile(materialPath(base, easier.id), easier);
    writeMaterialFile(materialPath(base, harder.id), harder);
    return linkFromHop(L.from, "progression", L.to, hop);
  }
  if (existing.some((x) => linkMatches(x, L.from, L.kind, L.to) && (x.tag || "") === (L.tag || ""))) {
    throw httpError(409, "link already exists");
  }
  const names: Record<string, string> = {};
  for (const m of mats) names[m.id] = m.name;
  const relatedErr = validateRelatedHop(L.from, L.to, existing, names, L.tag);
  if (relatedErr) throw httpError(400, relatedErr);
  const owner = mats.find((m) => m.id === L.from)!;
  const rel = owner.relations || {};
  rel.related = [...(rel.related || []), { id: L.to, note: L.note || "", tag: L.tag!.trim() }];
  owner.relations = rel;
  writeMaterialFile(materialPath(base, owner.id), owner);
  return linkFromHop(L.from, "related", L.to, { id: L.to, note: L.note || "", tag: L.tag!.trim() });
  } finally {
    leaveWrite(owned);
  }
}

function findAndMutateLink(
  base: string,
  from: string,
  kind: LinkKind,
  to: string,
  mutate: (rel: Relations) => boolean,
): Relations | null {
  const ownerId = ownerIdFor(kind, from, to);
  const file = materialPath(base, ownerId);
  if (!existsSync(file)) return null;
  const owner = readMaterialFile(file);
  const ok = mutate(owner.relations || {});
  if (!ok) return null;
  writeMaterialFile(file, owner);
  return owner.relations;
}

export function updateLink(
  base: string,
  from: string,
  kind: LinkKind,
  to: string,
  patch: { note?: string; tag?: string; leap?: number; nudgeCount?: number },
  matchTag?: string,
): Link {
  const owned = enterWrite();
  try {
  kind = normalizeKind(kind);
  if (!KINDS.includes(kind)) throw httpError(400, "unknown kind");
  let found: Link | null = null;
  const apply = (hop: RelHop) => {
    if (patch.note !== undefined) hop.note = patch.note;
    if (patch.tag !== undefined) {
      if (kind === "related" && !patch.tag.trim()) throw httpError(400, "related links need a tag");
      hop.tag = patch.tag.trim() || undefined;
    }
    if (kind !== "related") {
      if (patch.leap !== undefined) hop.leap = patch.leap;
      if (patch.nudgeCount !== undefined) hop.nudgeCount = patch.nudgeCount;
    }
  };
  const rel = findAndMutateLink(base, from, kind, to, (r) => {
    if (kind === "regression") {
      const hop = (r.regression || []).find((h) => h.id === from);
      if (!hop) return false;
      apply(hop);
      found = linkFromHop(from, kind, to, hop);
      return true;
    }
    if (kind === "related") {
      const hop = (r.related || []).find((h) => h.id === to && (matchTag === undefined || (h.tag || "") === matchTag));
      if (!hop) return false;
      apply(hop);
      found = linkFromHop(from, kind, to, hop);
      return true;
    }
    const hop = (r.progression || []).find((h) => h.id === to);
    if (!hop) return false;
    apply(hop);
    found = linkFromHop(from, kind, to, hop);
    return true;
  });
  if (!rel || !found) throw httpError(404, "unknown link");
  if (kind === "progression" || kind === "regression") {
    const other: LinkKind = kind === "progression" ? "regression" : "progression";
    findAndMutateLink(base, from, other, to, (r) => {
      if (other === "regression") {
        const hop = (r.regression || []).find((h) => h.id === from);
        if (!hop) return false;
        apply(hop);
        return true;
      }
      const hop = (r.progression || []).find((h) => h.id === to);
      if (!hop) return false;
      apply(hop);
      return true;
    });
  }
  return found;
  } finally {
    leaveWrite(owned);
  }
}

export function deleteLink(base: string, from: string, kind: LinkKind, to: string, tag?: string): { ok: true } {
  const owned = enterWrite();
  try {
  kind = normalizeKind(kind);
  const rel = findAndMutateLink(base, from, kind, to, (r) => {
    if (kind === "regression") {
      const before = r.regression?.length || 0;
      r.regression = (r.regression || []).filter((h) => h.id !== from);
      return (r.regression.length || 0) < before;
    }
    if (kind === "related") {
      const before = r.related?.length || 0;
      r.related = (r.related || []).filter((h) => h.id !== to || (tag !== undefined && (h.tag || "") !== tag));
      return (r.related!.length || 0) < before;
    }
    const before = r.progression?.length || 0;
    r.progression = (r.progression || []).filter((h) => h.id !== to);
    return (r.progression!.length || 0) < before;
  });
  if (!rel) throw httpError(404, "unknown link");
  if (kind === "progression" || kind === "regression") {
    const other: LinkKind = kind === "progression" ? "regression" : "progression";
    findAndMutateLink(base, from, other, to, (r) => {
      if (other === "regression") {
        const before = r.regression?.length || 0;
        r.regression = (r.regression || []).filter((h) => h.id !== from);
        return (r.regression.length || 0) < before;
      }
      const before = r.progression?.length || 0;
      r.progression = (r.progression || []).filter((h) => h.id !== to);
      return (r.progression!.length || 0) < before;
    });
  }
  return { ok: true };
  } finally {
    leaveWrite(owned);
  }
}

export function deleteMaterial(base: string, id: string): { ok: true; removedLinks: number } {
  const owned = enterWrite();
  try {
  const file = materialPath(base, id);
  if (!existsSync(file)) throw httpError(404, "unknown material " + id);
  const doomed = readMaterialFile(file);
  const variationTag = "variation to " + (doomed.name || id);
  removeAttachedSketchFiles(base, id);
  trackWrite(file);
  unlinkSync(file);
  writeSetsFile(
    base,
    listSets(base).map((s) => ({ ...s, members: s.members.filter((m) => m !== id) })),
  );
  let removed = 0;
  for (const other of loadAllMaterials(base)) {
    const r = other.relations || {};
    const before = flattenOne(other).length;
    r.regression = (r.regression || []).filter((h) => h.id !== id);
    r.progression = (r.progression || []).filter((h) => h.id !== id);
    r.related = (r.related || []).filter((h) => h.id !== id && (h.tag || "") !== variationTag);
    delete r.similar_body;
    delete r.tags;
    other.relations = r;
    const after = flattenOne(other).length;
    if (after !== before) {
      removed += before - after;
      writeMaterialFile(materialPath(base, other.id), other);
    }
  }
  return { ok: true, removedLinks: removed };
  } finally {
    leaveWrite(owned);
  }
}

export function neighborsOf(id: string, links: Link[]): Neighbors {
  const out: Neighbors = { regression: [], progression: [], related: [] };
  const seen = new Set<string>();
  const push = (bucket: keyof Neighbors, other: string, L: Link) => {
    const k = bucket === "related" ? bucket + ":" + other + ":" + (L.tag || "") : bucket + ":" + other;
    if (seen.has(k) || other === id) return;
    seen.add(k);
    const n: Neighbor = { id: other, note: L.note || "" };
    if (L.tag) n.tag = L.tag;
    out[bucket].push(n);
  };
  for (const L of links) {
    const kind = normalizeKind(L.kind);
    if (kind === "regression") {
      if (L.to === id) push("regression", L.from, L);
      if (L.from === id) push("progression", L.to, L);
    } else if (kind === "progression") {
      if (L.from === id) push("progression", L.to, L);
      if (L.to === id) push("regression", L.from, L);
    } else if (kind === "related") {
      if (L.from === id) push("related", L.to, L);
      if (L.to === id) push("related", L.from, L);
    }
  }
  return out;
}

export function getFoci(base: string): Foci {
  const p = fociPath(base);
  if (!existsSync(p)) return { items: [], now: 0 };
  const data = (parseYaml(readFileSync(p, "utf8")) || {}) as Foci;
  return { items: data.items || [], now: data.now ?? 0 };
}

export function saveFoci(base: string, f: Foci): Foci {
  ensureLibrary(base);
  writeFileSync(fociPath(base), stringifyYaml({ items: f.items || [], now: f.now ?? 0 }));
  return getFoci(base);
}

function parseSet(raw: unknown): MaterialSet | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = String(s.id || "").trim();
  if (!/^S\d+$/.test(id)) return null;
  const members = Array.isArray(s.members) ? s.members.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const parentRaw = s.parent;
  const parent = parentRaw == null || parentRaw === "" ? null : String(parentRaw).trim();
  const originRaw = String(s.origin || "").trim();
  const origin: SetOrigin | undefined =
    originRaw === "default" || originRaw === "unit" || originRaw === "teacher" ? originRaw : undefined;
  return { id, name: String(s.name || "").trim(), note: String(s.note || "").trim(), members, parent, origin };
}

function writeSetsFile(base: string, sets: MaterialSet[]) {
  ensureLibrary(base);
  trackWrite(setsPath(base));
  writeFileSync(setsPath(base), agentNoteBlock(SET_AGENT_CALL) + stringifyYaml({ sets }));
}

function listSetsRaw(base: string): MaterialSet[] {
  const p = setsPath(base);
  if (!existsSync(p)) return [];
  const data = (parseYaml(stripAgentNote(readFileSync(p, "utf8"))) || {}) as { sets?: unknown[] };
  return (data.sets || []).map(parseSet).filter((s): s is MaterialSet => !!s);
}

function nextSetId(sets: MaterialSet[]): string {
  const max = sets.reduce((n, s) => {
    const m = /^S(\d+)$/.exec(s.id);
    return m ? Math.max(n, Number(m[1])) : n;
  }, 0);
  return "S" + (max + 1);
}

function mergeSetMembers(into: MaterialSet, from: MaterialSet) {
  for (const m of from.members) if (!into.members.includes(m)) into.members.push(m);
}

/** Keep one Motor / Skill tree; fold duplicate leaves into the nested children. */
function collapseFacetDuplicates(sets: MaterialSet[]): { sets: MaterialSet[]; changed: boolean } {
  const motor =
    sets.find((s) => s.name === MOTOR_ROOT_NAME && !s.parent && s.origin === "default") ||
    sets.find((s) => s.name === MOTOR_ROOT_NAME && !s.parent);
  const comp =
    sets.find((s) => s.name === COMPONENT_ROOT_NAME && !s.parent && s.origin === "default") ||
    sets.find((s) => s.name === COMPONENT_ROOT_NAME && !s.parent);
  if (!motor || !comp) return { sets, changed: false };
  const motorNames = new Set<string>(MOTOR_SKILLS);
  const compNames = new Set<string>(SKILL_RELATED_COMPONENTS);
  const keepMotor = new Map<string, MaterialSet>();
  const keepComp = new Map<string, MaterialSet>();
  for (const s of sets) {
    if (s.parent === motor.id && motorNames.has(s.name) && !keepMotor.has(s.name)) keepMotor.set(s.name, s);
    if (s.parent === comp.id && compNames.has(s.name) && !keepComp.has(s.name)) keepComp.set(s.name, s);
  }
  const drop = new Set<string>();
  for (const s of sets) {
    if (s.id === motor.id || s.id === comp.id) continue;
    if (s.name === MOTOR_ROOT_NAME) {
      drop.add(s.id);
      continue;
    }
    if (s.name === COMPONENT_ROOT_NAME) {
      drop.add(s.id);
      continue;
    }
    if (motorNames.has(s.name)) {
      const dest = keepMotor.get(s.name);
      if (dest && s.id !== dest.id) {
        mergeSetMembers(dest, s);
        drop.add(s.id);
      } else if (!dest) {
        s.parent = motor.id;
        keepMotor.set(s.name, s);
      }
    } else if (compNames.has(s.name)) {
      const dest = keepComp.get(s.name);
      if (dest && s.id !== dest.id) {
        mergeSetMembers(dest, s);
        drop.add(s.id);
      } else if (!dest) {
        s.parent = comp.id;
        keepComp.set(s.name, s);
      }
    }
  }
  for (const s of sets) {
    if (!s.parent || !drop.has(s.parent)) continue;
    if (motorNames.has(s.name)) s.parent = motor.id;
    else if (compNames.has(s.name)) s.parent = comp.id;
    else s.parent = null;
  }
  const next = sets.filter((s) => !drop.has(s.id));
  return { sets: next, changed: drop.size > 0 };
}

export function ensureDefaultSets(base: string): MaterialSet[] {
  return withoutHistory(() => ensureDefaultSetsBody(base));
}

function ensureDefaultSetsBody(base: string): MaterialSet[] {
  let sets = listSetsRaw(base);
  let dirty = false;
  if (!sets.some((s) => s.origin === "default" && s.name === MOTOR_ROOT_NAME)) {
    const add = (name: string, origin: SetOrigin, parent: string | null): MaterialSet => {
      const s: MaterialSet = { id: nextSetId(sets), name, note: "", members: [], parent, origin };
      sets.push(s);
      return s;
    };
    const motor = add(MOTOR_ROOT_NAME, "default", null);
    for (const name of MOTOR_SKILLS) add(name, "unit", motor.id);
    const comp = add(COMPONENT_ROOT_NAME, "default", null);
    for (const name of SKILL_RELATED_COMPONENTS) add(name, "default", comp.id);
    dirty = true;
  }
  const collapsed = collapseFacetDuplicates(sets);
  if (collapsed.changed) {
    sets = collapsed.sets;
    dirty = true;
  }
  if (dirty) writeSetsFile(base, sets);
  return sets;
}

function facetLeaves(sets: MaterialSet[], rootName: string): MaterialSet[] {
  const root = sets.find((s) => s.name === rootName && !s.parent);
  if (!root) return [];
  return childrenOf(sets, root.id);
}

function facetsFromSets(
  sets: MaterialSet[],
  id: string,
  fallbackMotors: MotorSkill[],
  fallbackComps: SkillRelatedComponent[],
): { motorSkills: MotorSkill[]; skillRelatedComponents: SkillRelatedComponent[] } {
  const motors = facetLeaves(sets, MOTOR_ROOT_NAME)
    .filter((s) => s.members.includes(id))
    .map((s) => s.name)
    .filter((n): n is MotorSkill => (MOTOR_SKILLS as readonly string[]).includes(n));
  const comps = facetLeaves(sets, COMPONENT_ROOT_NAME)
    .filter((s) => s.members.includes(id))
    .map((s) => s.name)
    .filter((n): n is SkillRelatedComponent => (SKILL_RELATED_COMPONENTS as readonly string[]).includes(n));
  if (motors.length || comps.length) return { motorSkills: motors, skillRelatedComponents: comps };
  return { motorSkills: fallbackMotors || [], skillRelatedComponents: fallbackComps || [] };
}

function applyFacetMembership(base: string, id: string, motors: string[], comps: string[]): void {
  const sets = ensureDefaultSets(base);
  const motorWant = new Set(motors);
  const compWant = new Set(comps);
  for (const s of facetLeaves(sets, MOTOR_ROOT_NAME)) {
    const has = s.members.includes(id);
    const want = motorWant.has(s.name);
    if (want && !has) s.members = [...s.members, id];
    if (!want && has) s.members = s.members.filter((m) => m !== id);
  }
  for (const s of facetLeaves(sets, COMPONENT_ROOT_NAME)) {
    const has = s.members.includes(id);
    const want = compWant.has(s.name);
    if (want && !has) s.members = [...s.members, id];
    if (!want && has) s.members = s.members.filter((m) => m !== id);
  }
  writeSetsFile(base, sets);
}

export function listSets(base: string): MaterialSet[] {
  return ensureDefaultSets(base);
}

export function migrateFacetsIntoSets(base: string): { materials: number } {
  ensureDefaultSets(base);
  const files = loadAllMaterials(base);
  for (const m of files) {
    if ((m.motorSkills && m.motorSkills.length) || (m.skillRelatedComponents && m.skillRelatedComponents.length)) {
      applyFacetMembership(base, m.id, m.motorSkills || [], m.skillRelatedComponents || []);
    }
    writeMaterialFile(materialPath(base, m.id), m);
  }
  return { materials: files.length };
}

function knownMaterialIds(base: string): Set<string> {
  return new Set(loadAllMaterials(base).map((m) => m.id));
}

function normalizeSetMembers(base: string, members: unknown): string[] {
  if (!Array.isArray(members)) throw httpError(400, "members must be a list");
  const known = knownMaterialIds(base);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of members) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (!known.has(id)) throw httpError(400, "unknown material " + id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function createSet(
  base: string,
  input: { name?: string; note?: string; members?: string[]; parent?: string | null; origin?: SetOrigin },
): MaterialSet {
  const owned = enterWrite();
  try {
  const members = normalizeSetMembers(base, input.members || []);
  const sets = listSets(base);
  const parent = input.parent || null;
  if (parent && !sets.some((s) => s.id === parent)) throw httpError(400, "unknown parent " + parent);
  const set: MaterialSet = {
    id: nextSetId(sets),
    name: (input.name || "").trim() || members.join(" · ") || "Set",
    note: (input.note || "").trim(),
    members,
    parent,
    origin: input.origin || "teacher",
  };
  writeSetsFile(base, [...sets, set]);
  return set;
  } finally {
    leaveWrite(owned);
  }
}

export function updateSet(
  base: string,
  id: string,
  patch: { name?: string; note?: string; members?: string[]; parent?: string | null },
): MaterialSet {
  const owned = enterWrite();
  try {
  const sets = listSets(base);
  const i = sets.findIndex((s) => s.id === id);
  if (i < 0) throw httpError(404, "unknown set " + id);
  const cur = { ...sets[i]! };
  if (patch.members) cur.members = normalizeSetMembers(base, patch.members);
  if (patch.name !== undefined) cur.name = String(patch.name).trim() || cur.name;
  if (patch.note !== undefined) cur.note = String(patch.note).trim();
  if (patch.parent !== undefined) {
    const parent = patch.parent || null;
    if (parent && !sets.some((s) => s.id === parent)) throw httpError(400, "unknown parent " + parent);
    if (wouldCycle(sets, id, parent)) throw httpError(400, "parent would cycle");
    cur.parent = parent;
  }
  sets[i] = cur;
  writeSetsFile(base, sets);
  return cur;
  } finally {
    leaveWrite(owned);
  }
}

export function deleteSet(base: string, id: string): { ok: true } {
  const owned = enterWrite();
  try {
  const sets = listSets(base);
  if (!sets.some((s) => s.id === id)) throw httpError(404, "unknown set " + id);
  const next = sets
    .filter((s) => s.id !== id)
    .map((s) => (s.parent === id ? { ...s, parent: null } : s));
  writeSetsFile(base, next);
  return { ok: true };
  } finally {
    leaveWrite(owned);
  }
}

/** Members still to pin into a lane: drop excluded, already present, and duplicates. */
export function membersForLane(members: string[], excluded: string[] = [], already: string[] = []): string[] {
  const skip = new Set([...excluded, ...already]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of members) {
    if (skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getCalendar(base: string): CalendarData {
  const p = calendarPath(base);
  if (!existsSync(p)) return emptyCalendar();
  const data = hydrateCalendar((parseYaml(stripAgentNote(readFileSync(p, "utf8"))) || emptyCalendar()) as CalendarData);
  return {
    version: 1,
    foci: data.foci || [],
    workdays: data.workdays || [],
    schoolActivities: data.schoolActivities || [],
    entries: data.entries || [],
    classDays: data.classDays && Object.keys(data.classDays).length ? data.classDays : { G6: [], G7: [] },
  };
}

export function saveCalendar(base: string, data: CalendarData): CalendarData {
  const owned = enterWrite();
  try {
  const payload = hydrateCalendar(data);
  const check = validateCalendar(payload);
  if (!check.ok) throw httpError(400, check.message);
  ensureLibrary(base);
  const yamlBody = stringifyYaml({
    version: 1,
    foci: payload.foci,
    workdays: payload.workdays || [],
    schoolActivities: payload.schoolActivities || [],
    entries: payload.entries,
    classDays: payload.classDays && Object.keys(payload.classDays).length ? payload.classDays : { G6: [], G7: [] },
  });
  atomicWriteCalendar(calendarPath(base), agentNoteBlock(CALENDAR_AGENT_CALL) + yamlBody);
  return getCalendar(base);
  } finally {
    leaveWrite(owned);
  }
}

function periodPath(base: string, id: string) {
  return path.join(periodsDir(base), `${id}.md`);
}

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return 8 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtHm(mins: number): string {
  const n = ((Math.round(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(n / 60);
  const m = n % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

const LEGACY_CLOCKS: Record<(typeof LEGACY_LANES)[number], { start: string; end: string }> = {
  instant: { start: "08:00", end: "08:05" },
  skill: { start: "08:05", end: "08:25" },
  key: { start: "08:25", end: "08:40" },
};

function flattenPeriodActivities(data: Record<string, unknown>): PeriodActivity[] {
  const actsRaw = data.activities;
  if (Array.isArray(actsRaw) && actsRaw.length && typeof actsRaw[0] === "object" && actsRaw[0] && "id" in (actsRaw[0] as object)) {
    const first = actsRaw[0] as { start?: string };
    if (first.start) {
      return (actsRaw as PeriodActivity[]).map((a) => ({
        id: a.id,
        start: a.start,
        end: a.end,
        easier: a.easier,
        harder: a.harder,
        alts: a.alts,
      })).filter((a) => a.id);
    }
  }
  const keyed = (actsRaw && typeof actsRaw === "object" && !Array.isArray(actsRaw)
    ? actsRaw
    : {}) as Record<string, { id?: string; easier?: string[]; harder?: string[]; alts?: string[] }[]>;
  const times = (data.times && typeof data.times === "object" ? data.times : {}) as Record<string, { start?: string; end?: string }>;
  const out: PeriodActivity[] = [];
  for (const lane of LEGACY_LANES) {
    const listed = Array.isArray(keyed[lane]) ? keyed[lane] : [];
    const pin = typeof data[lane] === "string" ? String(data[lane]) : "";
    const rows = listed.length ? listed : pin ? [{ id: pin }] : [];
    const clock = times[lane] || LEGACY_CLOCKS[lane];
    const startM = minutesOf(clock.start || LEGACY_CLOCKS[lane].start);
    const endM = minutesOf(clock.end || LEGACY_CLOCKS[lane].end);
    const span = Math.max(1, endM - startM);
    const n = Math.max(1, rows.length);
    rows.forEach((row, i) => {
      if (!row?.id) return;
      const a = startM + Math.floor((span * i) / n);
      const b = i === n - 1 ? endM : startM + Math.floor((span * (i + 1)) / n);
      out.push({
        id: row.id,
        start: fmtHm(a),
        end: fmtHm(Math.max(a + 1, b)),
        easier: row.easier,
        harder: row.harder,
        alts: row.alts,
      });
    });
  }
  return out;
}

function parsePeriod(id: string, raw: string): Period {
  const { fm, body } = splitFrontmatter(raw);
  const data = (parseYaml(fm) || {}) as Record<string, unknown>;
  const plan = (String(data.plan || body || "")).trim() || undefined;
  return {
    id: String(data.id || id),
    date: String(data.date || ""),
    grade: (() => {
      const raw = typeof data.grade === "string" ? data.grade.trim() : "";
      if (raw && raw !== "all" && GRADE_TOKEN.test(raw)) return raw;
      const m = /-([A-Za-z][A-Za-z0-9]{0,7})$/.exec(id);
      if (m && m[1] !== "all" && GRADE_TOKEN.test(m[1])) return m[1];
      return "G6";
    })(),
    activities: flattenPeriodActivities(data),
    reflection: (data.reflection as Period["reflection"]) || { flags: [], text: "" },
    objective: String(data.objective || "").trim() || undefined,
    nextGoal: String(data.nextGoal || "").trim() || undefined,
    plan,
  };
}

function writePeriod(file: string, p: Period) {
  trackWrite(file);
  const front: Record<string, unknown> = {
    id: p.id,
    date: p.date,
    grade: p.grade,
  };
  if (p.activities?.length) front.activities = p.activities;
  front.reflection = p.reflection || { flags: [], text: "" };
  const objective = String(p.objective || "").trim();
  if (objective) front.objective = objective;
  const nextGoal = String(p.nextGoal || "").trim();
  if (nextGoal) front.nextGoal = nextGoal;
  const plan = (p.plan || "").trim();
  writeFileSync(file, agentNoteBlock(PERIOD_AGENT_CALL) + `---\n${stringifyYaml(front).trimEnd()}\n---\n${plan ? "\n" + plan + "\n" : ""}`);
}

function stampOne(file: string, call: string) {
  const raw = readFileSync(file, "utf8");
  if (raw.startsWith("<agent-note>")) return;
  writeFileSync(file, agentNoteBlock(call) + raw);
}

function stampHistoryJson(file: string) {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const row = data as Record<string, unknown>;
  if (row._agent === HISTORY_AGENT_NOTE) return;
  const { _agent: _drop, ...rest } = row;
  writeFileSync(file, JSON.stringify({ _agent: HISTORY_AGENT_NOTE, ...rest }, null, 2));
}

/** Puts the agent tool note on existing library files. Readers strip it before the page sees lesson text. */
export function stampLibraryAgentNotes(base: string) {
  withoutHistory(() => {
    for (const file of listMaterialFiles(base)) stampOne(file, MATERIAL_AGENT_CALL);
    const periods = periodsDir(base);
    if (existsSync(periods)) {
      for (const name of readdirSync(periods)) {
        if (name.endsWith(".md")) stampOne(path.join(periods, name), PERIOD_AGENT_CALL);
      }
    }
    const sets = setsPath(base);
    if (existsSync(sets)) stampOne(sets, SET_AGENT_CALL);
    const calendar = calendarPath(base);
    if (existsSync(calendar)) stampOne(calendar, CALENDAR_AGENT_CALL);
    const history = historyDir(base);
    if (!existsSync(history)) return;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".staging") continue;
        const child = path.join(dir, name);
        let st;
        try {
          st = statSync(child);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(child);
        else if (name.endsWith(".json")) stampHistoryJson(child);
      }
    };
    walk(history);
  });
}

export function getPeriod(base: string, id: string): Period | null {
  const file = periodPath(base, id);
  if (!existsSync(file)) return null;
  return parsePeriod(id, readFileSync(file, "utf8"));
}

export function savePeriod(base: string, id: string, p: Period): Period {
  const owned = enterWrite();
  try {
  if (p.id !== id) throw httpError(400, "body.id must match the path");
  if (!p.grade || p.grade === "all" || !GRADE_TOKEN.test(p.grade)) throw httpError(400, "invalid grade");
  ensureLibrary(base);
  writePeriod(periodPath(base, id), p);
  const saved = getPeriod(base, id)!;
  const mats = loadAllMaterials(base);
  const known = new Set(mats.map((m) => m.id));
  const names: Record<string, string> = {};
  for (const m of mats) names[m.id] = (m.name || m.id).replace(/\s+/g, " ").trim() || m.id;
  const order: string[] = [];
  const seenIds = new Set<string>();
  for (const a of saved.activities || []) {
    if (!a?.id || seenIds.has(a.id)) continue;
    seenIds.add(a.id);
    order.push(a.id);
  }
  const desired = new Map<string, { from: string; to: string; tag: string }>();
  for (let i = 1; i < order.length; i++) {
    const earlier = order[i - 1]!;
    const later = order[i]!;
    if (!known.has(earlier) || !known.has(later)) continue;
    const tag = saved.date + " " + saved.grade + " · in one class (the step after " + names[earlier] + ")";
    desired.set(later + "\0" + earlier, { from: later, to: earlier, tag });
  }
  const stamp = new RegExp(
    "^" + saved.date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " " + saved.grade.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " · in one class \\(the step after .+\\)$",
  );
  for (const L of listLinks(base)) {
    if (L.kind !== "related" || !stamp.test(L.tag || "")) continue;
    const hit = desired.get(L.from + "\0" + L.to);
    if (!hit) deleteLink(base, L.from, "related", L.to, L.tag);
    else if ((L.tag || "") !== hit.tag) updateLink(base, L.from, "related", L.to, { tag: hit.tag }, L.tag);
  }
  const now = listLinks(base);
  for (const d of desired.values()) {
    if (now.some((L) => L.kind === "related" && L.from === d.from && L.to === d.to && (L.tag || "") === d.tag)) continue;
    createLink(base, { from: d.from, kind: "related", to: d.to, note: "", tag: d.tag });
  }
  return saved;
  } finally {
    leaveWrite(owned);
  }
}

export function listPeriods(base: string, grade: string): Period[] {
  if (!grade || grade === "all" || !GRADE_TOKEN.test(grade)) throw httpError(400, "invalid grade");
  if (!existsSync(periodsDir(base))) return [];
  const suffix = "-" + grade + ".md";
  return readdirSync(periodsDir(base))
    .filter((n) => n.endsWith(suffix))
    .map((n) => parsePeriod(n.replace(/\.md$/, ""), readFileSync(path.join(periodsDir(base), n), "utf8")))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Used by seed.ts to write a material with a chosen id and relations. */
export function writeSeedMaterial(base: string, m: Material & { relations?: Relations }) {
  withoutHistory(() => {
    ensureLibrary(base);
    writeMaterialFile(materialPath(base, m.id), m);
  });
}

export function chatSessionDir(base: string): string {
  return path.join(libraryRoot(base), ".chat-session");
}

export function writeChatSessionFile(base: string, data: Buffer, filename: string, mimeType?: string): { path: string; name: string } {
  ensureLibrary(base);
  mkdirSync(chatSessionDir(base), { recursive: true });
  let ext = path.extname(filename || "").toLowerCase();
  if (!SKETCH_EXTS.has(ext) && mimeType) ext = SKETCH_MIME_EXT[mimeType.split(";")[0].trim().toLowerCase()] || ext;
  if (!SKETCH_EXTS.has(ext)) throw httpError(400, "file must be png, jpg, webp, gif, mp4, webm, or mov");
  const name = "s" + Date.now().toString(36) + ext;
  const dest = path.join(chatSessionDir(base), name);
  writeFileSync(dest, data);
  return { path: dest, name };
}

export function readChatSessionFile(base: string, name: string): Buffer | null {
  const safe = path.basename(name);
  if (!/^[\w.-]+$/.test(safe)) return null;
  const file = path.join(chatSessionDir(base), safe);
  if (!existsSync(file)) return null;
  return readFileSync(file);
}

export function clearChatSession(base: string) {
  const dir = chatSessionDir(base);
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    if (n === "chat.json") continue;
    unlinkSync(path.join(dir, n));
  }
}

const CHAT_LOG_TTL_MS = 24 * 60 * 60 * 1000;

export type ChatLogStep = {
  at: number;
  history: { role: string; content: string }[];
  ops: unknown[];
  chatSketch?: string;
  picks?: { id: string; why?: string; start?: string; end?: string; date?: string; grade?: string }[];
  objective?: string;
  dayObjectives?: Record<string, string>;
  fields?: { id: string; label?: string; value?: string; choices?: { id: string; name: string }[]; materialId?: string }[];
  periodTarget?: { id?: string; date?: string; grade?: string; create?: boolean };
  taskState?: import("../web/types.ts").ChatTaskState;
};

export type ChatSession = {
  id: string;
  title: string;
  writtenAt: number;
  steps: ChatLogStep[];
};

export type ChatLogFile = {
  writtenAt: number;
  currentId: string;
  sessions: ChatSession[];
  steps: ChatLogStep[];
};

export type ChatLogPut = {
  history?: { role: string; content: string }[];
  ops?: unknown[];
  chatSketch?: string;
  sessionId?: string;
  title?: string;
  currentId?: string;
  sessions?: ChatSession[];
};

function chatLogPath(base: string) {
  return path.join(chatSessionDir(base), "chat.json");
}

function newChatSessionId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function capChatSteps(steps: unknown): ChatLogStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((row) => {
    const s = row && typeof row === "object" ? (row as ChatLogStep) : { at: Date.now(), history: [], ops: [] };
    return {
      at: Number(s.at) || Date.now(),
      history: Array.isArray(s.history) ? s.history : [],
      ops: Array.isArray(s.ops) ? s.ops : [],
      chatSketch: s.chatSketch ? String(s.chatSketch) : undefined,
      picks: Array.isArray(s.picks) ? s.picks : undefined,
      objective: s.objective ? String(s.objective) : undefined,
      dayObjectives: s.dayObjectives && typeof s.dayObjectives === "object" ? s.dayObjectives : undefined,
      fields: Array.isArray((s as ChatLogStep).fields) ? (s as ChatLogStep).fields : undefined,
      periodTarget: (s as ChatLogStep).periodTarget,
      taskState: (s as ChatLogStep).taskState,
    };
  });
}

function emptyChatLog(): ChatLogFile {
  return { writtenAt: Date.now(), currentId: "", sessions: [], steps: [] };
}

function withCurrentSteps(log: Omit<ChatLogFile, "steps">): ChatLogFile {
  const current = log.sessions.find((s) => s.id === log.currentId) || log.sessions[0];
  return { ...log, steps: current ? current.steps : [] };
}

export function pruneChatLog(base: string): ChatLogFile {
  const file = chatLogPath(base);
  if (!existsSync(file)) return emptyChatLog();
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as ChatLogPut & { writtenAt?: number; steps?: ChatLogStep[] };
    const now = Date.now();
    let sessions: ChatSession[] = [];
    if (Array.isArray(data.sessions) && data.sessions.length) {
      sessions = data.sessions
        .filter((s) => s && now - Number(s.writtenAt || data.writtenAt || 0) <= CHAT_LOG_TTL_MS)
        .map((s) => ({
          id: String(s.id || newChatSessionId()),
          title: String(s.title || "Chat"),
          writtenAt: Number(s.writtenAt) || now,
          steps: capChatSteps(s.steps),
        }));
    } else {
      const writtenAt = Number(data.writtenAt) || 0;
      if (!writtenAt || now - writtenAt > CHAT_LOG_TTL_MS) {
        unlinkSync(file);
        return emptyChatLog();
      }
      const id = String(data.currentId || "s0");
      sessions = [{ id, title: "Chat", writtenAt, steps: capChatSteps(data.steps) }];
    }
    if (!sessions.length) {
      unlinkSync(file);
      return emptyChatLog();
    }
    let currentId = String(data.currentId || sessions[0]!.id);
    if (!sessions.some((s) => s.id === currentId)) currentId = sessions[0]!.id;
    const writtenAt = Math.max(...sessions.map((s) => s.writtenAt));
    return withCurrentSteps({ writtenAt, currentId, sessions });
  } catch {
    return emptyChatLog();
  }
}

export function readChatLog(base: string): ChatLogFile {
  return pruneChatLog(base);
}

export function writeChatLog(base: string, put: ChatLogPut): ChatLogFile {
  ensureLibrary(base);
  mkdirSync(chatSessionDir(base), { recursive: true });
  const cur = pruneChatLog(base);
  let sessions = Array.isArray(put.sessions)
    ? put.sessions.map((s) => ({
        id: String(s.id || newChatSessionId()),
        title: String(s.title || "Chat"),
        writtenAt: Number(s.writtenAt) || Date.now(),
        steps: capChatSteps(s.steps),
      }))
    : cur.sessions.map((s) => ({ ...s, steps: s.steps.slice() }));
  let currentId = String(put.currentId || put.sessionId || cur.currentId || "");
  if (!sessions.length) {
    const id = currentId || newChatSessionId();
    sessions = [{ id, title: put.title || "Chat", writtenAt: Date.now(), steps: [] }];
    currentId = id;
  }
  if (!sessions.some((s) => s.id === currentId)) currentId = sessions[0]!.id;
  const appending = !put.sessions && (put.history !== undefined || put.ops !== undefined || put.chatSketch !== undefined);
  if (appending) {
    const sess = sessions.find((s) => s.id === currentId)!;
    const next: ChatLogStep = {
      at: Date.now(),
      history: put.history || [],
      ops: put.ops || [],
      chatSketch: put.chatSketch,
    };
    const last = sess.steps[sess.steps.length - 1];
    const same =
      last &&
      JSON.stringify({ h: last.history, o: last.ops, c: last.chatSketch || "" }) ===
        JSON.stringify({ h: next.history, o: next.ops, c: next.chatSketch || "" });
    if (!same) {
      sess.steps = [...sess.steps, next];
      sess.writtenAt = Date.now();
      if (put.title) sess.title = put.title;
    }
  }
  const body = withCurrentSteps({
    writtenAt: Date.now(),
    currentId,
    sessions: sessions.map((s) => ({ ...s, steps: capChatSteps(s.steps) })),
  });
  if (!body.sessions.length) {
    const file = chatLogPath(base);
    if (existsSync(file)) unlinkSync(file);
    return emptyChatLog();
  }
  writeFileSync(chatLogPath(base), JSON.stringify({
    writtenAt: body.writtenAt,
    currentId: body.currentId,
    sessions: body.sessions,
  }));
  return body;
}
