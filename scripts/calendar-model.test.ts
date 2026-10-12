import {
  addDaysIso,
  assignOverlapLanes,
  buildMonthCells,
  createFocusEntry,
  createSchoolActivityEntry,
  createWorkdayEntry,
  emptyCalendar,
  filterEntriesForGrade,
  formatIsoDate,
  hydrateCalendar,
  listClassDates,
  lessonChipsFromSlotIds,
  normalizeClassDays,
  parseIsoDate,
  splitRangesByWeek,
  validateCalendar,
} from "../web/calendar-model.ts";
import type { CalendarData, CalendarFocusDefinition } from "../web/types.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const foci: CalendarFocusDefinition[] = [
  { id: "f1", label: "Route running", color: "#3B82F6" },
  { id: "f2", label: "Catching", color: "#F59E0B" },
];

function cal(partial: Partial<CalendarData> = {}): CalendarData {
  return { version: 1, foci: foci.slice(), workdays: [], schoolActivities: [], entries: [], classDays: { G6: [], G7: [] }, ...partial };
}

assert(emptyCalendar().version === 1, "empty version 1");
assert(emptyCalendar().foci.length === 0 && emptyCalendar().entries.length === 0, "empty arrays");

const d = parseIsoDate("2026-09-10");
assert(d.getFullYear() === 2026 && d.getMonth() === 8 && d.getDate() === 10, "parse local date-only");
assert(formatIsoDate(d) === "2026-09-10", "format local date-only");
assert(formatIsoDate(new Date(2026, 8, 10, 23, 30)) === "2026-09-10", "UTC+8 evening stays same calendar day");
assert(addDaysIso("2026-09-10", 1) === "2026-09-11", "addDaysIso");

const sep = buildMonthCells(2026, 8);
assert(sep.length === 42, "six-week Monday grid");
assert(sep[0].iso === "2026-08-31", "Sep 2026 starts Monday 31 Aug");
assert(sep[0].dow === 1 && sep[6].dow === 0, "Monday-first week");
assert(sep.filter((c) => c.inMonth).length === 30, "September has 30 in-month days");
assert(sep[10].iso === "2026-09-10" && sep[10].inMonth, "10 Sep is in month");
assert(sep[10].dow === 4, "10 Sep 2026 is Thursday (JS dow 4 = ISO 4)");
assert(sep[41].iso === "2026-10-11", "grid includes trailing October days");

const days = normalizeClassDays({ G6: [1], G8: [5], "G-9": [2], "": [3], G7: [1, 1, 8, 3] });
assert(JSON.stringify(days.G6) === JSON.stringify([1]), "keeps G6 weekdays");
assert(JSON.stringify(days.G8) === JSON.stringify([5]), "keeps extra grade G8");
assert(days["G-9"] === undefined && days[""] === undefined, "drops invalid grade keys");
assert(JSON.stringify(days.G7) === JSON.stringify([1, 3]), "dedupes and drops weekday 8");

const oct = buildMonthCells(2026, 9);
assert(oct[0].iso === "2026-09-28", "Oct 2026 Monday start");
assert(oct.find((c) => c.iso === "2026-10-01")?.inMonth === true, "1 Oct in month");

const ok = validateCalendar(cal({
  workdays: [{ id: "w1", label: "Work day in lieu", color: "#111827" }],
  schoolActivities: [{ id: "s1", label: "Sports Day", color: "#6B7280" }],
  entries: [
    { id: "e1", kind: "focus", focusId: "f1", startDate: "2026-09-10", endDate: "2026-09-24", scope: "G6" },
    { id: "e2", kind: "workday", tagId: "w1", label: "Work day in lieu", color: "#111827", startDate: "2026-09-12", endDate: "2026-09-14", scope: "all" },
    { id: "e3", kind: "schoolActivity", tagId: "s1", label: "Sports Day", color: "#6B7280", startDate: "2026-11-02", endDate: "2026-11-20", scope: "all" },
  ],
}));
assert(ok.ok === true, "valid calendar");

function expectInvalid(data: CalendarData, needle: string) {
  const r = validateCalendar(data);
  assert(!r.ok && r.message.includes(needle), "invalid: " + needle + " got " + (r.ok ? "ok" : r.message));
}

expectInvalid(cal({ version: 2 as 1 }), "version");
expectInvalid(cal({ foci: [{ id: "f1", label: "x", color: "blue" }] }), "color");
expectInvalid(cal({ foci: [{ id: "f1", label: "", color: "#3B82F6" }] }), "label");
expectInvalid(cal({
  entries: [{ id: "e1", kind: "focus", focusId: "missing", startDate: "2026-09-10", endDate: "2026-09-10", scope: "G6" }],
}), "focus");
expectInvalid(cal({
  entries: [{ id: "e1", kind: "focus", focusId: "f1", startDate: "2026-09-24", endDate: "2026-09-10", scope: "G6" }],
}), "range");
expectInvalid(cal({
  entries: [{ id: "e1", kind: "workday", tagId: "missing", label: "In lieu", color: "#111827", startDate: "2026-09-10", endDate: "2026-09-11", scope: "all" }],
}), "workday");
expectInvalid(cal({
  entries: [{ id: "e1", kind: "focus", focusId: "f1", startDate: "2026-13-01", endDate: "2026-13-01", scope: "G6" }],
}), "date");

try {
  createFocusEntry(cal(), "", "2026-09-10", "2026-09-12", "G6");
  throw new Error("expected no-selected-focus");
} catch (err) {
  assert(err instanceof Error && /focus/i.test(err.message), "no selected focus rejected");
}

const one = createFocusEntry(cal(), "f1", "2026-09-24", "2026-09-10", "G6");
assert(one.kind === "focus" && one.focusId === "f1", "focus references selected id");
assert(one.startDate === "2026-09-10" && one.endDate === "2026-09-24", "inclusive range normalized");
assert(one.scope === "G6", "focus scoped to selected grade");

const tagged = cal({
  workdays: [{ id: "w1", label: "Work day in lieu", color: "#111827" }],
  schoolActivities: [{ id: "s1", label: "Sports Day", color: "#6B7280" }],
});
const work = createWorkdayEntry(tagged, "w1", "2026-09-14", "2026-09-12");
assert(work.kind === "workday" && work.scope === "all", "workday defaults to all grades");
assert(work.startDate === "2026-09-12" && work.endDate === "2026-09-14", "workday range normalized");
assert(work.tagId === "w1" && work.color === "#111827", "workday copies selected tag");

const school = createSchoolActivityEntry(tagged, "s1", "2026-11-20", "2026-11-02");
assert(school.kind === "schoolActivity" && school.scope === "all", "school activity defaults to all");
assert(school.startDate === "2026-11-02" && school.endDate === "2026-11-20", "school range normalized");
assert(school.tagId === "s1" && school.color === "#6B7280", "school copies selected tag");

const hydratedFromMarks = hydrateCalendar({
  version: 1,
  foci: [],
  workdays: [],
  schoolActivities: [{ id: "unused-new", label: "New tag", color: "#0EA5E9" }],
  entries: [{
    id: "e3",
    kind: "schoolActivity",
    tagId: "keep-this-id",
    label: "Sports Day",
    color: "#6B7280",
    startDate: "2026-12-15",
    endDate: "2026-12-18",
    scope: "all",
  }],
});
assert(hydratedFromMarks.schoolActivities.some((d) => d.id === "unused-new"), "unused school tag kept");
assert(hydratedFromMarks.schoolActivities.some((d) => d.id === "keep-this-id"), "entry tagId reused");
const schoolEntry = hydratedFromMarks.entries.find((e) => e.kind === "schoolActivity");
assert(schoolEntry && "tagId" in schoolEntry && schoolEntry.tagId === "keep-this-id", "entry tagId not reminted");

const mixed = [
  { id: "g6", kind: "focus" as const, focusId: "f1", startDate: "2026-09-10", endDate: "2026-09-12", scope: "G6" as const },
  { id: "g7", kind: "focus" as const, focusId: "f2", startDate: "2026-09-10", endDate: "2026-09-12", scope: "G7" as const },
  work,
  school,
];
const g6 = filterEntriesForGrade(mixed, "G6");
assert(g6.some((e) => e.id === "g6") && !g6.some((e) => e.id === "g7"), "grade foci filtered");
assert(g6.some((e) => e.id === work.id) && g6.some((e) => e.id === school.id), "shared events visible to G6");
const g7 = filterEntriesForGrade(mixed, "G7");
assert(g7.some((e) => e.id === "g7") && !g7.some((e) => e.id === "g6"), "G7 does not see G6 focus");

const wrap = splitRangesByWeek({ startDate: "2026-09-10", endDate: "2026-09-16" });
assert(wrap.length === 2, "cross-week splits");
assert(wrap[0].startDate === "2026-09-10" && wrap[0].endDate === "2026-09-13", "Thu–Sun first week Mon-start");
assert(wrap[1].startDate === "2026-09-14" && wrap[1].endDate === "2026-09-16", "Mon–Wed second week");

const monthEdge = splitRangesByWeek({ startDate: "2026-09-30", endDate: "2026-10-06" });
assert(monthEdge.length === 2, "cross-month week wrap");
assert(monthEdge[0].startDate === "2026-09-30" && monthEdge[0].endDate === "2026-10-04", "Wed–Sun first week");
assert(monthEdge[1].startDate === "2026-10-05" && monthEdge[1].endDate === "2026-10-06", "Mon–Tue second week");

const lanes = assignOverlapLanes([
  { id: "a", kind: "focus", focusId: "f1", startDate: "2026-09-10", endDate: "2026-09-16", scope: "G6" },
  { id: "b", kind: "focus", focusId: "f2", startDate: "2026-09-14", endDate: "2026-09-18", scope: "G6" },
  { id: "c", kind: "schoolActivity", tagId: "s1", label: "CAS", color: "#6B7280", startDate: "2026-09-10", endDate: "2026-09-11", scope: "all" },
]);
assert(lanes.a === 0, "first range lane 0");
assert(lanes.b === 1, "overlapping later range lane 1");
assert(lanes.c === 1 || lanes.c === 0, "school activity also gets a lane");
assert(lanes.a !== lanes.b, "overlapping foci do not share a lane");
assert(JSON.stringify(assignOverlapLanes([
  { id: "a", kind: "focus", focusId: "f1", startDate: "2026-09-10", endDate: "2026-09-12", scope: "G6" },
  { id: "b", kind: "focus", focusId: "f2", startDate: "2026-09-14", endDate: "2026-09-15", scope: "G6" },
])) === JSON.stringify({ a: 0, b: 0 }), "non-overlapping share lane 0");

const names: Record<string, string> = { M1: "Half-kneeling throw", M2: "Standing throw", M9: "Crazy Catch" };
const chips = lessonChipsFromSlotIds(
  ["M1", "M2", "M9"],
  (id) => names[id] || id,
);
assert(chips.length === 1, "one chip for the stack");
assert(chips[0].name === "Half-kneeling throw" && chips[0].extra === 2, "first name + extras");
assert(lessonChipsFromSlotIds([], (id) => id).length === 0, "blank period has no chips");

{
  const sports = {
    id: "e-sports",
    kind: "schoolActivity" as const,
    tagId: "s1",
    label: "Sports Day",
    color: "#6B7280",
    startDate: "2026-09-25",
    endDate: "2026-09-25",
    scope: "all" as const,
  };
  const slots = listClassDates({
    classDays: { G6: [], G7: [3, 5] },
    grade: "G7",
    after: "2026-09-21",
    count: 5,
    entries: [sports],
  });
  assert(slots.map((s) => s.date).join(",") === "2026-09-23,2026-09-30,2026-10-02,2026-10-07,2026-10-09", "G7 Wed/Fri after Monday, skip Sports Day Fri 25");
  assert(slots.every((s) => s.grade === "G7" && s.id === s.date + "-G7"), "slot ids");
  assert(listClassDates({ classDays: { G6: [1], G7: [] }, grade: "G7", after: "2026-09-21", count: 3 }).length === 0, "empty arrangement");
}

console.log("calendar-model tests ok");
