import type {
  CalendarData,
  CalendarEntry,
  CalendarFocusDefinition,
  CalendarMonthCell,
  CalendarScope,
  CalendarValidation,
  CalendarWeekSegment,
  FocusCalendarEntry,
  Grade,
  SchoolActivityCalendarEntry,
  WorkdayCalendarEntry,
} from "./types";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
export const GRADE_TOKEN = /^[A-Za-z][A-Za-z0-9]{0,7}$/;

export function emptyClassDays(): CalendarData["classDays"] {
  return { G6: [], G7: [] };
}

export function normalizeClassDays(raw: unknown): Record<string, number[]> {
  const days = (list: unknown) => {
    if (!Array.isArray(list)) return [];
    const out: number[] = [];
    for (const n of list) {
      const d = Number(n);
      if (d >= 1 && d <= 7 && out.indexOf(d) < 0) out.push(d);
    }
    return out.sort((a, b) => a - b);
  };
  const out: Record<string, number[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "all" || !GRADE_TOKEN.test(k)) continue;
    out[k] = days(v);
  }
  return out;
}

export function emptyCalendar(): CalendarData {
  return { version: 1, foci: [], workdays: [], schoolActivities: [], entries: [], classDays: emptyClassDays() };
}

export function parseIsoDate(iso: string): Date {
  const m = ISO.exec(iso);
  if (!m) throw new Error("invalid date: " + iso);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) {
    throw new Error("invalid date: " + iso);
  }
  return dt;
}

export function formatIsoDate(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function addDaysIso(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return formatIsoDate(d);
}

function mondayOf(iso: string): string {
  const d = parseIsoDate(iso);
  const js = d.getDay();
  const back = js === 0 ? 6 : js - 1;
  d.setDate(d.getDate() - back);
  return formatIsoDate(d);
}

function sundayOf(iso: string): string {
  return addDaysIso(mondayOf(iso), 6);
}

export function compareIso(a: string, b: string): number {
  return a.localeCompare(b);
}

export function minIso(a: string, b: string): string {
  return compareIso(a, b) <= 0 ? a : b;
}

export function maxIso(a: string, b: string): string {
  return compareIso(a, b) >= 0 ? a : b;
}

export function normalizeRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  parseIsoDate(startDate);
  parseIsoDate(endDate);
  if (compareIso(startDate, endDate) <= 0) return { startDate, endDate };
  return { startDate: endDate, endDate: startDate };
}

function newId(prefix: string): string {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** JS getDay 0=Sun → ISO weekday 1=Mon … 7=Sun (same as Settings classDays). */
export function isoWeekday(iso: string): number {
  const js = parseIsoDate(iso).getDay();
  return js === 0 ? 7 : js;
}

export function dateIsOff(iso: string, entries: CalendarEntry[] = []): boolean {
  return entries.some((e) => (e.kind === "workday" || e.kind === "schoolActivity") && e.startDate <= iso && iso <= e.endDate);
}

export type ClassDateSlot = { date: string; grade: string; id: string };

/** Next class-day ISOs for a grade from Settings classDays, skipping workday/school-activity ranges. */
export function listClassDates(opts: {
  classDays: Record<string, number[]>;
  grade: string;
  after: string;
  count: number;
  entries?: CalendarEntry[];
  includeAfter?: boolean;
}): ClassDateSlot[] {
  const grade = String(opts.grade || "").trim();
  if (!grade || grade === "all" || !GRADE_TOKEN.test(grade)) return [];
  const weekdays = (opts.classDays && opts.classDays[grade]) || [];
  if (!weekdays.length) return [];
  const want = Math.min(5, Math.max(0, Math.floor(Number(opts.count) || 0)));
  if (want < 1) return [];
  parseIsoDate(opts.after);
  const entries = opts.entries || [];
  const includeAfter = opts.includeAfter !== false;
  const out: ClassDateSlot[] = [];
  let cursor = includeAfter ? opts.after : addDaysIso(opts.after, 1);
  for (let i = 0; i < 400 && out.length < want; i++) {
    if (weekdays.indexOf(isoWeekday(cursor)) >= 0 && !dateIsOff(cursor, entries)) {
      out.push({ date: cursor, grade, id: cursor + "-" + grade });
    }
    cursor = addDaysIso(cursor, 1);
  }
  return out;
}

export function buildMonthCells(year: number, monthIndex: number): CalendarMonthCell[] {
  const first = new Date(year, monthIndex, 1);
  const start = parseIsoDate(mondayOf(formatIsoDate(first)));
  const cells: CalendarMonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      iso: formatIsoDate(d),
      inMonth: d.getMonth() === monthIndex,
      dow: d.getDay(),
    });
  }
  return cells;
}

export function filterEntriesForGrade(entries: CalendarEntry[], grade: Grade): CalendarEntry[] {
  return entries.filter((e) => e.scope === "all" || e.scope === grade);
}

export function splitRangesByWeek(range: { startDate: string; endDate: string }): CalendarWeekSegment[] {
  const { startDate, endDate } = normalizeRange(range.startDate, range.endDate);
  const out: CalendarWeekSegment[] = [];
  let cursor = startDate;
  while (compareIso(cursor, endDate) <= 0) {
    const weekEnd = minIso(sundayOf(cursor), endDate);
    out.push({ startDate: cursor, endDate: weekEnd });
    cursor = addDaysIso(weekEnd, 1);
  }
  return out;
}

function rangesOverlap(a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }): boolean {
  return compareIso(a.startDate, b.endDate) <= 0 && compareIso(b.startDate, a.endDate) <= 0;
}

export function assignOverlapLanes(entries: CalendarEntry[]): Record<string, number> {
  const ordered = entries.slice().sort((a, b) => compareIso(a.startDate, b.startDate) || a.id.localeCompare(b.id));
  const placed: { entry: CalendarEntry; lane: number }[] = [];
  const lanes: Record<string, number> = {};
  for (const entry of ordered) {
    let lane = 0;
    for (;;) {
      const taken = placed.some((p) => p.lane === lane && rangesOverlap(p.entry, entry));
      if (!taken) break;
      lane += 1;
    }
    placed.push({ entry, lane });
    lanes[entry.id] = lane;
  }
  return lanes;
}

function isScope(v: unknown): v is CalendarScope {
  return v === "all" || (typeof v === "string" && GRADE_TOKEN.test(v));
}

function checkDefs(list: unknown, field: string, seen: Set<string>): string | null {
  if (!Array.isArray(list)) return field + " required";
  for (const f of list) {
    if (!f || typeof f.id !== "string" || !f.id) return field + " id required";
    if (seen.has(f.id)) return "duplicate id";
    seen.add(f.id);
    if (typeof f.label !== "string" || !f.label.trim()) return field + " label required";
    if (typeof f.color !== "string" || !HEX.test(f.color)) return "tag color must be #RRGGBB";
  }
  return null;
}

function checkDate(iso: unknown, field: string): string | null {
  if (typeof iso !== "string" || !ISO.test(iso)) return "invalid date on " + field;
  try {
    parseIsoDate(iso);
    return null;
  } catch {
    return "invalid date on " + field;
  }
}

export function validateCalendar(data: CalendarData): CalendarValidation {
  if (!data || data.version !== 1) return { ok: false, message: "version must be 1" };
  if (!Array.isArray(data.entries)) return { ok: false, message: "entries required" };
  const seen = new Set<string>();
  const fErr = checkDefs(data.foci, "focus", seen);
  if (fErr) return { ok: false, message: fErr };
  const wErr = checkDefs(data.workdays || [], "workday", seen);
  if (wErr) return { ok: false, message: wErr };
  const aErr = checkDefs(data.schoolActivities || [], "school activity", seen);
  if (aErr) return { ok: false, message: aErr };
  const workIds = new Set((data.workdays || []).map((d) => d.id));
  const schoolIds = new Set((data.schoolActivities || []).map((d) => d.id));
  const seenEntry = new Set<string>();
  for (const e of data.entries) {
    if (!e || typeof e.id !== "string" || !e.id) return { ok: false, message: "entry id required" };
    if (seenEntry.has(e.id)) return { ok: false, message: "duplicate entry id" };
    seenEntry.add(e.id);
    if (!isScope(e.scope)) return { ok: false, message: "invalid scope" };
    const sErr = checkDate(e.startDate, "startDate");
    if (sErr) return { ok: false, message: sErr };
    const eErr = checkDate(e.endDate, "endDate");
    if (eErr) return { ok: false, message: eErr };
    if (compareIso(e.startDate, e.endDate) > 0) return { ok: false, message: "range end before start" };
    if (e.kind === "focus") {
      if (!e.focusId || !data.foci.some((f) => f.id === e.focusId)) return { ok: false, message: "focus reference missing" };
    } else if (e.kind === "workday") {
      if (typeof e.label !== "string" || !e.label.trim()) return { ok: false, message: "workday label required" };
      if (typeof e.color !== "string" || !HEX.test(e.color)) return { ok: false, message: "workday color must be #RRGGBB" };
      if (!e.tagId || !workIds.has(e.tagId)) return { ok: false, message: "workday tag missing" };
    } else if (e.kind === "schoolActivity") {
      if (typeof e.label !== "string" || !e.label.trim()) return { ok: false, message: "school activity label required" };
      if (typeof e.color !== "string" || !HEX.test(e.color)) return { ok: false, message: "school activity color must be #RRGGBB" };
      if (!e.tagId || !schoolIds.has(e.tagId)) return { ok: false, message: "school activity tag missing" };
    } else {
      return { ok: false, message: "unknown entry kind" };
    }
  }
  return { ok: true };
}

export function createFocusEntry(
  calendar: CalendarData,
  selectedFocusId: string,
  startDate: string,
  endDate: string,
  grade: Grade,
): FocusCalendarEntry {
  if (!selectedFocusId || !calendar.foci.some((f) => f.id === selectedFocusId)) {
    throw new Error("a focus must be selected");
  }
  const range = normalizeRange(startDate, endDate);
  return {
    id: newId("focus"),
    kind: "focus",
    focusId: selectedFocusId,
    startDate: range.startDate,
    endDate: range.endDate,
    scope: grade,
  };
}

export function createWorkdayEntry(
  calendar: CalendarData,
  tagId: string,
  startDate: string,
  endDate: string,
): WorkdayCalendarEntry {
  const def = (calendar.workdays || []).find((d) => d.id === tagId);
  if (!def) throw new Error("a work day tag must be selected");
  const range = normalizeRange(startDate, endDate);
  return {
    id: newId("workday"),
    kind: "workday",
    tagId: def.id,
    label: def.label,
    color: def.color,
    startDate: range.startDate,
    endDate: range.endDate,
    scope: "all",
  };
}

export function createSchoolActivityEntry(
  calendar: CalendarData,
  tagId: string,
  startDate: string,
  endDate: string,
): SchoolActivityCalendarEntry {
  const def = (calendar.schoolActivities || []).find((d) => d.id === tagId);
  if (!def) throw new Error("a school activity tag must be selected");
  const range = normalizeRange(startDate, endDate);
  return {
    id: newId("school"),
    kind: "schoolActivity",
    tagId: def.id,
    label: def.label,
    color: def.color,
    startDate: range.startDate,
    endDate: range.endDate,
    scope: "all",
  };
}

export function cloneCalendar(data: CalendarData): CalendarData {
  return {
    version: 1,
    foci: (data.foci || []).map((f) => ({ ...f })),
    workdays: (data.workdays || []).map((f) => ({ ...f })),
    schoolActivities: (data.schoolActivities || []).map((f) => ({ ...f })),
    entries: (data.entries || []).map((e) => ({ ...e })),
    classDays: normalizeClassDays(data.classDays),
  };
}

export function hydrateCalendar(raw: CalendarData): CalendarData {
  const next = cloneCalendar({
    version: 1,
    foci: raw.foci || [],
    workdays: raw.workdays || [],
    schoolActivities: raw.schoolActivities || [],
    entries: raw.entries || [],
    classDays: raw.classDays,
  });
  const ensure = (kind: "workday" | "schoolActivity", list: CalendarFocusDefinition[]) => {
    for (const e of next.entries) {
      if (e.kind !== kind) continue;
      const row = e as WorkdayCalendarEntry | SchoolActivityCalendarEntry;
      let def = list.find((d) => d.id === row.tagId);
      if (!def) {
        def = {
          id: (typeof row.tagId === "string" && row.tagId.trim()) ? row.tagId.trim() : kind + "-tag-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
          label: row.label || (kind === "workday" ? "Work day" : "School activity"),
          color: HEX.test(row.color || "") ? row.color : (kind === "workday" ? "#111827" : "#6B7280"),
        };
        list.push(def);
      }
      row.tagId = def.id;
      row.label = def.label;
      row.color = def.color;
    }
  };
  ensure("workday", next.workdays);
  ensure("schoolActivity", next.schoolActivities);
  return next;
}

/** One chip for the day's activity stack. extra = remaining activities. */
export type CalendarLessonChip = { name: string; extra: number };

export function lessonChipsFromSlotIds(
  ids: string[],
  nameOf: (id: string) => string,
): CalendarLessonChip[] {
  if (!ids.length) return [];
  const first = ids[0]!;
  return [{ name: nameOf(first) || first, extra: Math.max(0, ids.length - 1) }];
}
