import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrateFacetsIntoSets } from "../server/store.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = migrateFacetsIntoSets(ROOT);
console.log("migrated facets for " + r.materials + " materials");
