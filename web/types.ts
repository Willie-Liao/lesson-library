import type { MotorSkill, SkillRelatedComponent } from "./material-taxonomy";

export type { MotorSkill, SkillRelatedComponent } from "./material-taxonomy";

export type LinkKind = "regression" | "progression" | "related";

export type Material = {
  id: string;
  name: string;
  look: string;
  motorSkills: MotorSkill[];
  skillRelatedComponents: SkillRelatedComponent[];
  /** Minutes this drill usually takes. Missing → 20. */
  duration?: number;
  notes?: string;
  /** How the drill is done. Dual-read from notes when YAML body is the explanation. */
  explanation?: string;
  sketch?: string;
  classNotes?: ClassNote[];
};

export type Link = {
  from: string;
  kind: LinkKind;
  to: string;
  note: string;
  tag?: string;
  /** Chain hop difficulty; missing means 1. Related hops ignore this. */
  leap?: number;
  /** How many Elo updates this hop has had. */
  nudgeCount?: number;
};

export type SetOrigin = "default" | "unit" | "teacher";

/** Named skill (empty root) or activity set (group of activities). Not a hop. Stored in library/_sets.yaml. */
export type MaterialSet = {
  id: string;
  name: string;
  note: string;
  members: string[];
  parent?: string | null;
  origin?: SetOrigin;
};

export type Foci = {
  items: { n: number; text: string }[];
  now: number;
};

export type Grade = string;

export type ClassNote = {
  date: string;
  grade: Grade;
  text: string;
};

export type CalendarScope = Grade | "all";

export type CalendarFocusDefinition = {
  id: string;
  label: string;
  color: string;
};

export type CalendarEntryBase = {
  id: string;
  startDate: string;
  endDate: string;
  scope: CalendarScope;
};

export type FocusCalendarEntry = CalendarEntryBase & {
  kind: "focus";
  focusId: string;
};

export type WorkdayCalendarEntry = CalendarEntryBase & {
  kind: "workday";
  label: string;
  color: string;
  tagId: string;
};

export type SchoolActivityCalendarEntry = CalendarEntryBase & {
  kind: "schoolActivity";
  label: string;
  color: string;
  tagId: string;
};

export type CalendarEntry = FocusCalendarEntry | WorkdayCalendarEntry | SchoolActivityCalendarEntry;

export type CalendarClassDays = Record<string, number[]>;

export type CalendarData = {
  version: 1;
  foci: CalendarFocusDefinition[];
  workdays: CalendarFocusDefinition[];
  schoolActivities: CalendarFocusDefinition[];
  entries: CalendarEntry[];
  /** ISO weekday 1=Mon … 7=Sun when that grade has class. */
  classDays?: CalendarClassDays;
};

export type CalendarMonthCell = {
  iso: string;
  inMonth: boolean;
  dow: number;
};

export type CalendarWeekSegment = {
  startDate: string;
  endDate: string;
};

export type CalendarValidation = { ok: true } | { ok: false; message: string };

export type PeriodActivity = {
  id: string;
  start: string;
  end: string;
  easier?: string[];
  harder?: string[];
  alts?: string[];
};

export type PatchOp = {
  entity: "material" | "link" | "set";
  action: "create" | "update" | "delete" | "merge" | "de_dup";
  [key: string]: unknown;
};

export type Period = {
  id: string;
  date: string;
  grade: Grade;
  activities?: PeriodActivity[];
  reflection: { flags: string[]; text: string; savedAt?: string };
  /** LLM / teacher summary of the pins on this date. */
  objective?: string;
  /** Teacher target for the next period; feeds Suggest next (goal mode). */
  nextGoal?: string;
  /** Excel / teacher plan dump. UI does not edit it; savePeriod must round-trip it. */
  plan?: string;
};

export type SlotPick = { id: string; why: string; start?: string; end?: string; date?: string; grade?: Grade };

export type ClarifyField = {
  id: string;
  label: string;
  value: string;
  choices?: { id: string; name: string }[];
  materialId?: string;
};

export type ChatTaskItem = {
  id: string;
  name: string;
  look?: string;
  notes?: string;
  existingId?: string;
  existingName?: string;
  score?: number;
};

export type ChatTaskState = {
  skill: "create-materials" | "write-lesson-in-schedule";
  phase: "dup-check" | "create-missing" | "clarify" | "date-slots" | "kg-query" | "done";
  items: ChatTaskItem[];
};

export type PeriodTarget = {
  id?: string;
  date?: string;
  grade?: Grade;
  create?: boolean;
};

export type SuggestionDay = {
  date: string;
  grade?: Grade;
  picks: SlotPick[];
  objective?: string;
};

export type Suggestion = {
  focus: number;
  summary: string;
  picks: SlotPick[];
  objective?: string;
  reply?: string;
  ops?: PatchOp[];
  fields?: ClarifyField[];
  taskState?: ChatTaskState;
  periodTarget?: PeriodTarget;
  days?: SuggestionDay[];
  ranked?: { id: string; depth?: number; leap?: number; duration?: number; cluster?: number }[];
  lookupCache?: {
    demand: string;
    grade: string;
    dateSlots?: { date: string; grade: string; id: string; exists: boolean; empty: boolean }[];
    kg?: { id: string; name?: string; look?: string; notes?: string; duration?: number }[];
    nodes?: number;
    edges?: number;
  };
  reads: {
    foci: number;
    nodes: number;
    edges: number;
    layout: boolean;
    reflection: boolean;
    fromCache?: boolean;
  };
};

export type Neighbor = { id: string; note: string; tag?: string; score?: number; rank?: number; leap?: number };

export type Neighbors = {
  regression: Neighbor[];
  progression: Neighbor[];
  related: Neighbor[];
};

export type SearchHit = { id: string; score: number; name?: string };

export type SearchResult = {
  hits: SearchHit[];
  mode: "embed" | "text";
  keyword: SearchHit[];
  semantic: SearchHit[];
};

export type StrokeTier = "chain" | "related";

export type GraphEdge = {
  source: string;
  target: string;
  kinds: LinkKind[];
  w: number;
  directed: boolean;
  easier?: string;
  harder?: string;
  notes: string[];
  tags: string[];
  links: Link[];
  pending?: boolean;
};

export type GhostEdge = {
  source: string;
  target: string;
  wGhost: number;
  reason: "set" | "cluster";
};
