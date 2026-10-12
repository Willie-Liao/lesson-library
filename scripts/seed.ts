import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFoci, idNumber, listMaterials, saveFoci, savePeriod, writeSeedMaterial } from "../server/store.ts";
import type { Link, Material, Period } from "../web/types.ts";
import { SKILL_FACET_SEED } from "./skill-facet-map.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FALL = path.join(ROOT, "..");
const DRILLS = path.join(FALL, "graphify-src", "drills");
const SKETCHES = path.join(ROOT, "library", "media_library", "flag football");

const MOCK: Material[] = [
  { id: "M1", name: "Half-kneeling throw", look: "Grip, follow-through. Accuracy, not distance.", ...SKILL_FACET_SEED.M1, notes: "Sketch: canva-sketches/howto-one-knee.png" },
  { id: "M2", name: "Standing throw", look: "Catchable ball to a partner about 10 yards.", ...SKILL_FACET_SEED.M2, notes: "Pairs, about 10 yards. Overhand, catchable, not distance.\nSketch: canva-sketches/howto-pass.png\nDrill notes: graphify-src/drills/how-to-throw-a-football.md" },
  { id: "M3", name: "Two-step drop and throw", look: "After a snap. Still catchable.", ...SKILL_FACET_SEED.M3, notes: "Sketch: canva-sketches/howto-snap.png" },
  { id: "M4", name: "Catch in place", look: "Diamond high; pinkies low.", ...SKILL_FACET_SEED.M4, notes: "" },
  { id: "M5", name: "High and low in place", look: "Same hands, two heights, then to the side.", ...SKILL_FACET_SEED.M5, notes: "Sketch: canva-sketches/howto-high-low.png" },
  { id: "M6", name: "Over the shoulder", look: "Jog, look back, tuck.", ...SKILL_FACET_SEED.M6, notes: "Sketch: canva-sketches/howto-over-shoulder.jpg" },
  { id: "M7", name: "High knees", look: "About 5 minutes. Cones 5–10 yards.", ...SKILL_FACET_SEED.M7, notes: "Sketch: canva-sketches/howto-wu-highknees.jpg" },
  { id: "M8", name: "Karaoke", look: "About 5 minutes. Side step, do not cross the feet.", ...SKILL_FACET_SEED.M8, notes: "" },
  { id: "M9", name: "Crazy Catch", look: "Diamond of 4 plus 1 in the middle. 90° turn; catch and return.", ...SKILL_FACET_SEED.M9, notes: "Sketch: canva-sketches/howto-crazy-catch.png" },
  { id: "M10", name: "Ultimate Football", look: "Groups of 4. 5 seconds to throw. No running with the ball.", ...SKILL_FACET_SEED.M10, notes: "Sketch: canva-sketches/howto-ultimate.png" },
];

const MOCK_LINKS: Link[] = [
  { from: "M1", kind: "regression", to: "M2", note: "If grip is messy, kneel first." },
  { from: "M2", kind: "progression", to: "M3", note: "After the ball is catchable standing." },
  { from: "M4", kind: "progression", to: "M5", note: "Same hands, add height." },
  { from: "M5", kind: "progression", to: "M6", note: "Then they can jog and look back." },
  { from: "M4", kind: "related", to: "M2", note: "Pairs usually throw and catch together.", tag: "throw and catch" },
  { from: "M7", kind: "related", to: "M8", note: "Both Instant; legs.", tag: "Legs" },
  { from: "M9", kind: "related", to: "M4", tag: "needs this catch", note: "" },
  { from: "M9", kind: "progression", to: "M10", note: "Return throw becomes 5-second Ultimate." },
];

const PERIODS: Period[] = [
  {
    id: "2026-09-10-G6", date: "2026-09-10", grade: "G6", activities: [
      { id: "M7", start: "08:00", end: "08:05" },
      { id: "M1", start: "08:05", end: "08:25" },
      { id: "M9", start: "08:25", end: "08:40" },
    ],
    reflection: { flags: ["too easy"], text: "Half-kneeling was fine after two reps. Crazy Catch needs the 90° turn cue.", savedAt: "2026-09-10T09:30:00.000Z" },
  },
  {
    id: "2026-09-14-G6", date: "2026-09-14", grade: "G6", activities: [
      { id: "M8", start: "08:00", end: "08:05" },
      { id: "M2", start: "08:05", end: "08:22" },
      { id: "M9", start: "08:22", end: "08:40" },
    ],
    reflection: { flags: [], text: "Standing throw catchable at 10 yd for most pairs. Crazy Catch return throw still late.", savedAt: "2026-09-14T09:30:00.000Z" },
  },
  {
    id: "2026-09-15-G6", date: "2026-09-15", grade: "G6", activities: [
      { id: "M7", start: "08:00", end: "08:08" },
      { id: "M4", start: "08:08", end: "08:28" },
      { id: "M9", start: "08:28", end: "08:40" },
    ],
    reflection: { flags: ["too slow"], text: "Catch in place too easy for half the group; the other half still fights the ball.", savedAt: "2026-09-15T09:30:00.000Z" },
  },
  {
    id: "2026-09-17-G6", date: "2026-09-17", grade: "G6", activities: [
      { id: "M8", start: "08:00", end: "08:05" },
      { id: "M6", start: "08:05", end: "08:20" },
      { id: "M10", start: "08:20", end: "08:40" },
    ],
    reflection: { flags: ["too hard"], text: "Over the shoulder was a two-hop jump; go back to high and low first. Ultimate was fine.", savedAt: "2026-09-17T09:30:00.000Z" },
  },
];

function guessDuration(name: string, text: string): number {
  const s = (name + " " + text).toLowerCase();
  if (/\bwarm[\s-]?up\b|\bagility\b|\bhigh knees\b|\bkaraoke\b|\bfoot fire\b/.test(s)) return 5;
  if (/\bgame\b|\bultimate\b|\bcatch\b.*barrel|\bhot potato\b|\b4v4\b|\b5v5\b/.test(s)) return 15;
  return 20;
}

function guessSkills(text: string): { motorSkills: Material["motorSkills"]; skillRelatedComponents: Material["skillRelatedComponents"] } {
  const s = text.toLowerCase();
  const motorSkills: Material["motorSkills"] = [];
  const skillRelatedComponents: Material["skillRelatedComponents"] = [];
  const addM = (v: Material["motorSkills"][number]) => {
    if (!motorSkills.includes(v)) motorSkills.push(v);
  };
  const addC = (v: Material["skillRelatedComponents"][number]) => {
    if (!skillRelatedComponents.includes(v)) skillRelatedComponents.push(v);
  };
  if (/\bthrow|\bpass\b/.test(s)) addM("Throwing");
  if (/\bcatch/.test(s)) addM("Catching");
  if (/\bsnap/.test(s)) addM("Snapping");
  if (/\bhandoff|\bhanding off/.test(s)) addM("Handing off");
  if (/\broute|\bslant|\bout and go|\bpost|\bflag\b|\bdrag/.test(s)) addM("Route running");
  if (/\bflag pull|\bpull/.test(s)) addM("Flag pulling");
  if (/\bguard/.test(s)) addM("Guarding");
  if (/\bkaraoke|\bshuffle|\blateral/.test(s)) addM("Lateral movement");
  if (/\bcut|\bzigzag|\bt-drill|\bstar drill/.test(s)) addM("Cutting");
  if (/\brun|\bhigh knees|\bbutt kick|\bshuttle/.test(s)) addM("Running");
  if (/\bfoot fire|\bquick step|\bfootwork/.test(s)) addM("Footwork");
  if (/\blunge/.test(s)) addM("Lunging");
  if (/\bsquat/.test(s)) addM("Squatting");
  if (/\bhop|\bjump/.test(s)) addM("Jumping / hopping");
  if (/\bagility|\bkaraoke|\bcut|\broute/.test(s)) addC("Agility");
  if (/\bthrow|\bcatch|\bsnap|\bhandoff/.test(s)) addC("Coordination");
  if (/\bspeed|\bsprint|\bshuttle|\bhigh knees/.test(s)) addC("Speed");
  if (/\breact|\brip|\bcrazy catch/.test(s)) addC("Reaction Time");
  if (/\bbalance|\blunge|\bsquat|\bkneel/.test(s)) addC("Balance");
  if (/\bpower|\bsquat|\blunge|\bhop/.test(s)) addC("Power");
  return { motorSkills, skillRelatedComponents };
}

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^.{12,180}?[.!]/);
  return (m ? m[0] : t.slice(0, 140)).trim();
}

function drillTitleAndBody(raw: string): { name: string; notes: string } {
  const noFm = raw.replace(/^---[\s\S]*?---\s*/, "");
  const h1 = noFm.match(/^#+\s+(.+)$/m);
  const name = (h1 ? h1[1] : noFm.split("\n").find((l) => l.trim() && !l.startsWith("URL:")) || "Untitled")
    .replace(/^HOW TO /i, "")
    .trim();
  return { name, notes: noFm.trim() };
}

function existingNames(mats: Material[]): Set<string> {
  return new Set(mats.map((m) => m.name.trim().toLowerCase()));
}

function tokenFromSketch(filename: string): string {
  return filename
    .replace(/^howto-/, "")
    .replace(/^wu-/, "")
    .replace(/\.(png|jpe?g)$/i, "")
    .replace(/-/g, " ")
    .toLowerCase();
}

function matchSketchToMaterial(filename: string, mats: Material[]): Material | undefined {
  const token = tokenFromSketch(filename);
  const aliases: Record<string, string> = {
    "one knee": "half-kneeling throw",
    pass: "standing throw",
    snap: "two-step drop and throw",
    "high low": "high and low in place",
    "over shoulder": "over the shoulder",
    highknees: "high knees",
    "crazy catch": "crazy catch",
    ultimate: "ultimate football",
  };
  const want = aliases[token] || token;
  return mats.find((m) => m.name.toLowerCase() === want || m.name.toLowerCase().includes(want) || want.includes(m.name.toLowerCase()));
}

function attachSketch(m: Material, file: string) {
  const abs = path.join(SKETCHES, file);
  if (!m.sketch) m.sketch = abs;
  const rel = "library/media_library/flag football/" + file;
  if (!m.notes?.includes(rel) && !m.notes?.includes(abs)) m.notes = (m.notes ? m.notes + "\n" : "") + "Sketch: " + abs;
}

function relationsFromLinks(id: string, links: Link[]) {
  const rel: {
    regression?: { id: string; note?: string; tag?: string }[];
    progression?: { id: string; note?: string; tag?: string }[];
    related?: { id: string; note?: string; tag?: string }[];
  } = {};
  for (const L of links) {
    if (L.kind === "regression" && L.to === id) {
      (rel.regression ||= []).push({ id: L.from, note: L.note, tag: L.tag });
    } else if (L.kind === "progression" && L.from === id) {
      (rel.progression ||= []).push({ id: L.to, note: L.note, tag: L.tag });
    } else if (L.kind === "related" && L.from === id) {
      (rel.related ||= []).push({ id: L.to, note: L.note, tag: L.tag });
    }
  }
  return rel;
}

function main() {
  const written: string[] = [];
  const byName = existingNames(listMaterials(ROOT));

  const materials: Material[] = [];
  for (const m of MOCK) {
    if (byName.has(m.name.toLowerCase())) continue;
    materials.push({ ...m });
    byName.add(m.name.toLowerCase());
  }

  if (existsSync(DRILLS)) {
    for (const file of readdirSync(DRILLS).filter((n) => n.endsWith(".md"))) {
      const { name, notes } = drillTitleAndBody(readFileSync(path.join(DRILLS, file), "utf8"));
      if (byName.has(name.toLowerCase())) continue;
      materials.push({
        id: "pending",
        name,
        duration: guessDuration(name, notes),
        look: firstSentence(notes.replace(/^.*\n/, "")),
        ...guessSkills(name + " " + notes),
        notes: notes + "\n\nSource: graphify-src/drills/" + file,
      });
      byName.add(name.toLowerCase());
    }
  }

  if (existsSync(SKETCHES)) {
    const sketchFiles = readdirSync(SKETCHES).filter((n) => /^howto-.*\.(png|jpe?g)$/i.test(n));
    for (const file of sketchFiles) {
      const hit = matchSketchToMaterial(file, [...MOCK, ...materials.filter((m) => m.id !== "pending")].concat(materials));
      if (hit) {
        attachSketch(hit, file);
        continue;
      }
      const pretty = tokenFromSketch(file).replace(/\b\w/g, (c) => c.toUpperCase());
      if (byName.has(pretty.toLowerCase())) {
        const m = materials.find((x) => x.name.toLowerCase() === pretty.toLowerCase());
        if (m) attachSketch(m, file);
        continue;
      }
      materials.push({
        id: "pending",
        name: pretty,
        duration: file.includes("-wu-") ? 5 : 20,
        look: "Sketch of " + pretty + ".",
        ...guessSkills(pretty),
        sketch: path.join(SKETCHES, file),
        notes: "Sketch: " + path.join(SKETCHES, file),
      });
      byName.add(pretty.toLowerCase());
    }
  }

  const existing = listMaterials(ROOT);
  const maxExisting = existing.reduce((n, m) => Math.max(n, idNumber(m.id)), 0);
  const maxQueued = materials.reduce((n, m) => Math.max(n, m.id === "pending" ? 0 : idNumber(m.id)), 0);
  let n = Math.max(maxExisting, maxQueued) + 1;
  for (const m of materials) {
    if (m.id === "pending") {
      m.id = "M" + n++;
    }
  }

  for (const m of materials) {
    const rel = relationsFromLinks(m.id, MOCK_LINKS);
    writeSeedMaterial(ROOT, { ...m, relations: rel });
    written.push(m.id + " " + m.name);
  }

  const foci = getFoci(ROOT);
  if (!foci.items.length) {
    saveFoci(ROOT, {
      items: [
        { n: 1, text: "Throwing and catching" },
        { n: 2, text: "Route running" },
        { n: 3, text: "Creating the routine" },
      ],
      now: 1,
    });
  }

  for (const p of PERIODS) {
    savePeriod(ROOT, p.id, p);
  }

  console.log("seeded " + written.length + " materials, " + PERIODS.length + " G6 periods");
  for (const line of written) console.log("  " + line);
}

main();
