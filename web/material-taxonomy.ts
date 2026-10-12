export const MOTOR_SKILLS = [
  "Throwing",
  "Catching",
  "Snapping",
  "Handing off",
  "Route running",
  "Ball carrying",
  "Flag pulling",
  "Guarding",
  "Footwork",
  "Lateral movement",
  "Cutting",
  "Running",
  "Jumping / hopping",
  "Positioning",
  "Lunging",
  "Squatting",
] as const;

export const SKILL_RELATED_COMPONENTS = [
  "Agility",
  "Balance",
  "Coordination",
  "Power",
  "Reaction Time",
  "Speed",
] as const;

export type MotorSkill = (typeof MOTOR_SKILLS)[number];
export type SkillRelatedComponent = (typeof SKILL_RELATED_COMPONENTS)[number];

const MOTOR_SET = new Set<string>(MOTOR_SKILLS);
const COMPONENT_SET = new Set<string>(SKILL_RELATED_COMPONENTS);

export function isMotorSkill(value: string): value is MotorSkill {
  return MOTOR_SET.has(value);
}

export function isSkillRelatedComponent(value: string): value is SkillRelatedComponent {
  return COMPONENT_SET.has(value);
}

function asList(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function uniqueInOrder<T extends string>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseMotorSkills(raw: unknown, unknownPolicy: "drop" | "reject"): MotorSkill[] {
  const out: MotorSkill[] = [];
  for (const item of asList(raw)) {
    const hit = MOTOR_SKILLS.find((s) => s === item || s.toLowerCase() === item.toLowerCase());
    if (!hit) {
      if (unknownPolicy === "reject") throw new Error("unknown motor skill: " + item);
      continue;
    }
    out.push(hit);
  }
  return uniqueInOrder(out);
}

export function parseSkillRelatedComponents(raw: unknown, unknownPolicy: "drop" | "reject"): SkillRelatedComponent[] {
  const out: SkillRelatedComponent[] = [];
  for (const item of asList(raw)) {
    const hit = SKILL_RELATED_COMPONENTS.find((s) => s === item || s.toLowerCase() === item.toLowerCase());
    if (!hit) {
      if (unknownPolicy === "reject") throw new Error("unknown skill-related component: " + item);
      continue;
    }
    out.push(hit);
  }
  return uniqueInOrder(out);
}

export function sharesMotorSkill(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const other = new Set(b);
  return a.some((item) => other.has(item));
}

export function compactMotorLabel(skills: readonly string[] | undefined): string {
  if (!skills?.length) return "";
  return skills.slice(0, 2).join(", ");
}

export function facetText(skills: readonly string[] | undefined, components: readonly string[] | undefined): string {
  return [...(skills || []), ...(components || [])].join(" ");
}
