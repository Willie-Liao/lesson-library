import { brightSet, buildModel, eloUpdateLeap, filterMaterials, hopColumns, hopLeap, hopLinkFor, KIND_W, maxHop, neighborsOf, setBright, validateProgressionHop, validateRelatedHop } from "../web/graph-model.ts";
import { CHAIN_COL_GAP, chainLayout } from "../web/graph-layout.ts";
import { createLink, deleteLink, deleteMaterial, listLinks, updateLink, writeSeedMaterial } from "../server/store.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    classNotes: extra.classNotes,
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const materials = [
  mat("M1", { motorSkills: ["Throwing"] }),
  mat("M2", { motorSkills: ["Throwing"] }),
  mat("M3", { motorSkills: ["Throwing", "Footwork"] }),
  mat("M4", { motorSkills: ["Catching"] }),
  mat("M9", { motorSkills: [] }),
  mat("M10", { motorSkills: [] }),
  mat("M11", { motorSkills: [] }),
  mat("M84", { name: "Karaoke", motorSkills: ["Lateral movement"] }),
];

const links: Link[] = [
  { from: "M1", kind: "progression", to: "M2", note: "kneel first" },
  { from: "M2", kind: "progression", to: "M3", note: "after standing" },
  { from: "M4", kind: "related", to: "M2", note: "throw and catch", tag: "throw and catch" },
];

const bright = brightSet("M2", links);
assert(bright.has("M2") && bright.has("M1") && bright.has("M3") && bright.has("M4"), "M2 one-hop");
assert(!bright.has("M84"), "karaoke is not a one-hop of M2");
assert(bright.size === 4, "exactly four bright nodes");

const twoHop = brightSet("M1", links, 2);
assert(twoHop.has("M3") && twoHop.has("M4"), "two hops from M1 reaches M3 and M4");
assert(brightSet("M1", links, 1).has("M2") && !brightSet("M1", links, 1).has("M3"), "one hop from M1 is only M2");
assert(maxHop(links) === 2, "longest hop path is M1–M3 or M4–M3 / M1–M4");
assert(maxHop([]) === 1, "no links → hops max 1");

const bothKinds: Link[] = [
  { from: "M1", kind: "progression", to: "M2", note: "chain" },
  { from: "M1", kind: "related", to: "M2", note: "also", tag: "throw" },
];
const modelBoth = buildModel([materials[0], materials[1]], bothKinds);
assert(modelBoth.edges.length === 1, "pair collapsed");
assert(modelBoth.edges[0].w === KIND_W.progression, "max w is chain 1.0");
assert(modelBoth.edges[0].kinds.includes("progression") && modelBoth.edges[0].kinds.includes("related"), "both kinds kept");

const emptyPair = buildModel(
  [mat("M9", { motorSkills: [] }), mat("M11", { motorSkills: [] })],
  [],
);
assert(emptyPair.ghosts.length === 0, "empty motors + no shared set → no ghost");

const emptySameSlot = buildModel([mat("M9", { motorSkills: [] }), mat("M10", { motorSkills: [] })], []);
assert(emptySameSlot.ghosts.length === 0, "empty motors never a slot ghost");
assert(!emptySameSlot.ghosts.some((g) => g.reason === "set"), "empty motors never a set ghost");

const ghostOnly = buildModel(
  [mat("A", { motorSkills: ["Throwing", "Catching"] }), mat("B", { motorSkills: ["Catching"] })],
  [],
);
assert(ghostOnly.ghosts.length === 1 && ghostOnly.ghosts[0].reason === "set", "shared motor ghost");
const gBright = brightSet("A", []);
assert(gBright.size === 1 && !gBright.has("B"), "ghost never in brightSet");

const noOverlap = buildModel(
  [mat("A", { motorSkills: ["Throwing"] }), mat("B", { motorSkills: ["Catching"] })],
  [],
);
assert(noOverlap.ghosts.length === 0, "no shared motor → no ghost");

const componentsOnly = buildModel(
  [
    mat("A", { motorSkills: [], skillRelatedComponents: ["Agility"] }),
    mat("B", { motorSkills: [], skillRelatedComponents: ["Agility"] }),
  ],
  [],
);
assert(componentsOnly.ghosts.length === 0, "shared components never a ghost");

const linkedSameMotor = buildModel([materials[0], materials[1]], [links[0]]);
assert(!linkedSameMotor.ghosts.some((g) => (g.source === "M1" && g.target === "M2") || (g.source === "M2" && g.target === "M1")), "no ghost on a real edge");

const pack: MaterialSet = { id: "S1", name: "Throw", note: "", members: ["M1", "M2", "M99"] };
const setLit = setBright(pack, materials);
assert(setLit.has("M1") && setLit.has("M2") && setLit.size === 2, "setBright is members that exist");
assert(!setLit.has("M3") && !setLit.has("M99"), "setBright drops unknown ids");
const afterSet = brightSet("M2", links);
assert(afterSet.size === 4 && afterSet.has("M4") && !afterSet.has("M84"), "a set does not change hop brightSet");
assert(maxHop(links) === 2, "a set does not change maxHop");

assert(!modelBoth.edges[0].kinds.includes("tag" as never), "tag is not a kind");

const m1hops = hopColumns("M1", links, materials);
assert(m1hops.easier.length === 0, "M1 has no regression — easier stays empty");
assert(m1hops.harder.map((x) => x.id).join() === "M2", "M1 harder is the standing throw");
assert(m1hops.alts.every((x) => x.id !== "M1" && x.id !== "M2"), "Also excludes self and harder");
assert(m1hops.alts.length <= 7, "Also is capped at 7 suggestions when there is no related hop");
assert(m1hops.alts.every((x) => x.note === "suggested"), "empty related fills with GATNE suggestions");

const byName = filterMaterials("footwork", materials, "M1");
assert(byName.some((x) => x.id === "M3"), "search hits other materials");
assert(!byName.some((x) => x.id === "M1"), "search excludes the current node");
assert(filterMaterials("karaoke", materials, "M1").some((x) => x.id === "M84"), "search matches name");
assert(filterMaterials("", materials, "M1").length === 0, "empty search returns no hits");
assert(
  filterMaterials("follow-through-xyz", [
    ...materials,
    mat("M99", { classNotes: [{ date: "2026-09-15", grade: "G6", text: "Needed two extra minutes on follow-through-xyz." }] }),
  ], "M1").some((x) => x.id === "M99"),
  "search matches class-note text",
);

const easierLink = hopLinkFor("M1", "easier", "M9");
assert(easierLink && easierLink.from === "M9" && easierLink.kind === "regression" && easierLink.to === "M1", "easier click is regression from hit to current");
const harderLink = hopLinkFor("M1", "harder", "M2");
assert(harderLink && harderLink.from === "M1" && harderLink.kind === "progression" && harderLink.to === "M2", "harder click is progression from current to hit");
assert(hopLinkFor("M1", "easier", "M9", "", "lower toss").note === "lower toss", "easier can keep an optional note");
assert(hopLinkFor("M1", "alts", "M4") === null, "related without tag is null");
const relatedLink = hopLinkFor("M1", "alts", "M4", "throw and catch");
assert(relatedLink && relatedLink.from === "M1" && relatedLink.kind === "related" && relatedLink.to === "M4" && relatedLink.tag === "throw and catch", "related click keeps tag");

assert(neighborsOf("M1", [{ from: "M1", kind: "progression", to: "M2", note: "", leap: 0.5 }]).progression[0].leap === 0.5, "neighbors copy leap");
assert(neighborsOf("M91", [{ from: "M91", kind: "progression", to: "M3", note: "next" }]).progression[0].id === "M3", "M91 harder hop is M3");
assert(neighborsOf("M1", [{ from: "M1", kind: "related", to: "M9", note: "", tag: "x", leap: 0.5 }]).related[0].leap == null, "related hops have no leap");
assert(hopLeap(undefined) === 1 && hopLeap({ leap: undefined }) === 1, "missing leap is 1");
assert(hopLeap({ leap: 0.5 }) === 0.5, "stored leap is used");
const easy0 = eloUpdateLeap(1, 1, 0);
assert(Math.abs(easy0.leap - 0.8) < 1e-9 && easy0.nudgeCount === 1, "too easy from 1 shrinks to 0.8");
const hard0 = eloUpdateLeap(1, 0, 0);
assert(Math.abs(hard0.leap - 1.2) < 1e-9 && hard0.nudgeCount === 1, "too hard from 1 grows to 1.2");
const unclear0 = eloUpdateLeap(1, 0.5, 0);
assert(Math.abs(unclear0.leap - 1) < 1e-9, "unclear at leap 1 does not move");
const easyN = eloUpdateLeap(1, 1, 10);
assert(Math.abs(easyN.leap - 1) < Math.abs(easy0.leap - 1), "larger n smaller |delta|");
let floor = { leap: 1, nudgeCount: 0 };
for (let i = 0; i < 40; i++) floor = eloUpdateLeap(floor.leap, 1, floor.nudgeCount);
assert(floor.leap === 0.1, "too easy clamps at 0.1");
assert(eloUpdateLeap(2.95, 0, 0).leap <= 3, "too hard does not exceed 3");
assert(eloUpdateLeap(0.1, 1, 0).leap === 0.1, "already at floor stays 0.1");

{
  const root = mkdtempSync(path.join(tmpdir(), "flag-leap-"));
  mkdirSync(path.join(root, "library", "materials"), { recursive: true });
  mkdirSync(path.join(root, "library", "periods"), { recursive: true });
  try {
    writeSeedMaterial(root, {
      id: "M1",
      name: "Kneel",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: { progression: [{ id: "M2", leap: 0.5, nudgeCount: 2 }] },
    });
    writeSeedMaterial(root, {
      id: "M2",
      name: "Stand",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    const listed = listLinks(root);
    const hop = listed.find((L) => L.from === "M1" && L.to === "M2" && L.kind === "progression");
    assert(hop && hop.leap === 0.5 && hop.nudgeCount === 2, "flatten round-trips leap 0.5");
    const patched = updateLink(root, "M1", "progression", "M2", { leap: 0.8, nudgeCount: 3 });
    assert(patched.leap === 0.8 && patched.nudgeCount === 3, "updateLink writes leap");
    writeSeedMaterial(root, {
      id: "M3",
      name: "Move",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    writeSeedMaterial(root, {
      id: "M4",
      name: "Base",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: { progression: [{ id: "M5", note: "default" }] },
    });
    writeSeedMaterial(root, {
      id: "M5",
      name: "Next",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    const raw = readFileSync(path.join(root, "library", "materials", "M4.md"), "utf8");
    assert(!raw.includes("leap:"), "leap 1 n=0 omitted from YAML");

    writeSeedMaterial(root, {
      id: "M11",
      name: "A",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    writeSeedMaterial(root, {
      id: "M12",
      name: "B",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    writeSeedMaterial(root, {
      id: "M13",
      name: "C",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    writeSeedMaterial(root, {
      id: "M14",
      name: "D",
      look: "",
      motorSkills: [],
      skillRelatedComponents: [],
      relations: {},
    });
    const ab = createLink(root, { from: "M11", kind: "progression", to: "M12", note: "step" });
    assert(ab.kind === "progression", "createLink returns progression");
    const both = listLinks(root).filter((L) => L.from === "M11" && L.to === "M12");
    assert(both.some((L) => L.kind === "progression") && both.some((L) => L.kind === "regression"), "dual-write both kinds");
    createLink(root, { from: "M12", kind: "progression", to: "M13", note: "" });
    const skip = validateProgressionHop("M11", "M13", listLinks(root));
    assert(skip && skip.includes("through M12") && skip.includes("not variations"), "skip 1→3 names the middle node");
    let threw = false;
    try {
      createLink(root, { from: "M11", kind: "progression", to: "M13", note: "" });
    } catch (err) {
      threw = true;
      assert(String((err as Error).message).includes("through B") || String((err as Error).message).includes("through M12"), "createLink skip is 400");
    }
    assert(threw, "skip hop throws");
    assert(!listLinks(root).some((L) => L.from === "M11" && L.to === "M13"), "skip writes no new links");
    const relSkip = validateRelatedHop("M11", "M13", listLinks(root));
    assert(relSkip && /progression chain/.test(relSkip), "related on 1–3 is illegal");
    let relThrew = false;
    try {
      createLink(root, { from: "M11", kind: "related", to: "M13", note: "", tag: "same drill" });
    } catch (err) {
      relThrew = true;
      assert(String((err as Error).message).includes("progression chain"), "createLink related on chain is 400");
    }
    assert(relThrew, "related on chain throws");
    const fork = validateProgressionHop("M11", "M14", listLinks(root));
    assert(fork && fork.includes("variation to"), "second outgoing progression asks for variation");
    deleteLink(root, "M11", "progression", "M12");
    assert(!listLinks(root).some((L) => L.from === "M11" && L.to === "M12"), "deleteLink removes both YAML sides");
    assert(!validateRelatedHop("M12", "M14", listLinks(root)), "related at same difficulty still ok");
    createLink(root, { from: "M12", kind: "related", to: "M14", note: "", tag: "variation to B" });
    deleteMaterial(root, "M12");
    const leftover = listLinks(root);
    assert(!leftover.some((L) => (L.tag || "") === "variation to B"), "parent delete strips variation relateds");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const pendingModel = buildModel(materials, links, [], [
    { entity: "material", action: "create", tempId: "P1", name: "Draft throw", status: "pending" },
    { entity: "link", action: "create", tempId: "P2", from: "P1", to: "M1", kind: "progression", status: "pending" },
    { entity: "material", action: "create", tempId: "P3", name: "Dropped", status: "discarded" },
  ]);
  const draft = pendingModel.nodes.find((n) => n.id === "P1");
  assert(draft && draft.pending, "pending node is dashed");
  assert(!pendingModel.nodes.some((n) => n.id === "P3"), "discarded node is excluded");
  assert(pendingModel.edges.some((e) => e.pending && e.links.some((L) => L.from === "P1" && L.to === "M1")), "pending edge is dashed");
}

console.log("graph-model tests ok");
