/** Disk checks for the agent note. Run after stampLibraryAgentNotes. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPeriod, readMaterialFile, stampLibraryAgentNotes, writeMaterialFile } from "../server/store.ts";

const root = process.cwd();
stampLibraryAgentNotes(root);

const card = readFileSync(path.join(root, "library", "materials", "M117.md"), "utf8");
if (!card.startsWith("<agent-note>")) throw new Error("M117 missing fence");
for (const tool of ["update_material", "create_link", "attach_sketch"]) {
  if (!card.includes(tool)) throw new Error("M117 note missing " + tool);
}
const periodPath = path.join(root, "library", "periods", "2026-10-13-G6.md");
const periodRaw = readFileSync(periodPath, "utf8");
if (!periodRaw.includes("save_period")) throw new Error("period note missing save_period");
const loaded = getPeriod(root, "2026-10-13-G6");
if (!loaded) throw new Error("period did not parse");
if ((loaded.plan || "").includes("<agent-note>")) throw new Error("period plan kept the fence");

const dir = mkdtempSync(path.join(tmpdir(), "agent-note-"));
const base = path.join(dir, "libroot");
mkdirSync(path.join(base, "library", "materials"), { recursive: true });
const sample = path.join(base, "library", "materials", "M1.md");
writeFileSync(sample, "---\nid: M1\nname: Pass\nlook: overhand\nduration: 20\n---\n\nDiamond catch.\n");
stampLibraryAgentNotes(base);
const material = readMaterialFile(sample);
if (material.notes.includes("<agent-note>")) throw new Error("notes kept the fence");
if (!material.notes.includes("Diamond catch")) throw new Error("notes lost the lesson");
writeMaterialFile(sample, material);
const again = readFileSync(sample, "utf8");
if (!again.startsWith("<agent-note>")) throw new Error("round trip dropped the fence");
if (!again.includes("\n---\n")) throw new Error("round trip dropped frontmatter");
if (readMaterialFile(sample).notes.includes("<agent-note>")) throw new Error("reread kept the fence");
rmSync(dir, { recursive: true, force: true });
console.log("agent note ok");
