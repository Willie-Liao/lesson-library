import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBJECTIVE_PROMPT,
  POLISH_PROMPT,
  REFLECT_PROMPT,
  SYSTEM_PROMPT,
  trimPolishLook,
  trimPolishNote,
  appendMaterialTags,
  applyKgOps,
  applyReflectElo,
  judgmentToS,
  buildReflectInput,
  buildUserMessage,
  compactPeriod,
  extractChatAction,
  extractChatQueryBatch,
  lessonCountFromDemand,
  llmHistoryWindow,
  dupCheckItems,
  createMaterialsFromDupCheck,
  parseSkillItems,
  DUP_SCORE,
  lookupCacheMatches,
  runDateSlots,
  chatStatusSequence,
  compactPeriodIndex,
  kgQuery,
  mergeNextGoal,
  periodPinIds,
  userNextGoalBlock,
  validateReflectOutput,
  validateSuggestion,
  reflect,
  setChatOnceForTests,
} from "../server/llm.ts";
import { formatKgApplyReport, neighborsOf } from "../web/graph-model.ts";
import { createLink, createMaterial, createSet, getPeriod, listHistory, listLinks, listMaterials, listSets, pruneChatLog, restoreHistory, savePeriod, updateMaterial, writeChatLog, writeSeedMaterial } from "../server/store.ts";
import type { Foci, Period } from "../web/types.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const sample: Period = {
  id: "2026-09-15-G6",
  date: "2026-09-15",
  grade: "G6",
  activities: [
    { id: "M84", start: "08:00", end: "08:05", easier: [], harder: [], alts: [] },
    { id: "M2", start: "08:05", end: "08:25", easier: ["M17"], harder: [], alts: [] },
    { id: "M9", start: "08:25", end: "08:40" },
  ],
  reflection: { flags: ["too easy"], text: "Need more reps" },
  objective: "Throw catchable balls from a knee, then standing.",
  nextGoal: "Add a step and throw.",
};

assert(OBJECTIVE_PROMPT.includes("user's input:"), "objective prompt has user's input label");
assert(OBJECTIVE_PROMPT.includes("class content:"), "objective prompt has class content label");

const packed = compactPeriod(sample);
assert(packed && packed.activities && packed.activities[1].id === "M2", "compactPeriod keeps activities");
assert(packed.objective.includes("knee"), "compactPeriod keeps objective");
assert(packed.nextGoal.includes("step"), "compactPeriod keeps nextGoal");

const foci: Foci = { items: [{ n: 1, text: "Pass and catch" }], now: 1 };
const json = buildUserMessage({
  foci,
  materials: [{
    id: "M2",
    name: "Standing throw",
    look: "Catchable",
    motorSkills: ["Throwing"],
    skillRelatedComponents: ["Coordination"],
  }],
  links: [],
  period: sample,
  previous: null,
  mode: "goal",
  goal: "Work the out route",
});
assert(json.includes('"activities"'), "buildUserMessage includes activities");
assert(json.includes('"objective"'), "buildUserMessage includes objective");
assert(json.includes('"nextGoal"'), "buildUserMessage includes nextGoal");
assert(json.includes('"mode": "goal"'), "buildUserMessage includes mode");
assert(json.includes("Work the out route"), "buildUserMessage includes goal");

const lastJson = buildUserMessage({
  foci,
  materials: [],
  links: [],
  period: sample,
  previous: null,
});
assert(lastJson.includes('"mode": "last"'), "omitted mode is last");

const root = mkdtempSync(path.join(tmpdir(), "flag-llm-"));
mkdirSync(path.join(root, "library", "periods"), { recursive: true });
mkdirSync(path.join(root, "library", "materials"), { recursive: true });
try {
  const saved = savePeriod(root, sample.id, sample);
  assert(saved.objective === sample.objective, "savePeriod writes objective");
  assert(saved.nextGoal === sample.nextGoal, "savePeriod writes nextGoal");
  const raw = readFileSync(path.join(root, "library", "periods", sample.id + ".md"), "utf8");
  assert(raw.includes("objective:"), "YAML contains objective");
  assert(raw.includes("nextGoal:"), "YAML contains nextGoal");
  const loaded = getPeriod(root, sample.id);
  assert(loaded?.objective === sample.objective && loaded?.nextGoal === sample.nextGoal, "getPeriod round-trips objective and nextGoal");

  savePeriod(root, sample.id, { ...sample, objective: "", nextGoal: "  " });
  const cleared = getPeriod(root, sample.id);
  const clearedRaw = readFileSync(path.join(root, "library", "periods", sample.id + ".md"), "utf8");
  assert(!cleared?.objective && !cleared?.nextGoal, "empty objective/nextGoal load as absent");
  assert(!clearedRaw.includes("objective:") && !clearedRaw.includes("nextGoal:"), "empty strings omitted from YAML");
} finally {
  rmSync(root, { recursive: true, force: true });
}

assert(POLISH_PROMPT.includes("toLook"), "polish note uses toLook");
assert(POLISH_PROMPT.includes("barebone"), "polish note is drill barebone");
assert(POLISH_PROMPT.includes("play-loop slice"), "polish note freezes play-loop");
assert(!POLISH_PROMPT.includes("why this hop"), "why-this-hop hop-note job retired");
assert(POLISH_PROMPT.includes("Keep every observable cue from the draft"), "polish prompt preserves note cues");
assert(POLISH_PROMPT.includes("tagged"), "polish prompt uses tagged similar cards");
assert(POLISH_PROMPT.includes("similar"), "polish prompt treats tagged cards as similar");
assert(POLISH_PROMPT.includes("Combine"), "polish prompt combines draft with tagged look/explanation");
assert(POLISH_PROMPT.includes("~3–8 words"), "look stays a short freeze");
assert(POLISH_PROMPT.includes("game-moment"), "look freezes a game-moment");
assert(POLISH_PROMPT.includes("Isolated skills"), "look is not an isolated skill list");
assert(POLISH_PROMPT.includes("do not copy neighbour look or name"), "look/name do not copy neighbour cues");
assert(POLISH_PROMPT.includes("name: a short activity title"), "name polish is a title not a procedure");
assert(!/4\. look:[\s\S]*Combine/.test(POLISH_PROMPT.split("5. name:")[0] || ""), "look rule does not Combine tagged cards");
assert(trimPolishNote("some quick aiming, some accuracy, turning.") === "some quick aiming, some accuracy, turning", "note trim keeps comma list");
assert(trimPolishNote("a, b, c, d, e, f") === "a, b, c, d, e, f", "note trim keeps all comma fragments");
assert(trimPolishNote("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen") === "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", "note trim hard-caps runaway text");
assert(trimPolishLook("Ball at chest height with elbow up high.") === "Ball at chest height with elbow up high", "look trim strips period");
assert(trimPolishLook("name: Snap to QB", 12) === "Snap to QB", "name trim strips name: label");

assert(REFLECT_PROMPT.includes("ReflectOutput"), "reflect prompt names output schema");
assert(REFLECT_PROMPT.includes("Do not output leap"), "reflect prompt forbids leap");
assert(REFLECT_PROMPT.includes("too slow") && REFLECT_PROMPT.includes("too fast"), "reflect prompt aliases pace flags");
assert(!REFLECT_PROMPT.includes("Dock flags apply only"), "old vague flag rule retired");
assert(OBJECTIVE_PROMPT.includes("user's input:"), "objective prompt has user's input label");

const pins = periodPinIds(sample);
assert(pins.join() === "M84,M2,M9", "period pins Instant Skill Key");

const okOut = validateReflectOutput({
  tags: ["@M84", "@M2", "@M9"],
  observations: [
    { id: "M84", judgment: "unclear" },
    { id: "M2", judgment: "too_easy", why: "two reps" },
    { id: "M9", judgment: "unclear" },
  ],
  nextGoalLlm: "Add a step after standing throw.",
}, pins);
assert(typeof okOut !== "string" && okOut.observations.find((o) => o.id === "M2")?.judgment === "too_easy", "valid patch");
assert(typeof okOut !== "string" && okOut.tags.join(" ") === "@M84 @M2 @M9", "tags normalized to pin order");

assert(typeof validateReflectOutput({
  tags: ["@M84", "@M2", "@M9"],
  observations: [
    { id: "M84", judgment: "unclear" },
    { id: "M2", judgment: "too_easy" },
    { id: "M99", judgment: "unclear" },
  ],
  nextGoalLlm: "x",
}, pins) === "string", "unknown id rejected");

assert(typeof validateReflectOutput({
  tags: ["@M84", "@M2", "@M9"],
  observations: [
    { id: "M84", judgment: "unclear" },
    { id: "M2", judgment: "too_easy" },
    { id: "M9", judgment: "unclear" },
  ],
  nextGoalLlm: "x",
  leap: 0.5,
}, pins) === "string", "extra leap key rejected");

assert(judgmentToS("too_easy") === 1 && judgmentToS("too_hard") === 0 && judgmentToS("unclear") === 0.5, "Elo s from judgment");
assert(judgmentToS("unclear", ["too slow"]) === 1, "too slow aliases too easy when unclear");
assert(judgmentToS("unclear", ["too fast"]) === 0, "too fast aliases too hard when unclear");
assert(judgmentToS("unclear", ["too easy"]) === 1 && judgmentToS("unclear", ["too hard"]) === 0, "difficulty flags fill unclear");
assert(judgmentToS("unclear", ["too slow", "too hard"]) === 0, "difficulty beats pace");
assert(judgmentToS("too_easy", ["too hard"]) === 1, "named-pin judgment beats flags");

assert(appendMaterialTags("Standing throw was too easy", ["@M84", "@M2", "@M9"]).includes("@M84") && appendMaterialTags("Standing throw was too easy", ["@M84", "@M2", "@M9"]).includes("@M2"), "append missing @ tags");
assert(userNextGoalBlock("Add a step.") === "Add a step.", "plain nextGoal is user block");
assert(mergeNextGoal("", "Cue the 90 turn.").includes("user's input:\n(none)") && mergeNextGoal("", "Cue the 90 turn.").includes("next period:\nCue the 90 turn."), "merge two blocks");

{
  const leapRoot = mkdtempSync(path.join(tmpdir(), "flag-reflect-"));
  mkdirSync(path.join(leapRoot, "library", "materials"), { recursive: true });
  mkdirSync(path.join(leapRoot, "library", "periods"), { recursive: true });
  try {
    const blank = { look: "", motorSkills: [] as const, skillRelatedComponents: [] as const };
    writeSeedMaterial(leapRoot, { id: "M1", name: "Kneel", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M2", name: "Stand", ...blank, relations: { progression: [{ id: "M3" }], regression: [{ id: "M1" }] } });
    writeSeedMaterial(leapRoot, { id: "M3", name: "Move", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M84", name: "Karaoke", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M9", name: "Crazy Catch", ...blank, relations: {} });
    const input = buildReflectInput(sample, [
      { id: "M84", name: "Karaoke", look: "", motorSkills: [], skillRelatedComponents: [] },
      { id: "M2", name: "Standing throw", look: "", motorSkills: [], skillRelatedComponents: [] },
      { id: "M9", name: "Crazy Catch", look: "", motorSkills: [], skillRelatedComponents: [] },
    ], listLinks(leapRoot));
    assert(input.materials.length === 3 && input.materials[1].id === "M2", "reflect input is day's pins");
    const out = validateReflectOutput({
      tags: ["@M84", "@M2", "@M9"],
      observations: [
        { id: "M84", judgment: "unclear" },
        { id: "M2", judgment: "too_easy" },
        { id: "M9", judgment: "unclear" },
      ],
      nextGoalLlm: "Add a step.",
    }, pins);
    if (typeof out === "string") throw new Error(out);
    applyReflectElo(leapRoot, out, pins, listLinks(leapRoot));
    const hops = listLinks(leapRoot).filter((L) => L.kind === "progression" || L.kind === "regression");
    const m2hops = hops.filter((L) => L.from === "M2" || L.to === "M2");
    assert(m2hops.length > 0 && m2hops.every((L) => (L.leap || 1) < 1), "too easy shrinks M2 chain hops");

    writeSeedMaterial(leapRoot, { id: "M1", name: "Kneel", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M2", name: "Stand", ...blank, relations: { progression: [{ id: "M3" }], regression: [{ id: "M1" }] } });
    writeSeedMaterial(leapRoot, { id: "M3", name: "Move", ...blank, relations: {} });
    const unclear = validateReflectOutput({
      tags: ["@M84", "@M2", "@M9"],
      observations: [
        { id: "M84", judgment: "unclear" },
        { id: "M2", judgment: "unclear" },
        { id: "M9", judgment: "unclear" },
      ],
      nextGoalLlm: "Step up.",
    }, pins);
    if (typeof unclear === "string") throw new Error(unclear);
    applyReflectElo(leapRoot, unclear, pins, listLinks(leapRoot), ["too slow"]);
    const afterSlow = listLinks(leapRoot).filter((L) => L.from === "M2" || L.to === "M2");
    assert(afterSlow.length > 0 && afterSlow.every((L) => (L.leap || 1) < 1), "too slow + unclear shrinks hops");

    writeSeedMaterial(leapRoot, { id: "M1", name: "Kneel", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M2", name: "Stand", ...blank, relations: { progression: [{ id: "M3" }], regression: [{ id: "M1" }] } });
    writeSeedMaterial(leapRoot, { id: "M3", name: "Move", ...blank, relations: {} });
    applyReflectElo(leapRoot, unclear, pins, listLinks(leapRoot), ["too fast"]);
    const afterFast = listLinks(leapRoot).filter((L) => L.from === "M2" || L.to === "M2");
    assert(afterFast.length > 0 && afterFast.every((L) => (L.leap || 1) > 1), "too fast + unclear grows hops");

    writeSeedMaterial(leapRoot, { id: "M1", name: "Kneel", ...blank, relations: {} });
    writeSeedMaterial(leapRoot, { id: "M2", name: "Stand", ...blank, relations: { progression: [{ id: "M3" }], regression: [{ id: "M1" }] } });
    writeSeedMaterial(leapRoot, { id: "M3", name: "Move", ...blank, relations: {} });
    applyReflectElo(leapRoot, unclear, pins, listLinks(leapRoot), ["too slow", "too hard"]);
    const afterConflict = listLinks(leapRoot).filter((L) => L.from === "M2" || L.to === "M2");
    assert(afterConflict.length > 0 && afterConflict.every((L) => (L.leap || 1) > 1), "too slow + too hard grows hops");
  } finally {
    rmSync(leapRoot, { recursive: true, force: true });
  }
}

assert(SYSTEM_PROMPT.includes("picks"), "last/goal prompt uses picks");
assert(!SYSTEM_PROMPT.toLowerCase().includes("matching slot"), "slot-matching rule retired");
assert(!SYSTEM_PROMPT.includes("instant:"), "last/goal prompt has no Instant field");

{
  const chat = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "kg-chat-system.md"), "utf8");
  assert(chat.includes("experienced") && chat.includes("knowledge graph"), "chat prompt is KG lesson planner");
  assert(chat.includes("What to look for") && chat.includes("game-moment") && chat.includes("full how-the-drill-is-done"), "chat prompt: concise look, detailed notes");
  assert(chat.includes("Combo nodes hide skills") && chat.includes("already can do the extra"), "chat inventories combo skills before a new harder node");
  assert(chat.includes("aspect") && chat.includes("do not copy neighbour look or name"), "chat look/name from target; hops are contrast");
  assert(chat.includes("duplicate") && chat.includes("variation") && chat.includes("chain") && chat.includes("not similar"), "chat prompt classifies merge verdicts");
  assert(chat.includes("action\":\"de_dup\"") || chat.includes('action":"de_dup"'), "chat prompt de_dup op");
  assert(/recall/i.test(chat) && /undo/i.test(chat), "chat prompt leaves recall to the client");
  assert(chat.includes("Teacher note") && chat.includes("barebone") && chat.includes("copy look from the **to** row"), "chat prompt fills hop note from to look");
  assert(!chat.includes("why this hop"), "chat prompt does not ask why this hop");
  assert(chat.includes("thisPeriod") && chat.includes("40") && chat.includes("start") && chat.includes("end") && chat.includes("objective"), "chat prompt fills this period with clocks");
  assert(chat.includes("multiLesson") && chat.includes("Lesson N"), "chat prompt multi-lesson days[]");
  assert(chat.includes("Empty picks only"), "empty picks only for graph patch");
  assert(chat.includes("DateSlots") && chat.includes("arrangement"), "chat prompt DateSlots for class days");
  assert(!/if date is not clear, do not query/i.test(chat) && !chat.includes("Dates may be omitted on each day"), "retired unclear-date Clarify block");
  assert(chat.includes("\"tool\":\"Clarify\"") || chat.includes('"tool":"Clarify"'), "chat prompt Clarify tool");
  assert(chat.includes("fields") && chat.includes("createDate"), "chat prompt Clarify fill-in fields");
  assert(chat.includes("create-materials") && chat.includes("write-lesson-in-schedule") && chat.includes("explore-the-progression"), "chat prompt names both skills");
  assert(chat.includes("Clarify before create-materials"), "explore talks before create");
  assert(/must call/i.test(chat), "chat prompt must call skills");
  assert(chat.includes("first action on a create"), "create demand does not start with unilateral M-id pick");
  const skill = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "play-loop-lesson-recommend", "SKILL.md"), "utf8");
  assert(skill.includes("Clarify") && skill.includes("DateSlots") && /checklist/i.test(skill), "skill DateSlots before KGQuery");
  assert(skill.includes("create-materials") && skill.includes("write-lesson-in-schedule"), "play-loop defers create and schedule");
  assert(skill.includes("explore-the-progression"), "play-loop defers harder-than-this-drill");
  const createSkill = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "create-materials", "SKILL.md"), "utf8");
  assert(/must call/i.test(createSkill) && createSkill.includes("searchMaterials") && createSkill.includes("notes") && createSkill.includes("discard"), "create-materials skill points at searchMaterials and discard");
  assert(createSkill.includes("game-moment"), "create-materials look is a game-moment freeze");
  assert(!/Keep existing/i.test(createSkill) && !/overwrite/i.test(createSkill), "create-materials retired keep/overwrite");
  const writeSkill = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "write-lesson-in-schedule", "SKILL.md"), "utf8");
  assert(/must call/i.test(writeSkill) && writeSkill.includes("create-materials") && writeSkill.includes("DateSlots") && writeSkill.includes("KGQuery"), "write-lesson sequences create-materials then tools");
  assert(!/keep \/ overwrite/i.test(writeSkill), "write-lesson retired keep/overwrite");
  const exploreSkill = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "explore-the-progression", "SKILL.md"), "utf8");
  assert(exploreSkill.includes("Clarify") && /do not call create-materials/i.test(exploreSkill), "explore Clarifies before create-materials");
  assert(exploreSkill.includes("game-moment") && exploreSkill.includes("from"), "explore names moment from a drill");
  assert(/inventory isolated skills/i.test(exploreSkill) && /already in this node/i.test(exploreSkill), "explore lists hidden skills then checks the current card");
  assert(/Flag pulling/i.test(exploreSkill) && /defender/i.test(exploreSkill), "explore example extra is a defender / Flag pulling");
  assert(exploreSkill.includes("Empty `motorSkills`") && exploreSkill.includes("look and notes"), "empty tags still require look/notes inference");
  const llmSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "llm.ts"), "utf8");
  assert(llmSrc.includes("Fill look (What to look for) and notes (Explanation)"), "bounce if look or notes empty");
  assert(llmSrc.includes("Name the drill (an M-id or name) in from."), "empty explore from bounces");
  assert(llmSrc.includes("motorSkills: r.motorSkills"), "compactKgRows keeps motorSkills");
  assert(!llmSrc.includes("applyCreateMaterialsChoice"), "applyCreateMaterialsChoice retired");
  assert(!llmSrc.includes("await-choice"), "await-choice phase retired");
}

{
  const clarify = extractChatAction(JSON.stringify({
    tool: "Clarify",
    reply: "Need grade and date.",
    fields: [{ id: "grade", label: "Which grade?", value: "" }, { id: "date", label: "Which date (YYYY-MM-DD)?", value: "" }],
  }));
  assert(clarify && clarify.tool === "Clarify", "Clarify parse tool");
  const fields = (clarify && clarify.fields) as { id: string; label: string }[];
  assert(Array.isArray(fields) && fields[0]!.id === "grade" && fields[0]!.label && !clarify.ops, "Clarify keeps fields, no ops");
  assert(JSON.stringify(chatStatusSequence(["DateSlots", "KGQuery", "final"])) === JSON.stringify([
    { status: "understanding" },
    { status: "looking-up", tool: "DateSlots" },
    { status: "looking-up", tool: "KGQuery" },
    { status: "putting-together" },
    { status: "organising" },
  ]), "status order DateSlots then KGQuery");
  assert(JSON.stringify(chatStatusSequence(["Clarify"])) === JSON.stringify([
    { status: "understanding" },
    { status: "organising", tool: "Clarify" },
  ]), "Clarify skips lookup");
  const withSkill = chatStatusSequence(["write-lesson-in-schedule", "DateSlots", "KGQuery", "final"]);
  assert(withSkill.some((e) => e.skill === "write-lesson-in-schedule" && e.tool === "DateSlots"), "status names skill and tool together");
  const slotsXml = extractChatAction(`<minimax:tool_call>
<invoke name="DateSlots">
<parameter name="grade">G7</parameter>
<parameter name="count">5</parameter>
</invoke>
</minimax:tool_call>`);
  assert(slotsXml && slotsXml.tool === "DateSlots" && (slotsXml.args as { grade?: string }).grade === "G7", "minimax DateSlots parse");
  const slotsJson = extractChatAction(JSON.stringify({ tool: "DateSlots", args: { grade: "G6", count: 3, after: "2026-09-20" } }));
  assert(slotsJson && slotsJson.tool === "DateSlots", "json DateSlots parse");
  const skillJson = extractChatAction(JSON.stringify({ skill: "write-lesson-in-schedule", items: [{ name: "Hot Potato" }], lessonCount: 2 }));
  assert(skillJson && skillJson.skill === "write-lesson-in-schedule" && Array.isArray(skillJson.items), "extractChatAction reads write-lesson skill");
  const createJson = extractChatAction(JSON.stringify({ skill: "create-materials", items: [{ name: "Crazy Catch" }] }));
  assert(createJson && createJson.skill === "create-materials", "extractChatAction reads create-materials skill");
  const exploreJson = extractChatAction(JSON.stringify({ skill: "explore-the-progression", from: "M91" }));
  assert(exploreJson && exploreJson.skill === "explore-the-progression" && exploreJson.from === "M91", "extractChatAction reads explore-the-progression");
  const exploreXml = extractChatAction(`<invoke name="explore-the-progression"><parameter name="from">Initiate the play</parameter></invoke>`);
  assert(exploreXml && exploreXml.skill === "explore-the-progression" && exploreXml.from === "Initiate the play", "xml explore-the-progression parse");
  const exploreSeq = chatStatusSequence(["explore-the-progression", "Clarify"]);
  assert(exploreSeq.some((e) => e.skill === "explore-the-progression") && exploreSeq.some((e) => e.tool === "Clarify"), "status names explore then Clarify");
  const walked = runDateSlots(
    { grade: "G7", count: 2, after: "2026-09-21" },
    { classDays: { G6: [], G7: [3, 5] }, entries: [], periods: [], grade: "G7", after: "2026-09-21", count: 2 },
  );
  assert(walked[0]!.date === "2026-09-23" && walked[0]!.empty && !walked[0]!.exists, "DateSlots walker fills empty slots");
  assert(lookupCacheMatches({ demand: "five lessons", grade: "G7", dateSlots: walked }, "five lessons", "G7"), "lookup cache hit same demand");
  assert(!lookupCacheMatches({ demand: "five lessons", grade: "G7", dateSlots: walked }, "other", "G7"), "lookup cache miss other demand");
  const idx = compactPeriodIndex([
    { id: "2026-09-15-G6", date: "2026-09-15", grade: "G6", reflection: { flags: [], text: "" } },
  ]);
  assert(idx.some((r) => r.date === "2026-09-15" && r.grade === "G6"), "listed date found");
  assert(!idx.some((r) => r.date === "2026-12-01"), "unknown date not in index");
}

{
  const minimax = `Let me try broader queries to find warm-up and game sim materials.
<minimax:tool_call>
<invoke name="KGQuery">
<parameter name="q">warm-up</parameter>
</invoke>
<invoke name="KGQuery">
<parameter name="q">game simulation</parameter>
</invoke>
</minimax:tool_call>`;
  const batch = extractChatQueryBatch(minimax);
  assert(batch.length === 2 && batch[0]!.q === "warm-up" && batch[1]!.q === "game simulation", "minimax double KGQuery batch");
}

{
  const five = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "center_receiver_five_lessons.md"), "utf8");
  assert(lessonCountFromDemand(five) === 5, "center receiver doc counts five lessons");
  assert(lessonCountFromDemand("Plan Lesson 1 only") === 1, "single lesson heading");
  assert(lessonCountFromDemand("four lessons on snap") === 4, "word lesson count");
}

{
  const mats = [
    { id: "M1", name: "Kneel", look: "knee", duration: 5, motorSkills: [] as const, skillRelatedComponents: [] as const },
    { id: "M2", name: "Stand", look: "stand", duration: 20, motorSkills: ["Throwing"] as const, skillRelatedComponents: [] as const },
    { id: "M3", name: "Move", look: "jog", duration: 15, motorSkills: [] as const, skillRelatedComponents: [] as const },
  ];
  const hops = [
    { from: "M1", kind: "progression" as const, to: "M2", note: "" },
    { from: "M2", kind: "progression" as const, to: "M3", note: "" },
    { from: "M2", kind: "related" as const, to: "M1", note: "", tag: "throw" },
  ];
  const all = kgQuery({ q: "stand" }, mats, hops);
  assert(all.ids.includes("M2") && !all.ids.includes("M1"), "keyword filters");
  const semantic = kgQuery(
    { q: "pocket catch", qVec: [1, 0] },
    mats,
    hops,
    [],
    [],
    { M1: [1, 0], M2: [0, 1], M3: [0, 1] },
  );
  assert(semantic.ids[0] === "M1" && !/pocket catch/i.test(mats[0]!.name), "semantic rank without name match");
  const ranked = kgQuery({}, mats, hops).ranked;
  assert(ranked[0]!.id === "M1" && ranked[2]!.id === "M3", "easy to hard by depth");
  const m2 = ranked.find((r) => r.id === "M2")!;
  assert(m2.harder[0]!.id === "M3", "kgQuery attaches one-hop harder");
  assert(m2.easier[0]!.id === "M1", "kgQuery attaches one-hop easier");
  assert(m2.related.some((h) => h.id === "M1" && h.look === "knee"), "related hopCards include look");
  assert(m2.motorSkills.includes("Throwing"), "kgQuery ranked rows include motorSkills tags");
  assert(!m2.harder.some((h) => /^G/.test(h.id)), "kg hops are real nodes, not GATNE ghosts");
  const ok = validateSuggestion({
    focus: 1,
    summary: "Focus 1 Pass and catch from a knee",
    picks: [{ id: "M2", why: "standing throw" }],
  }, mats, foci);
  assert(typeof ok !== "string" && ok.picks[0]!.id === "M2", "validate picks");
  const timed = validateSuggestion({
    reply: "Draft",
    objective: "Identify a catchable snap.",
    picks: [{ id: "M1", why: "warm-up", start: "08:00", end: "08:05" }, { id: "M2", why: "main", start: "08:05", end: "08:25" }],
    ops: [{ entity: "material", action: "create", name: "X" }],
  }, mats, foci, { allowEmptyPicks: true });
  assert(typeof timed !== "string" && timed.picks[0]!.start === "08:00" && timed.picks[1]!.end === "08:25", "validate keeps clocks");
  assert(typeof timed !== "string" && timed.objective === "Identify a catchable snap.", "validate keeps objective");
  const multi = validateSuggestion({
    reply: "Two days",
    days: [
      { date: "2026-09-20", grade: "G6", picks: [{ id: "M1", why: "warm-up", start: "08:00", end: "08:05" }], objective: "Identify a catchable snap." },
      { date: "2026-09-22", grade: "G6", picks: [{ id: "M2", why: "main", start: "08:05", end: "08:25" }] },
    ],
  }, mats, foci, { allowEmptyPicks: true });
  assert(typeof multi !== "string" && multi.picks.length === 2 && multi.days && multi.days.length === 2 && multi.picks[0]!.date === "2026-09-20", "validate flattens days");
  const draftPick = validateSuggestion({
    reply: "Draft",
    days: [{ date: "2026-09-20", grade: "G7", picks: [{ id: "NEW-L2", why: "new drill", start: "08:05", end: "08:25" }] }],
    ops: [{ entity: "material", action: "create", name: "L2 drill", tempId: "NEW-L2" }],
  }, mats, foci, { allowEmptyPicks: true });
  assert(typeof draftPick !== "string" && draftPick.picks[0]!.id === "NEW-L2", "create tempId is a valid chat pick");
  const dropUnknown = validateSuggestion({
    reply: "Draft",
    picks: [{ id: "M1", why: "warm" }, { id: "M-L1-initiate", why: "invented" }],
  }, mats, foci, { allowEmptyPicks: true });
  assert(typeof dropUnknown !== "string" && dropUnknown.picks.length === 1 && dropUnknown.picks[0]!.id === "M1", "chat drops unknown picks");
  const stillReject = validateSuggestion({
    focus: 1,
    summary: "Focus 1 Pass and catch from a knee",
    picks: [{ id: "NOPE", why: "x" }],
  }, mats, foci);
  assert(typeof stillReject === "string" && /unknown id/.test(stillReject), "last/goal still rejects unknown id");
  const relatedOnChain = validateSuggestion({
    reply: "Draft",
    ops: [{ entity: "link", action: "create", kind: "related", from: "M1", to: "M3", tag: "same drill" }],
  }, mats, foci, { allowEmptyPicks: true, links: hops });
  assert(typeof relatedOnChain === "string" && /progression chain/.test(relatedOnChain), "related on chain to model");
  const skipHop = validateSuggestion({
    reply: "Draft",
    ops: [{ entity: "link", action: "create", kind: "progression", from: "M1", to: "M3" }],
  }, mats, foci, { allowEmptyPicks: true, links: hops });
  assert(typeof skipHop === "string" && /through/.test(skipHop), "skip-hop progression with real links");
  const patch = extractChatAction(JSON.stringify({
    tool: "KGPatch",
    ops: [{ entity: "material", action: "create", name: "X" }],
    picks: [{ id: "M2", why: "standing", start: "08:05", end: "08:25" }],
    objective: "Outline the standing throw.",
  }));
  assert(patch && Array.isArray(patch.picks) && (patch.picks as { id: string }[])[0]!.id === "M2", "KGPatch keeps picks");
  const stacked = [
    { id: "M1", duration: 5 },
    { id: "M2", duration: 20 },
    { id: "M3", duration: 15 },
  ].reduce((acts: { id: string; start: string; end: string }[], row) => {
    const start = acts.length ? acts[acts.length - 1]!.end : "08:00";
    const [h, m] = start.split(":").map(Number);
    const t = h! * 60 + m! + row.duration;
    const end = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    acts.push({ id: row.id, start, end });
    return acts;
  }, []);
  assert(stacked[0]!.start === "08:00" && stacked[0]!.end === "08:05", "stack warm-up");
  assert(stacked[1]!.start === "08:05" && stacked[1]!.end === "08:25", "stack main");
  assert(stacked[2]!.start === "08:25" && stacked[2]!.end === "08:40", "stack to 40");
  const swapped = [
    { id: "M2", start: "08:05", end: "08:25" },
    { id: "M1", start: "08:00", end: "08:05" },
    { id: "M3", start: "08:25", end: "08:40" },
  ].reduce((acts: { id: string; start: string; end: string }[], row, i, list) => {
    const dur = (() => {
      const [sh, sm] = row.start.split(":").map(Number);
      const [eh, em] = row.end.split(":").map(Number);
      return eh! * 60 + em! - (sh! * 60 + sm!);
    })();
    const start = i ? acts[i - 1]!.end : "08:00";
    const [h, m] = start.split(":").map(Number);
    const t = h! * 60 + m! + dur;
    const end = String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    acts.push({ id: row.id, start, end });
    return acts;
  }, []);
  assert(swapped[0]!.id === "M2" && swapped[0]!.start === "08:00" && swapped[0]!.end === "08:20", "swap restacks first");
  assert(swapped[1]!.id === "M1" && swapped[1]!.start === "08:20" && swapped[1]!.end === "08:25", "swap restacks second");
  assert(swapped[2]!.start === "08:25" && swapped[2]!.end === "08:40", "swap keeps last span");
}

{
  const owRoot = mkdtempSync(path.join(tmpdir(), "flag-period-ow-"));
  mkdirSync(path.join(owRoot, "library", "periods"), { recursive: true });
  try {
    const id = "2026-09-15-G6";
    savePeriod(owRoot, id, {
      id,
      date: "2026-09-15",
      grade: "G6",
      activities: [{ id: "M2", start: "08:00", end: "08:20" }],
      reflection: { flags: ["too easy"], text: "keep me" },
      plan: "excel dump",
      objective: "old objective",
    });
    savePeriod(owRoot, id, {
      id,
      date: "2026-09-15",
      grade: "G6",
      activities: [
        { id: "M1", start: "08:00", end: "08:05" },
        { id: "M9", start: "08:05", end: "08:25" },
      ],
      reflection: { flags: ["too easy"], text: "keep me" },
      plan: "excel dump",
      objective: "Identify a catchable snap.",
    });
    const after = getPeriod(owRoot, id)!;
    assert(after.activities?.length === 2 && after.activities[0]!.id === "M1", "second save overwrites pins");
    assert(!after.activities!.some((a) => a.id === "M2"), "old pin gone");
    assert(after.reflection.text === "keep me" && after.plan === "excel dump", "reflection and plan stay");
    const createdId = "2026-10-10-G6";
    savePeriod(owRoot, createdId, {
      id: createdId,
      date: "2026-10-10",
      grade: "G6",
      activities: [{ id: "M1", start: "08:00", end: "08:05" }],
      reflection: { flags: [], text: "" },
    });
    assert(getPeriod(owRoot, createdId)?.date === "2026-10-10", "create one missing date");
    assert(getPeriod(owRoot, "2026-10-11-G6") == null, "does not create other dates");
  } finally {
    rmSync(owRoot, { recursive: true, force: true });
  }
}

{
  const flatRoot = mkdtempSync(path.join(tmpdir(), "flag-period-"));
  mkdirSync(path.join(flatRoot, "library", "periods"), { recursive: true });
  mkdirSync(path.join(flatRoot, "library", "materials"), { recursive: true });
  try {
    writeFileSync(path.join(flatRoot, "library", "periods", "2026-09-18-G7.md"), `---
id: 2026-09-18-G7
date: 2026-09-18
grade: G7
instant: M84
skill: M91
key: M94
activities:
  instant:
    - id: M84
  skill:
    - id: M91
  key:
    - id: M94
times:
  instant:
    start: 13:00
    end: 13:12
  skill:
    start: 13:12
    end: 13:25
  key:
    start: 13:25
    end: 13:38
reflection:
  flags: []
  text: ""
---
`);
    const loaded = getPeriod(flatRoot, "2026-09-18-G7");
    assert(Array.isArray(loaded?.activities) && loaded!.activities.length === 3, "legacy lanes flatten");
    assert(loaded!.activities![1].id === "M91" && loaded!.activities![1].start === "13:12", "skill clock split");
    savePeriod(flatRoot, loaded!.id, loaded!);
    const written = readFileSync(path.join(flatRoot, "library", "periods", "2026-09-18-G7.md"), "utf8");
    assert(!written.includes("skill:"), "writePeriod drops lane keys");
    assert(written.includes("start:"));
  } finally {
    rmSync(flatRoot, { recursive: true, force: true });
  }
}

function historyIndex(base: string) {
  const indexPath = path.join(base, "library", ".history", "index.json");
  return JSON.parse(readFileSync(indexPath, "utf8")) as {
    entries: { id: string; label: string; files: { rel: string; existed: boolean }[] }[];
  };
}

{
  const mergeRoot = mkdtempSync(path.join(tmpdir(), "flag-merge-"));
  mkdirSync(path.join(mergeRoot, "library", "materials"), { recursive: true });
  mkdirSync(path.join(mergeRoot, "library", "periods"), { recursive: true });
  try {
    writeSeedMaterial(mergeRoot, { id: "M1", name: "Half-kneeling throw", look: "", notes: "keep how-to", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(mergeRoot, { id: "M2", name: "Kneel catch", look: "knee down", notes: "", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(mergeRoot, { id: "M4", name: "Partner", look: "pair", notes: "", motorSkills: [], skillRelatedComponents: [] });
    createSet(mergeRoot, { name: "Dup set", members: ["M2"] });
    createLink(mergeRoot, { from: "M2", kind: "related", to: "M4", note: "same station", tag: "same station" });
    savePeriod(mergeRoot, "2026-09-15-G6", {
      id: "2026-09-15-G6",
      date: "2026-09-15",
      grade: "G6",
      activities: [{ id: "M2", start: "08:00", end: "08:20" }],
      reflection: { flags: [], text: "" },
    });
    const before = new Set(listHistory(mergeRoot).map((row) => row.id));
    const r = applyKgOps(mergeRoot, [{ entity: "material", action: "de_dup", keep: "M1", drop: "M2" }]);
    assert(r.applied === 1 && !r.errors.length, "de_dup applied: " + r.errors.join("; "));
    const mats = listMaterials(mergeRoot);
    assert(mats.some((m) => m.id === "M1") && !mats.some((m) => m.id === "M2"), "drop deleted");
    const keep = mats.find((m) => m.id === "M1")!;
    assert(keep.look === "knee down", "copied empty look from drop");
    assert(keep.notes === "keep how-to", "kept existing notes");
    assert(listSets(mergeRoot).some((s) => s.members.includes("M1") && !s.members.includes("M2")), "set retarget");
    assert(listLinks(mergeRoot).some((L) => L.from === "M1" && L.to === "M4"), "link retarget");
    assert(getPeriod(mergeRoot, "2026-09-15-G6")?.activities?.[0]?.id === "M1", "period id rewritten");
    const added = historyIndex(mergeRoot).entries.filter((row) => !before.has(row.id));
    assert(added.some((row) => row.label === "delete M2"), "de_dup records the dropped card");
    assert(added.some((row) => row.label === "write M1"), "de_dup records the keeper");
    for (const row of added.slice().reverse()) restoreHistory(mergeRoot, row.id);
    const restored = listMaterials(mergeRoot);
    assert(restored.some((m) => m.id === "M2"), "recall brings the dropped card back");
    const keeper = restored.find((m) => m.id === "M1")!;
    assert(keeper.look === "" && keeper.notes === "keep how-to", "recall restores the keeper text");
    assert(listLinks(mergeRoot).some((L) => L.from === "M2" && L.to === "M4"), "recall restores the dropped link");
    assert(getPeriod(mergeRoot, "2026-09-15-G6")?.activities?.[0]?.id === "M2", "recall restores the period pin");
  } finally {
    rmSync(mergeRoot, { recursive: true, force: true });
  }
}

{
  const facetRoot = mkdtempSync(path.join(tmpdir(), "flag-chat-facets-"));
  mkdirSync(path.join(facetRoot, "library", "materials"), { recursive: true });
  try {
    const r = applyKgOps(facetRoot, [{
      entity: "material",
      action: "create",
      name: "Initiate the play — Center snap and catch",
      look: "Center snaps on go",
      notes: "Snap then catch.",
      duration: 20,
      motorSkills: ["catching", "throwing"],
      skillRelatedComponents: ["reaction time", "agility", "decision making"],
    }]);
    assert(r.applied === 1 && !r.errors.length, "lowercase chat facets apply: " + r.errors.join("; "));
    const created = listMaterials(facetRoot).find((m) => m.name.startsWith("Initiate the play"));
    assert(created, "material written");
    assert(created!.motorSkills.includes("Catching") && created!.motorSkills.includes("Throwing"), "motors canonical");
    assert(created!.skillRelatedComponents.includes("Reaction Time") && created!.skillRelatedComponents.includes("Agility"), "components canonical");
    assert(!created!.skillRelatedComponents.some((s) => /decision/i.test(s)), "unknown component dropped");
  } finally {
    rmSync(facetRoot, { recursive: true, force: true });
  }
}

{
  const hopRoot = mkdtempSync(path.join(tmpdir(), "flag-apply-hops-"));
  mkdirSync(path.join(hopRoot, "library", "materials"), { recursive: true });
  try {
    writeSeedMaterial(hopRoot, { id: "M1", name: "Easy", look: "", notes: "", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(hopRoot, { id: "M2", name: "Mid", look: "", notes: "", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(hopRoot, { id: "M3", name: "Hard", look: "", notes: "", motorSkills: [], skillRelatedComponents: [] });
    createLink(hopRoot, { from: "M1", kind: "progression", to: "M2", note: "" });
    createLink(hopRoot, { from: "M2", kind: "progression", to: "M3", note: "" });
    const r = applyKgOps(hopRoot, [
      { entity: "material", action: "create", name: "Alpha extra" },
      { entity: "material", action: "create", name: "Beta extra" },
      { entity: "link", action: "create", kind: "related", from: "M1", to: "M3", tag: "same drill" },
    ]);
    assert(r.created.nodes === 2, "created two materials");
    assert(r.created.links === 0, "illegal related not written");
    assert(r.errors.length > 0 && /progression chain/.test(r.errors.join(" ")), "related error kept");
    const report = formatKgApplyReport(r);
    assert(/2 nodes created/.test(report) && /0 connections created/.test(report) && /failed because/.test(report), "apply report line");
  } finally {
    rmSync(hopRoot, { recursive: true, force: true });
  }
}

{
  const varRoot = mkdtempSync(path.join(tmpdir(), "flag-merge-var-"));
  mkdirSync(path.join(varRoot, "library", "materials"), { recursive: true });
  try {
    writeSeedMaterial(varRoot, { id: "M1", name: "Parent throw", look: "parent", notes: "", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(varRoot, { id: "M2", name: "Child throw", look: "child", notes: "", motorSkills: [], skillRelatedComponents: [] });
    createLink(varRoot, { from: "M1", kind: "related", to: "M2", note: "same idea", tag: "variation to Parent throw" });
    const r = applyKgOps(varRoot, [{ entity: "material", action: "de_dup", keep: "M1", drop: "M2" }]);
    assert(r.applied === 0 && r.errors.some((e) => /variation/i.test(e)), "refuse variation merge");
    assert(listMaterials(varRoot).filter((m) => m.id === "M1" || m.id === "M2").length === 2, "variation pair kept");
  } finally {
    rmSync(varRoot, { recursive: true, force: true });
  }
}

{
  const chainRoot = mkdtempSync(path.join(tmpdir(), "flag-merge-chain-"));
  mkdirSync(path.join(chainRoot, "library", "materials"), { recursive: true });
  try {
    writeSeedMaterial(chainRoot, { id: "M1", name: "Kneel", look: "knee", notes: "", motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(chainRoot, { id: "M2", name: "Stand", look: "stand", notes: "", motorSkills: [], skillRelatedComponents: [] });
    createLink(chainRoot, { from: "M1", kind: "progression", to: "M2", note: "step up" });
    const r = applyKgOps(chainRoot, [{ entity: "material", action: "de_dup", keep: "M1", drop: "M2" }]);
    assert(r.applied === 0 && r.errors.some((e) => /chain/i.test(e)), "refuse chain merge");
    assert(listMaterials(chainRoot).filter((m) => m.id === "M1" || m.id === "M2").length === 2, "chain pair kept");
    const misuse = applyKgOps(chainRoot, [{ entity: "material", action: "merge", keep: "M1", drop: "M2" }]);
    assert(misuse.applied === 0 && misuse.errors.some((e) => /de_dup/.test(e)), "keep/drop merge is not dedup");
  } finally {
    rmSync(chainRoot, { recursive: true, force: true });
  }
}

{
  const composeRoot = mkdtempSync(path.join(tmpdir(), "flag-compose-"));
  mkdirSync(path.join(composeRoot, "library", "materials"), { recursive: true });
  try {
    writeSeedMaterial(composeRoot, { id: "M1", name: "Kneel", look: "knee", notes: "how a", duration: 8, motorSkills: [], skillRelatedComponents: [], classNotes: [{ date: "2026-09-10", grade: "G6", text: "belt on" }] });
    writeSeedMaterial(composeRoot, { id: "M2", name: "Stand", look: "stand", notes: "how b", duration: 12, motorSkills: [], skillRelatedComponents: [] });
    writeSeedMaterial(composeRoot, { id: "M3", name: "Outside", look: "watch", notes: "", motorSkills: [], skillRelatedComponents: [] });
    updateMaterial(composeRoot, "M1", { motorSkills: ["Throwing"] });
    updateMaterial(composeRoot, "M2", { motorSkills: ["Catching"] });
    createLink(composeRoot, { from: "M3", kind: "progression", to: "M1", note: "into the parts" });
    createLink(composeRoot, { from: "M1", kind: "progression", to: "M2", note: "step up" });
    createSet(composeRoot, { name: "Parts", members: ["M1"] });
    const before = new Set(listHistory(composeRoot).map((row) => row.id));
    const r = applyKgOps(composeRoot, [{ entity: "material", action: "merge", sources: ["M1", "M2"] }]);
    assert(r.applied === 1 && !r.errors.length, "composite merge applied: " + r.errors.join("; "));
    const mats = listMaterials(composeRoot);
    const composite = mats.find((m) => m.id === "M4");
    assert(composite && mats.some((m) => m.id === "M1") && mats.some((m) => m.id === "M2"), "sources stay and a new node is created");
    assert(composite!.name === "Kneel + Stand", "default name joins the sources");
    assert(composite!.look.includes("knee") && composite!.look.includes("stand"), "look is the union");
    assert(composite!.notes!.includes("how a") && composite!.notes!.includes("how b"), "notes are the union");
    assert(composite!.duration === 12, "duration is the longer source");
    assert(composite!.motorSkills.includes("Throwing") && composite!.motorSkills.includes("Catching"), "motor skills union");
    assert((composite!.classNotes || []).some((n) => n.text === "belt on"), "class notes union");
    const links = listLinks(composeRoot);
    assert(links.some((L) => L.kind === "progression" && L.from === "M1" && L.to === "M4"), "A progresses to the composite");
    assert(links.some((L) => L.kind === "regression" && L.from === "M1" && L.to === "M4"), "A regresses toward the composite");
    assert(links.some((L) => L.kind === "progression" && L.from === "M2" && L.to === "M4"), "B progresses to the composite");
    assert(!links.some((L) => L.from === "M1" && L.to === "M2"), "the old A to B hop is gone");
    assert(links.some((L) => L.from === "M3" && L.to === "M4") && !links.some((L) => L.from === "M3" && L.to === "M1"), "outside hop points at the composite");
    assert(listSets(composeRoot).some((s) => s.members.includes("M1") && s.members.includes("M4")), "set keeps the source and gains the composite");
    const added = historyIndex(composeRoot).entries.filter((row) => !before.has(row.id));
    const createdSnap = added.find((row) => row.label === "write M4");
    assert(createdSnap && createdSnap.files.some((file) => file.rel.endsWith("M4.md") && file.existed === false), "merge records the new card as a new file");
    assert(added.some((row) => row.label === "write M1") && added.some((row) => row.label === "write M3"), "merge records the files whose hops moved");
    for (const row of added.slice().reverse()) restoreHistory(composeRoot, row.id);
    assert(!listMaterials(composeRoot).some((m) => m.id === "M4"), "recall removes the composite");
    const back = listLinks(composeRoot);
    assert(back.some((L) => L.kind === "progression" && L.from === "M1" && L.to === "M2"), "recall restores A to B");
    assert(back.some((L) => L.kind === "progression" && L.from === "M3" && L.to === "M1"), "recall restores the outside hop");
  } finally {
    rmSync(composeRoot, { recursive: true, force: true });
  }
}

{
  const logRoot = mkdtempSync(path.join(tmpdir(), "flag-chatlog-"));
  mkdirSync(path.join(logRoot, "library"), { recursive: true });
  try {
    for (let i = 1; i <= 4; i++) {
      writeChatLog(logRoot, { history: [{ role: "user", content: String(i) }], ops: [{ n: i }] });
    }
    const log = pruneChatLog(logRoot);
    assert(log.sessions.length === 1, "legacy writes one session");
    assert(log.sessions[0]!.steps.length === 4, "append all steps");
    assert(log.sessions[0]!.steps[3]!.history[0]!.content === "4", "keeps fourth step");
    const old = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(path.join(logRoot, "library", ".chat-session", "chat.json"), JSON.stringify({
      writtenAt: old,
      currentId: "s1",
      sessions: [{ id: "s1", title: "Old", writtenAt: old, steps: [{ at: old, history: [], ops: [{}] }] }],
    }));
    const pruned = pruneChatLog(logRoot);
    assert(!pruned.sessions.length && !pruned.steps.length, "stale session writtenAt prunes");
    const named = writeChatLog(logRoot, {
      currentId: "s-keep",
      sessions: [
        { id: "s-keep", title: "Routes", writtenAt: Date.now(), steps: [] },
        { id: "s-drop", title: "Drop me", writtenAt: Date.now(), steps: [] },
      ],
    });
    assert(named.sessions.length === 2 && named.sessions[0]!.title === "Routes", "two sessions saved");
    const after = writeChatLog(logRoot, {
      currentId: "s-keep",
      sessions: [{ id: "s-keep", title: "Route running", writtenAt: Date.now(), steps: [] }],
    });
    assert(after.sessions.length === 1 && after.sessions[0]!.id === "s-keep", "deleted session dropped");
    assert(after.sessions[0]!.title === "Route running", "renamed title persisted");
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
}

{
  const eight: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 1; i <= 8; i++) eight.push({ role: i % 2 ? "user" : "assistant", content: String(i) });
  const win = llmHistoryWindow(eight, 3);
  assert(win.length === 6 && win[0]!.content === "3" && win[5]!.content === "8", "llmHistoryWindow keeps last 3 pairs");
}

{
  const mats = [{ id: "M1", name: "Hot Potato", look: "circle pass", notes: "pass in a circle", duration: 5, motorSkills: [], skillRelatedComponents: [] }];
  const vectors = { M1: [1, 0] };
  const parsedNotes = parseSkillItems([{ name: "X", look: "cue", explanation: "how" }]);
  assert(parsedNotes[0]!.look === "cue" && parsedNotes[0]!.notes === "how", "parseSkillItems reads explanation as notes");
  const allNew = dupCheckItems(
    [{ name: "Brand New A", look: "cue a", notes: "how a" }, { name: "Brand New B", look: "cue b", notes: "how b" }],
    mats,
    vectors,
    [[0, 1], [0, 1]],
  );
  const drafted = createMaterialsFromDupCheck(allNew, "create-materials");
  assert(drafted.taskState.phase === "create-missing" && (drafted.ops || []).length === 2 && !drafted.fields, "all-new skips to create ops");
  assert(drafted.ops![0]!.look === "cue a" && drafted.ops![0]!.notes === "how a", "create ops carry look and notes");
  const mixed = dupCheckItems(
    [{ name: "Hot Potato", look: "circle pass", notes: "pass in a circle" }, { name: "Brand New Flag Drill", look: "flag cue", notes: "flag how" }],
    mats,
    vectors,
    [[1, 0], [0, 1]],
  );
  assert(mixed[0]!.existingId === "M1" && mixed[0]!.score! >= DUP_SCORE && !mixed[1]!.existingId, "dup score gates existing vs missing");
  const pause = createMaterialsFromDupCheck(mixed, "create-materials");
  assert(pause.taskState.phase === "create-missing" && (pause.ops || []).length === 1 && pause.ops![0]!.name === "Brand New Flag Drill", "mixed discards duplicate and creates missing");
  assert(pause.fields && pause.fields[0]!.materialId === "M1" && !(pause.fields[0]!.choices && pause.fields[0]!.choices.length), "discarded dup is a chip, no keep/overwrite");
  assert(pause.ops![0]!.look === "flag cue" && pause.ops![0]!.notes === "flag how", "remaining create has look and notes");
  const allDup = createMaterialsFromDupCheck(mixed.filter((i) => i.existingId), "create-materials");
  assert(allDup.taskState.phase === "done" && !(allDup.ops && allDup.ops.length), "all duplicates discard with no create ops");
}

{
  const histRoot = mkdtempSync(path.join(tmpdir(), "flag-hist-"));
  try {
    const one = applyKgOps(histRoot, [
      { entity: "material", action: "create", name: "Alpha batch" },
      { entity: "material", action: "create", name: "Beta batch" },
    ]);
    assert(one.applied === 2 && !one.errors.length, "batch creates: " + one.errors.join("; "));
    const materialWrites = listHistory(histRoot).filter((row) => /^write M\d+$/.test(row.label));
    assert(materialWrites.length === 2, "each created material is its own history entry");
    assert(!listHistory(histRoot).some((row) => row.label.includes(",")), "a batch is not one combined label");
    createMaterial(histRoot, { name: "Lone card" });
    assert(listHistory(histRoot).filter((row) => /^write M\d+$/.test(row.label)).length === 3, "a lone material write is one round");
  } finally {
    rmSync(histRoot, { recursive: true, force: true });
  }
}

{
  const ringRoot = mkdtempSync(path.join(tmpdir(), "flag-hist-ring-"));
  try {
    createMaterial(ringRoot, { name: "Old ring" });
    createMaterial(ringRoot, { name: "Fresh ring" });
    const indexPath = path.join(ringRoot, "library", ".history", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: { id: string; at: string; label: string }[] };
    const old = data.entries[0]!;
    old.at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(indexPath, JSON.stringify(data));
    const listed = listHistory(ringRoot);
    assert(!listed.some((row) => row.id === old.id), "a 25-hour-old entry is gone");
    assert(listed.some((row) => row.label.startsWith("write M")), "a fresh entry remains");
  } finally {
    rmSync(ringRoot, { recursive: true, force: true });
  }
}

{
  const undoRoot = mkdtempSync(path.join(tmpdir(), "flag-hist-undo-"));
  try {
    const created = applyKgOps(undoRoot, [
      { entity: "material", action: "create", name: "Keep me" },
      { entity: "material", action: "create", name: "Drop me" },
    ]);
    assert(created.applied === 2 && !created.errors.length, "two creates: " + created.errors.join("; "));
    const indexPath = path.join(undoRoot, "library", ".history", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: { id: string; label: string; files: { rel: string }[] }[] };
    const drop = data.entries.find((row) => row.files.some((file) => file.rel.endsWith("M2.md")));
    assert(drop, "the second material has its own entry");
    restoreHistory(undoRoot, drop!.id);
    assert(listMaterials(undoRoot).some((m) => m.name === "Keep me"), "restore leaves the other file");
    assert(!listMaterials(undoRoot).some((m) => m.name === "Drop me"), "restore removes only the chosen file");
    assert(listHistory(undoRoot).some((row) => row.label === "restore"), "restore pushes a restore round");
    assert(listHistory(undoRoot).some((row) => row.label === "write M1"), "the other entry stays");
  } finally {
    rmSync(undoRoot, { recursive: true, force: true });
  }
}

{
  const refRoot = mkdtempSync(path.join(tmpdir(), "flag-reflect-parsed-"));
  mkdirSync(path.join(refRoot, "library", "periods"), { recursive: true });
  try {
    const mat = createMaterial(refRoot, { name: "Snap" });
    savePeriod(refRoot, "2026-10-08-G6", {
      id: "2026-10-08-G6",
      date: "2026-10-08",
      grade: "G6",
      activities: [{ id: mat.id, start: "08:00", end: "08:20" }],
      reflection: { flags: ["too easy"], text: "Too easy on the snap." },
    });
    let calls = 0;
    setChatOnceForTests(async () => {
      calls += 1;
      return JSON.stringify({
        tags: ["@" + mat.id],
        observations: [{ id: mat.id, judgment: "too_easy" }],
        nextGoalLlm: "Add a drop step.",
      });
    });
    const parsed = await reflect(refRoot, "2026-10-08-G6", {
      tags: ["@" + mat.id],
      observations: [{ id: mat.id, judgment: "too_easy" }],
      nextGoalLlm: "Add a drop step.",
    });
    assert(calls === 0, "parsed output does not call the model");
    assert(parsed.output.nextGoalLlm === "Add a drop step.", "parsed output applied");
    assert(/next period:/.test(parsed.period.nextGoal || ""), "next goal merged");
    const modeled = await reflect(refRoot, "2026-10-08-G6");
    assert(calls === 1, "missing output still uses the model loop");
    assert(modeled.output.observations[0]!.id === mat.id, "model output accepted");
  } finally {
    setChatOnceForTests(null);
    rmSync(refRoot, { recursive: true, force: true });
  }
}

{
  const classRoot = mkdtempSync(path.join(tmpdir(), "flag-class-links-"));
  mkdirSync(path.join(classRoot, "library", "materials"), { recursive: true });
  mkdirSync(path.join(classRoot, "library", "periods"), { recursive: true });
  try {
    const blank = { look: "", notes: "", motorSkills: [] as string[], skillRelatedComponents: [] as string[] };
    writeSeedMaterial(classRoot, { id: "M1", name: "A", ...blank });
    writeSeedMaterial(classRoot, { id: "M2", name: "B", ...blank });
    writeSeedMaterial(classRoot, { id: "M3", name: "C", ...blank });
    createLink(classRoot, { from: "M1", kind: "progression", to: "M2", note: "step" });
    createLink(classRoot, { from: "M2", kind: "related", to: "M3", note: "same idea", tag: "variation to A" });
    const reflection = { flags: [] as string[], text: "" };
    const stack = (ids: string[]) => ids.map((id, i) => ({ id, start: `08:${String(i * 5).padStart(2, "0")}`, end: `08:${String(i * 5 + 5).padStart(2, "0")}` }));
    savePeriod(classRoot, "2026-10-11-G6", {
      id: "2026-10-11-G6",
      date: "2026-10-11",
      grade: "G6",
      activities: stack(["M1", "M2", "M3"]),
      reflection,
    });
    const tags = (from: string, to: string) => listLinks(classRoot).filter((L) => L.kind === "related" && L.from === from && L.to === to).map((L) => L.tag || "");
    assert(tags("M2", "M1").includes("2026-10-11 G6 · in one class (the step after A)"), "B follows A");
    assert(tags("M3", "M2").includes("2026-10-11 G6 · in one class (the step after B)"), "C follows B");
    assert(listLinks(classRoot).some((L) => L.kind === "progression" && L.from === "M1" && L.to === "M2"), "chain still there");
    assert(tags("M2", "M3").includes("variation to A"), "variation tag stays");
    savePeriod(classRoot, "2026-10-11-G6", {
      id: "2026-10-11-G6",
      date: "2026-10-11",
      grade: "G6",
      activities: stack(["M1", "M3", "M2"]),
      reflection,
    });
    assert(tags("M3", "M1").includes("2026-10-11 G6 · in one class (the step after A)"), "reorder: C follows A");
    assert(tags("M2", "M3").includes("2026-10-11 G6 · in one class (the step after C)"), "reorder: B follows C");
    assert(!tags("M2", "M1").some((t) => t.startsWith("2026-10-11")), "old B-after-A hop for that class is gone");
    assert(!tags("M3", "M2").some((t) => t.includes("2026-10-11")), "old C-after-B hop for that class is gone");
    assert(tags("M2", "M3").includes("variation to A"), "reorder leaves the variation hop");
    savePeriod(classRoot, "2026-10-12-G6", {
      id: "2026-10-12-G6",
      date: "2026-10-12",
      grade: "G6",
      activities: stack(["M1", "M2"]),
      reflection,
    });
    assert(tags("M2", "M1").includes("2026-10-12 G6 · in one class (the step after A)"), "second class keeps its own date");
    assert(tags("M3", "M1").includes("2026-10-11 G6 · in one class (the step after A)"), "the other class tag stays");
    updateMaterial(classRoot, "M1", { name: "Apex" });
    savePeriod(classRoot, "2026-10-11-G6", {
      id: "2026-10-11-G6",
      date: "2026-10-11",
      grade: "G6",
      activities: stack(["M1", "M3", "M2"]),
      reflection,
    });
    assert(tags("M3", "M1").includes("2026-10-11 G6 · in one class (the step after Apex)"), "renamed step uses the new name");
    assert(!tags("M3", "M1").some((t) => t.includes("step after A)")), "old name tag for that class is replaced");
    assert(tags("M2", "M1").includes("2026-10-12 G6 · in one class (the step after A)"), "the unsaved class keeps its tag");
    const both = neighborsOf("M2", listLinks(classRoot)).related.filter((h) => h.id === "M3");
    assert(both.length === 2 && both.every((h) => h.tag), "variation and class hops both show");
  } finally {
    rmSync(classRoot, { recursive: true, force: true });
  }
}

console.log("llm.test.ts ok");
