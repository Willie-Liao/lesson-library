import {
  childrenOf,
  effectiveMembers,
  levelOf,
  maxLevel,
  pathLabel,
  roots,
  sharesLeafSet,
  treeRows,
  wouldCycle,
} from "../web/set-tree.ts";
import type { MaterialSet } from "../web/types.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const sets: MaterialSet[] = [
  { id: "S3", name: "Motor skills", note: "", members: [], parent: null, origin: "default" },
  { id: "S4", name: "Throwing", note: "", members: ["M1", "M2"], parent: "S3", origin: "unit" },
  { id: "S5", name: "Catching", note: "", members: ["M4"], parent: "S3", origin: "unit" },
  { id: "S6", name: "Skill-related components", note: "", members: [], parent: null, origin: "default" },
  { id: "S7", name: "Agility", note: "", members: ["M8"], parent: "S6", origin: "default" },
];

assert(childrenOf(sets, "S3").map((s) => s.name).join(",") === "Catching,Throwing", "children sorted");
assert(levelOf(sets, "S3") === 1 && levelOf(sets, "S4") === 2, "levels");
assert(pathLabel(sets, "S4") === "Motor skills - Throwing", "path label");
assert([...effectiveMembers(sets, "S3")].sort().join(",") === "M1,M2,M4", "root effective members");
assert(effectiveMembers(sets, "S4").join(",") === "M1,M2", "leaf effective members");
assert(sharesLeafSet(sets, "M1", "M2") && !sharesLeafSet(sets, "M1", "M4"), "share leaf");
assert(wouldCycle(sets, "S3", "S4") && !wouldCycle(sets, "S4", "S6"), "cycle detect");
assert(maxLevel(sets) === 2, "max level");
assert(treeRows(sets)[0]?.set.name === "Motor skills", "tree starts at Motor skills");

const names = treeRows(sets).map((r) => r.set.name);
assert(names[0] === "Motor skills", "Motor skills is first-level first");
assert(names[1] === "Catching" && names[2] === "Throwing", "motor leaves indented after parent");
assert(names[3] === "Skill-related components" && names[4] === "Agility", "skill tree after motor");
assert(treeRows(sets)[1]?.depth === 1 && treeRows(sets)[0]?.depth === 0, "second level is depth 1");
assert(names.includes("Throwing") && names.includes("Agility"), "leaves present");

const withCustom: MaterialSet[] = [
  ...sets,
  { id: "S1", name: "AAA custom", note: "", members: ["M1"], parent: null, origin: "teacher" },
];
assert(treeRows(withCustom)[0]?.set.name === "Motor skills", "custom sets sort after taxonomy roots");

assert(
  roots(withCustom)
    .map((s) => s.id)
    .join(",") === "S3,S6,S1",
  "default roots include all parentless sets",
);
assert(
  roots(withCustom, "first")
    .map((s) => s.id)
    .join(",") === "S3,S6",
  "first-level roots have empty members",
);
assert(
  roots(withCustom, "independent")
    .map((s) => s.id)
    .join(",") === "S1",
  "independent roots have members",
);

console.log("set-tree tests ok");
