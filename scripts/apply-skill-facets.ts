import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMaterials, updateMaterial } from "../server/store.ts";
import { SKILL_FACET_SEED } from "./skill-facet-map.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const mats = listMaterials(ROOT);
  const missing: string[] = [];
  for (const m of mats) {
    const seed = SKILL_FACET_SEED[m.id];
    if (!seed) {
      missing.push(m.id);
      continue;
    }
    updateMaterial(ROOT, m.id, seed);
  }
  if (missing.length) throw new Error("no seed for " + missing.join(", "));
  console.log("applied skill facets to " + mats.length + " materials");
}

main();
