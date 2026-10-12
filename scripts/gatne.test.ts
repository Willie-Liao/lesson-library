import { hopColumns } from "../web/graph-model.ts";
import { suggestRelated } from "../web/gatne.ts";
import type { Link, Material, MaterialSet } from "../web/types.ts";

function mat(id: string, extra: Partial<Material> = {}): Material {
  return {
    id,
    name: extra.name || id,
    look: extra.look || "",
    motorSkills: extra.motorSkills || [],
    skillRelatedComponents: extra.skillRelatedComponents || [],
    duration: extra.duration,
    notes: extra.notes,
    explanation: extra.explanation,
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const materials: Material[] = [
  mat("M1", { name: "Half-kneeling throw", look: "overhand throw follow through", duration: 5 }),
  mat("M2", { name: "Standing throw", look: "overhand throw follow through", duration: 5 }),
  mat("M3", { name: "Two-step drop", look: "drop back and throw", duration: 20 }),
  mat("M4", { name: "Catch in place", look: "hands out catch", duration: 20 }),
  mat("M84", { name: "Karaoke", look: "lateral grapevine steps", duration: 5 }),
  mat("M9", { name: "Crazy Catch", look: "scrambled catch contest", duration: 15 }),
];

const pos = new Map([
  ["M1", { x: 0, y: 0 }],
  ["M2", { x: 1, y: 0 }],
  ["M3", { x: 2, y: 1 }],
  ["M4", { x: 80, y: 80 }],
  ["M84", { x: 90, y: 0 }],
  ["M9", { x: 100, y: 100 }],
]);

const isolated = suggestRelated("M2", materials, [], pos);
assert(isolated.length > 0, "isolated node still gets suggestions");
assert(isolated.length <= 7, "top 7 by closeness");
assert(isolated.every((x) => x.id !== "M2"), "suggestions never include self");
assert(isolated[0]!.id === "M1", "shared look + nearby map ranks standing vs kneeling first");
assert(isolated.every((x, i) => i === 0 || (isolated[i - 1]!.score || 0) >= (x.score || 0)), "ranked high closeness down");
assert(isolated.some((x) => x.note === "suggested"), "suggestions are marked");

const farIdx = isolated.findIndex((x) => x.id === "M9");
const nearIdx = isolated.findIndex((x) => x.id === "M1");
assert(nearIdx >= 0 && (farIdx < 0 || nearIdx < farIdx), "true throw neighbor ranks above a far catch card");

const karaokeIdx = isolated.findIndex((x) => x.id === "M84");
assert(nearIdx < karaokeIdx || karaokeIdx < 0, "shared look ranks above karaoke even with empty motor skills");

const explMats: Material[] = [
  mat("A", { name: "A", explanation: "partners toss and catch in a small square", duration: 10 }),
  mat("B", { name: "B", explanation: "partners toss and catch in a small square", duration: 10 }),
  mat("C", { name: "C", look: "karaoke across the grid", duration: 10 }),
];
const explPos = new Map([
  ["A", { x: 0, y: 0 }],
  ["B", { x: 50, y: 50 }],
  ["C", { x: 1, y: 0 }],
]);
const explRank = suggestRelated("A", explMats, [], explPos);
assert(explRank[0]!.id === "B", "explanation-only text encodes and ranks the matching card first");

const notesMats: Material[] = [
  mat("A", { name: "A", notes: "partners toss and catch in a small square", duration: 10 }),
  mat("B", { name: "B", notes: "partners toss and catch in a small square", duration: 10 }),
  mat("C", { name: "C", look: "karaoke across the grid", duration: 10 }),
];
const notesRank = suggestRelated("A", notesMats, [], explPos);
assert(notesRank[0]!.id === "B", "notes-only dual-read encodes like explanation");

const setMats: Material[] = [
  mat("M2", { name: "Card", look: "", duration: 5 }),
  mat("M3", { name: "Card", look: "", duration: 5 }),
  mat("M84", { name: "Card", look: "", duration: 5 }),
];
const setPos = new Map([
  ["M2", { x: 0, y: 0 }],
  ["M84", { x: 0.1, y: 0 }],
  ["M3", { x: 100, y: 100 }],
]);
const throwSet: MaterialSet[] = [{ id: "S1", name: "Throw pack", note: "", members: ["M2", "M3"] }];
const withoutSet = suggestRelated("M2", setMats, [], setPos);
assert(withoutSet[0]!.id === "M84", "nearby map wins when sets are omitted");
const setRank = suggestRelated("M2", setMats, [], setPos, 7, throwSet);
assert(setRank[0]!.id === "M3", "shared leaf set ranks far co-member above nearby outsider");

const related: Link[] = [{ from: "M2", kind: "related", to: "M4", note: "", tag: "throw and catch" }];
const cols = hopColumns("M2", related, materials, pos, throwSet);
assert(cols.alts[0]!.id === "M4", "true related hop ranks first in Also");
assert(cols.alts[0]!.note !== "suggested", "real related is not a suggestion");
assert(cols.alts.filter((x) => x.note === "suggested").length <= 7, "at most 7 suggestions");
assert(!cols.alts.some((x) => x.id === "M2"), "Also never lists self");
assert(cols.easier.length === 0 && cols.harder.length === 0, "no chain hops on this fixture");

const chain: Link[] = [{ from: "M1", kind: "progression", to: "M2", note: "" }];
const m1 = hopColumns("M1", chain, materials, pos);
assert(!m1.alts.some((x) => x.id === "M2"), "harder hop is not also a suggestion");
assert(m1.alts.every((x) => x.note === "suggested" || x.note === ""), "Also is suggestions when no related");
assert(m1.alts.length <= 7, "Also is capped");

console.log("gatne tests ok");
