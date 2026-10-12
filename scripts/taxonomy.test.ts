import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOTOR_SKILLS,
  SKILL_RELATED_COMPONENTS,
  parseMotorSkills,
  parseSkillRelatedComponents,
} from "../web/material-taxonomy.ts";
import { createMaterial, listMaterials, updateMaterial } from "../server/store.ts";
import { SKILL_FACET_SEED } from "./skill-facet-map.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(parseMotorSkills(undefined, "drop").length === 0, "missing motors → []");
assert(parseSkillRelatedComponents(null, "drop").length === 0, "missing components → []");
assert(JSON.stringify(parseMotorSkills(["Throwing", "Throwing", "Catching"], "drop")) === JSON.stringify(["Throwing", "Catching"]), "dedupe motors");
assert(parseMotorSkills(["Hands"], "drop").length === 0, "unknown motors dropped on read");
try {
  parseMotorSkills(["Hands"], "reject");
  throw new Error("expected reject");
} catch (err) {
  assert(err instanceof Error && err.message.includes("unknown motor skill"), "reject unknown motor");
}
try {
  parseSkillRelatedComponents(["Flexibility"], "reject");
  throw new Error("expected reject");
} catch (err) {
  assert(err instanceof Error && err.message.includes("unknown skill-related component"), "reject unknown component");
}

assert(
  JSON.stringify(parseMotorSkills(["catching", "THROWING"], "reject")) === JSON.stringify(["Catching", "Throwing"]),
  "motor skills match catalog case-insensitively",
);
assert(
  JSON.stringify(parseSkillRelatedComponents(["reaction time", "agility"], "reject")) === JSON.stringify(["Reaction Time", "Agility"]),
  "components match catalog case-insensitively",
);
assert(parseSkillRelatedComponents(["decision making"], "drop").length === 0, "unknown component dropped");

const root = mkdtempSync(path.join(tmpdir(), "flag-tax-"));
mkdirSync(path.join(root, "library", "materials"), { recursive: true });
try {
  const created = createMaterial(root, {
    name: "Standing throw",
    look: "Catchable",
    motorSkills: ["Throwing", "Catching"],
    skillRelatedComponents: ["Coordination"],
  });
  assert(created.id === "M1", "first id is M1");
  const same = (a: string[], b: string[]) => [...a].sort().join("\0") === [...b].sort().join("\0");
  assert(same(created.motorSkills, ["Throwing", "Catching"]), "create motors");
  assert(JSON.stringify(created.skillRelatedComponents) === JSON.stringify(["Coordination"]), "create components");
  const raw = readFileSync(path.join(root, "library", "materials", "M1.md"), "utf8");
  assert(!raw.includes("motorSkills:"), "did not write motorSkills");
  assert(!raw.includes("skillRelatedComponents:"), "did not write components");
  assert(!/^body:/m.test(raw.split("\n---")[0]), "did not write body");

  const empty = createMaterial(root, { name: "A paper" });
  assert(empty.motorSkills.length === 0 && empty.skillRelatedComponents.length === 0, "defaults empty");

  try {
    createMaterial(root, { name: "Bad", motorSkills: ["Hands"] });
    throw new Error("expected 400");
  } catch (err) {
    assert((err as { status?: number }).status === 400, "unknown motor on create is 400");
  }

  const updated = updateMaterial(root, "M1", { motorSkills: ["Throwing"], skillRelatedComponents: ["Coordination", "Agility"] });
  assert(JSON.stringify(updated.motorSkills) === JSON.stringify(["Throwing"]), "update motors");
  assert(same(updated.skillRelatedComponents, ["Coordination", "Agility"]), "update components");

  writeFileSync(
    path.join(root, "library", "materials", "M3.md"),
    `---
id: M3
name: Legacy
look: ""
duration: 20
---
`,
  );
  const listed = listMaterials(root);
  const legacy = listed.find((m) => m.id === "M3");
  assert(legacy && legacy.motorSkills.length === 0 && legacy.skillRelatedComponents.length === 0, "missing facets load as []");
  assert(Array.isArray(legacy.classNotes) && legacy.classNotes.length === 0, "missing classNotes load as []");

  const noted = updateMaterial(root, "M1", {
    classNotes: [{ date: "2026-09-15", grade: "G6", text: "Needed two extra minutes on follow-through." }],
  });
  assert(noted.classNotes?.length === 1 && noted.classNotes[0].grade === "G6", "update writes classNotes");
  const notedRaw = readFileSync(path.join(root, "library", "materials", "M1.md"), "utf8");
  assert(notedRaw.includes("classNotes:"), "YAML contains classNotes");
  assert(notedRaw.includes("Needed two extra minutes on follow-through."), "YAML contains class note text");
  const reread = listMaterials(root).find((m) => m.id === "M1");
  assert(reread?.classNotes?.[0]?.date === "2026-09-15" && reread.classNotes[0].text.includes("follow-through"), "read round-trips classNotes");

  const cleared = updateMaterial(root, "M1", { classNotes: [] });
  assert(Array.isArray(cleared.classNotes) && cleared.classNotes.length === 0, "empty classNotes is []");
  const clearedRaw = readFileSync(path.join(root, "library", "materials", "M1.md"), "utf8");
  assert(!clearedRaw.includes("classNotes:"), "empty list omitted from YAML");
} finally {
  rmSync(root, { recursive: true, force: true });
}

const libraryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = listMaterials(libraryRoot);
assert(corpus.every((m) => !("body" in m)), "listed materials must not expose body");
if (corpus.length) {
  const files = corpus.map((m) => ({
    id: m.id,
    raw: readFileSync(path.join(libraryRoot, "library", "materials", m.id + ".md"), "utf8"),
  }));
  const migrated = files.every((f) => !/(^|\n)body:/.test(f.raw.split("\n---")[0]));
  if (migrated && corpus.length === 89) {
    assert(corpus.length === 89, "expected 89 materials, got " + corpus.length);
    const ids = new Set(corpus.map((m) => m.id));
    assert(!ids.has("M20"), "M20 stays missing");
    for (const m of corpus) {
      const seed = SKILL_FACET_SEED[m.id];
      assert(seed, "missing seed for " + m.id);
      const same = (a: string[], b: string[]) => [...a].sort().join("\0") === [...b].sort().join("\0");
      assert(same(m.motorSkills, seed.motorSkills), m.id + " motorSkills mismatch");
      assert(same(m.skillRelatedComponents, seed.skillRelatedComponents), m.id + " components mismatch");
      for (const skill of m.motorSkills) {
        assert((MOTOR_SKILLS as readonly string[]).includes(skill), m.id + " bad motor " + skill);
      }
      for (const c of m.skillRelatedComponents) {
        assert((SKILL_RELATED_COMPONENTS as readonly string[]).includes(c), m.id + " bad component " + c);
      }
    }
  }
}

console.log("taxonomy tests ok");
