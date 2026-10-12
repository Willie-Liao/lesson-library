import type { MaterialSet } from "./types";

export const MOTOR_ROOT_NAME = "Motor skills";
export const COMPONENT_ROOT_NAME = "Skill-related components";

function byId(sets: MaterialSet[]): Map<string, MaterialSet> {
  return new Map(sets.map((s) => [s.id, s]));
}

export function parentId(s: MaterialSet): string | null {
  return s.parent || null;
}

export function childrenOf(sets: MaterialSet[], id: string): MaterialSet[] {
  return sets.filter((s) => parentId(s) === id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function rootRank(s: MaterialSet): number {
  if (s.name === MOTOR_ROOT_NAME) return 0;
  if (s.name === COMPONENT_ROOT_NAME) return 1;
  return 2;
}

export type RootKind = "first" | "independent";

/** first = skill (empty parentless folder). independent = activity set with members and no parent skill. */

export function roots(sets: MaterialSet[], kind?: RootKind): MaterialSet[] {
  const all = sets
    .filter((s) => !parentId(s))
    .sort((a, b) => rootRank(a) - rootRank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (kind === "first") return all.filter((s) => !s.members.length);
  if (kind === "independent") return all.filter((s) => s.members.length > 0);
  return all;
}

export function ancestorsOf(sets: MaterialSet[], id: string): MaterialSet[] {
  const map = byId(sets);
  const out: MaterialSet[] = [];
  const seen = new Set<string>();
  let cur = map.get(id);
  while (cur) {
    const p = parentId(cur);
    if (!p || seen.has(p)) break;
    seen.add(p);
    const next = map.get(p);
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

export function pathOf(sets: MaterialSet[], id: string): MaterialSet[] {
  const self = sets.find((s) => s.id === id);
  if (!self) return [];
  return [...ancestorsOf(sets, id).reverse(), self];
}

export function pathLabel(sets: MaterialSet[], id: string): string {
  return pathOf(sets, id)
    .map((s) => s.name || s.id)
    .join(" - ");
}

export function levelOf(sets: MaterialSet[], id: string): number {
  return ancestorsOf(sets, id).length + 1;
}

export function wouldCycle(sets: MaterialSet[], id: string, parent: string | null | undefined): boolean {
  if (!parent) return false;
  if (parent === id) return true;
  const map = byId(sets);
  const seen = new Set<string>();
  let cur: string | null = parent;
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentId(map.get(cur) || { id: cur, name: "", note: "", members: [] });
  }
  return false;
}

export function effectiveMembers(sets: MaterialSet[], id: string): string[] {
  const map = byId(sets);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (sid: string) => {
    if (seen.has(sid)) return;
    seen.add(sid);
    const s = map.get(sid);
    if (!s) return;
    for (const m of s.members) {
      if (!out.includes(m)) out.push(m);
    }
    for (const child of childrenOf(sets, sid)) walk(child.id);
  };
  walk(id);
  return out;
}

export function treeRows(sets: MaterialSet[]): { set: MaterialSet; depth: number }[] {
  const out: { set: MaterialSet; depth: number }[] = [];
  const walk = (s: MaterialSet, depth: number) => {
    out.push({ set: s, depth });
    for (const child of childrenOf(sets, s.id)) walk(child, depth + 1);
  };
  for (const r of roots(sets)) walk(r, 0);
  return out;
}

export function leafSets(sets: MaterialSet[]): MaterialSet[] {
  const ids = new Set(sets.map((s) => s.id));
  return sets.filter((s) => !sets.some((c) => parentId(c) === s.id && ids.has(c.id)));
}

export function setsContaining(sets: MaterialSet[], materialId: string): MaterialSet[] {
  return sets.filter((s) => s.members.includes(materialId));
}

export function pathLabelsForMaterial(sets: MaterialSet[], materialId: string): { set: MaterialSet; label: string }[] {
  return setsContaining(sets, materialId)
    .map((s) => ({ set: s, label: pathLabel(sets, s.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function sharesLeafSet(sets: MaterialSet[], a: string, b: string): boolean {
  for (const s of leafSets(sets)) {
    const mem = new Set(effectiveMembers(sets, s.id));
    if (mem.has(a) && mem.has(b)) return true;
  }
  return false;
}

export function maxLevel(sets: MaterialSet[]): number {
  let max = 1;
  for (const s of sets) max = Math.max(max, levelOf(sets, s.id));
  return Math.max(1, max);
}
