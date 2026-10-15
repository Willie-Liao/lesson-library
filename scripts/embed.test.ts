import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clusterByTimeAndContent, materialText } from "../server/embed.ts";
import { createMaterial, createSet, listMaterials, listSets, updateSet } from "../server/store.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const root = mkdtempSync(path.join(tmpdir(), "flag-embed-"));
mkdirSync(path.join(root, "library", "materials"), { recursive: true });

const mat = createMaterial(root, {
  name: "Pocket catch",
  look: "Thumbs together, eyes on the ball",
  notes: "Pair up at 5 yards. One throw, one catch.",
});
const skill = createSet(root, { name: "Pressured passing", members: [], parent: null });
const activitySet = createSet(root, {
  name: "Crazy Catch block",
  note: "Stations rotate every two minutes",
  members: [mat.id],
});
updateSet(root, activitySet.id, { parent: skill.id });

const loaded = listMaterials(root).find((m) => m.id === mat.id)!;
const sets = listSets(root);
const blob = materialText(loaded, sets).toLowerCase();

assert(blob.includes("thumbs together"), "look is in blob");
assert(blob.includes("pair up at 5 yards"), "explanation is in blob");
assert(blob.includes("crazy catch block"), "activity set name is in blob");
assert(blob.includes("stations rotate every two minutes"), "activity set note is in blob");
assert(blob.includes("pressured passing"), "skill ancestor is in blob");

const ghost = { ...loaded, motorSkills: ["locomotor" as const], skillRelatedComponents: ["speed" as const] };
const ghostBlob = materialText(ghost, sets).toLowerCase();
assert(!ghostBlob.includes("locomotor"), "raw motorSkills array is not indexed");
assert(!ghostBlob.includes("speed"), "raw skillRelatedComponents array is not indexed");

process.env.EMBED_URL = "http://127.0.0.1:1";
const { searchMaterials } = await import("../server/embed.ts");
const bySet = await searchMaterials(root, "Crazy Catch block", 8);
const hit = bySet.keyword.find((h) => h.id === mat.id);
assert(hit, "keyword finds activity via activity set name");
assert(hit!.score === 0.7, "set-path keyword score is 0.7");

const clusters = clusterByTimeAndContent(
  [
    { id: "A", duration: 5 },
    { id: "B", duration: 20 },
    { id: "C", duration: 40 },
  ],
  {},
  3,
);
assert(clusters.get("A") === 0 && clusters.get("C") === 2, "tertile: shortest duration is cluster 0");

console.log("embed.test.ts ok");
