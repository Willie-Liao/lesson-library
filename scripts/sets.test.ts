import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMaterial,
  createSet,
  deleteMaterial,
  deleteSet,
  listSets,
  membersForLane,
  updateSet,
} from "../server/store.ts";
import { MOTOR_ROOT_NAME, wouldCycle } from "../web/set-tree.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const root = mkdtempSync(path.join(tmpdir(), "flag-sets-"));
mkdirSync(path.join(root, "library", "materials"), { recursive: true });

createMaterial(root, { name: "Half-kneeling throw" });
createMaterial(root, { name: "Standing throw" });
createMaterial(root, { name: "Moving throw" });

const seeded = listSets(root);
assert(seeded.some((s) => s.name === MOTOR_ROOT_NAME && s.origin === "default"), "default motor root");
assert(seeded.filter((s) => s.origin === "default" || s.origin === "unit").length >= 8, "seeded tree");

try {
  createSet(root, { name: "Ghost", members: ["M1", "M99"] });
  throw new Error("expected 400 for unknown member");
} catch (err) {
  assert((err as { status?: number }).status === 400, "unknown member is HTTP 400");
}

const created = createSet(root, { name: "Throw chain", note: "warm-up", members: ["M2", "M1", "M1", "M3"] });
assert(created.name === "Throw chain", "name kept");
assert(created.note === "warm-up", "note kept");
assert(JSON.stringify(created.members) === JSON.stringify(["M2", "M1", "M3"]), "members deduped in order");
assert(listSets(root).some((s) => s.id === created.id), "list has created set");

const patched = updateSet(root, created.id, { name: "Throw warm-up", members: ["M1", "M2"] });
assert(patched.name === "Throw warm-up", "rename");
assert(JSON.stringify(patched.members) === JSON.stringify(["M1", "M2"]), "members replaced");

const pair = createSet(root, { name: "Pair", members: ["M2", "M3"] });
const motor = listSets(root).find((s) => s.name === MOTOR_ROOT_NAME)!;
updateSet(root, pair.id, { parent: motor.id });
assert(listSets(root).find((s) => s.id === pair.id)?.parent === motor.id, "parent set");
try {
  updateSet(root, motor.id, { parent: pair.id });
  throw new Error("expected cycle");
} catch (err) {
  assert((err as { status?: number }).status === 400, "cycle is HTTP 400");
  assert(wouldCycle(listSets(root), motor.id, pair.id), "wouldCycle agrees");
}

const one = createSet(root, { name: "Solo", members: ["M1"] });
assert(one.members.length === 1, "single member allowed");

const empty = createSet(root, { name: "Empty folder", members: [] });
assert(empty.members.length === 0, "empty container allowed");

const pruned = deleteMaterial(root, "M2");
assert(pruned.ok, "material deleted");
const after = listSets(root);
const s1 = after.find((s) => s.id === created.id);
const s2 = after.find((s) => s.id === pair.id);
assert(s1 && JSON.stringify(s1.members) === JSON.stringify(["M1"]), "created lost M2");
assert(s2 && JSON.stringify(s2.members) === JSON.stringify(["M3"]), "pair lost M2");

deleteSet(root, pair.id);
assert(listSets(root).every((s) => s.id !== pair.id), "pair gone");
assert(listSets(root).find((s) => s.id === empty.id)?.parent !== pair.id, "orphan reparented if needed");

try {
  deleteSet(root, "S9999");
  throw new Error("expected 404");
} catch (err) {
  assert((err as { status?: number }).status === 404, "unknown set is HTTP 404");
}

const add = membersForLane(["M1", "M2", "M4", "M1"], ["M4"], ["M2"]);
assert(JSON.stringify(add) === JSON.stringify(["M1"]), "exclude unchecked and already-in-lane, keep first copy");

{
  const dup = mkdtempSync(path.join(tmpdir(), "flag-sets-dup-"));
  mkdirSync(path.join(dup, "library", "materials"), { recursive: true });
  createMaterial(dup, { name: "Throw a" });
  const { writeFileSync } = await import("node:fs");
  const { stringify } = await import("yaml");
  writeFileSync(
    path.join(dup, "library", "_sets.yaml"),
    stringify({
      sets: [
        { id: "S3", name: "Motor skills", note: "", members: [], parent: null },
        { id: "S4", name: "Throwing", note: "", members: ["M1"], parent: null },
        { id: "S27", name: "Motor skills", note: "", members: [], parent: null, origin: "default" },
        { id: "S28", name: "Throwing", note: "", members: [], parent: "S27", origin: "unit" },
        { id: "S44", name: "Skill-related components", note: "", members: [], parent: null, origin: "default" },
        { id: "S45", name: "Agility", note: "", members: [], parent: "S44", origin: "default" },
      ],
    }),
  );
  const after = listSets(dup);
  assert(after.filter((s) => s.name === "Motor skills").length === 1, "one motor root");
  assert(after.filter((s) => s.name === "Throwing").length === 1, "one throwing leaf");
  const throwing = after.find((s) => s.name === "Throwing")!;
  assert(throwing.parent === after.find((s) => s.name === "Motor skills")!.id, "throwing nested");
  assert(throwing.members.includes("M1"), "members kept");
}

console.log("sets tests ok");
