import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync as unlinkFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyCalendar } from "../web/calendar-model.ts";
import type { CalendarData } from "../web/types.ts";
import { atomicWriteCalendar, getCalendar, getPeriod, listPeriods, saveCalendar, savePeriod, type CalendarFsOps } from "../server/store.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const root = mkdtempSync(path.join(tmpdir(), "flag-cal-"));
mkdirSync(path.join(root, "library"), { recursive: true });
const fociPath = path.join(root, "library", "_foci.yaml");
const fociBytes = "items:\n  - n: 1\n    text: Route running\nnow: 1\n";
writeFileSync(fociPath, fociBytes);

const missing = getCalendar(root);
assert(missing.version === 1 && missing.foci.length === 0 && missing.entries.length === 0, "missing file → emptyCalendar");

const payload: CalendarData = {
  version: 1,
  foci: [{ id: "f1", label: "Route running", color: "#3B82F6" }],
  workdays: [{ id: "w1", label: "In lieu", color: "#111827" }],
  schoolActivities: [],
  entries: [
    { id: "e1", kind: "focus", focusId: "f1", startDate: "2026-09-10", endDate: "2026-09-12", scope: "G6" },
    { id: "e2", kind: "workday", tagId: "w1", label: "In lieu", color: "#111827", startDate: "2026-09-12", endDate: "2026-09-12", scope: "all" },
  ],
  classDays: { G6: [1, 4], G7: [3, 5] },
};
const saved = saveCalendar(root, payload);
assert(JSON.stringify(saved) === JSON.stringify(payload), "save returns semantic calendar");
assert(JSON.stringify(getCalendar(root)) === JSON.stringify(payload), "reload equals saved");
const withUnused: CalendarData = {
  ...payload,
  schoolActivities: [{ id: "s-new", label: "Assembly", color: "#0EA5E9" }],
};
const savedUnused = saveCalendar(root, withUnused);
assert(savedUnused.schoolActivities.some((d) => d.id === "s-new"), "unused school tag returned");
assert(readFileSync(path.join(root, "library", "_calendar.yaml"), "utf8").includes("schoolActivities:"), "yaml lists schoolActivities");
assert(getCalendar(root).schoolActivities.some((d) => d.id === "s-new"), "unused school tag reloads");
assert(readFileSync(fociPath, "utf8") === fociBytes, "_foci.yaml unchanged after save");

const beforeInvalid = readFileSync(path.join(root, "library", "_calendar.yaml"));
try {
  saveCalendar(root, { version: 1, foci: [{ id: "f1", label: "x", color: "blue" }], workdays: [], schoolActivities: [], entries: [], classDays: { G6: [], G7: [] } });
  throw new Error("expected 400");
} catch (err) {
  const status = (err as { status?: number }).status;
  assert(status === 400, "invalid payload is HTTP 400");
}
assert(Buffer.compare(beforeInvalid, readFileSync(path.join(root, "library", "_calendar.yaml"))) === 0, "validation failure preserves bytes");
assert(readFileSync(fociPath, "utf8") === fociBytes, "_foci.yaml unchanged after invalid save");

const target = path.join(root, "library", "_atomic.yaml");
writeFileSync(target, "keep-me\n");
const prior = readFileSync(target);
let wroteTmp: string | null = null;
const ops: CalendarFsOps = {
  writeFileSync(file, contents) {
    wroteTmp = file;
    writeFileSync(file, contents);
  },
  renameSync() {
    throw new Error("forced rename failure");
  },
  unlinkSync(file) {
    unlinkFile(file);
  },
  existsSync,
};
try {
  atomicWriteCalendar(target, "new-contents\n", ops);
  throw new Error("expected rename failure");
} catch (err) {
  assert(err instanceof Error && err.message.includes("forced rename"), "rename error bubbles");
}
assert(Buffer.compare(prior, readFileSync(target)) === 0, "forced I/O failure preserves prior bytes");
const leftovers = readdirSync(path.join(root, "library")).filter((n) => n.includes(".tmp") || (wroteTmp && n === path.basename(wroteTmp)));
assert(leftovers.length === 0, "temp files cleaned after rename failure");
assert(!wroteTmp || !existsSync(wroteTmp), "tmp path gone");
assert(JSON.stringify(emptyCalendar()) === JSON.stringify({ version: 1, foci: [], workdays: [], schoolActivities: [], entries: [], classDays: { G6: [], G7: [] } }), "emptyCalendar sentinel");

mkdirSync(path.join(root, "library", "periods"), { recursive: true });
const g8 = savePeriod(root, "2026-09-10-G8", {
  id: "2026-09-10-G8",
  date: "2026-09-10",
  grade: "G8",
  reflection: { flags: [], text: "" },
});
assert(g8.grade === "G8", "savePeriod accepts G8");
assert(getPeriod(root, "2026-09-10-G8")!.grade === "G8", "parsePeriod keeps G8");
assert(listPeriods(root, "G8").length === 1 && listPeriods(root, "G8")[0].id === "2026-09-10-G8", "listPeriods G8");
const g6 = savePeriod(root, "2026-09-10-G6", {
  id: "2026-09-10-G6",
  date: "2026-09-10",
  grade: "G6",
  reflection: { flags: [], text: "" },
});
assert(g6.grade === "G6", "savePeriod still accepts G6");
try {
  listPeriods(root, "G-9");
  throw new Error("expected invalid grade");
} catch (err) {
  assert((err as { status?: number }).status === 400, "invalid grade token is 400");
}

const withG8 = saveCalendar(root, { ...payload, classDays: { G6: [1], G8: [4] } });
assert(JSON.stringify(withG8.classDays) === JSON.stringify({ G6: [1], G8: [4] }), "calendar keeps G8 classDays");

writeFileSync(path.join(root, "library", "_calendar.yaml"), "version: 1\nfoci: []\nworkdays: []\nschoolActivities: []\nentries: []\n");
const seeded = getCalendar(root);
assert(JSON.stringify(seeded.classDays) === JSON.stringify({ G6: [], G7: [] }), "missing classDays seeds G6 and G7");
const seededSave = saveCalendar(root, { ...payload, classDays: {} });
assert(JSON.stringify(seededSave.classDays) === JSON.stringify({ G6: [], G7: [] }), "empty classDays object seeds G6 and G7");

console.log("calendar-store tests ok");
