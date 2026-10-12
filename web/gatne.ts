import { chainLayout } from "./graph-layout";
import { effectiveMembers, leafSets } from "./set-tree";
import type { Link, Material, MaterialSet, Neighbor, Neighbors } from "./types";

export type MapPos = { x: number; y: number };

const KINDS = ["regression", "progression", "related"] as const;
const TEXT_W = 16;
const SET_W = 3;

function hopsOf(id: string, links: Link[]): Neighbors {
  const out: Neighbors = { regression: [], progression: [], related: [] };
  const seen = new Set<string>();
  const push = (bucket: keyof Neighbors, other: string) => {
    const k = bucket + ":" + other;
    if (seen.has(k) || other === id) return;
    seen.add(k);
    out[bucket].push({ id: other, note: "" });
  };
  for (const L of links) {
    if (L.kind === "regression") {
      if (L.to === id) push("regression", L.from);
      if (L.from === id) push("progression", L.to);
    } else if (L.kind === "progression") {
      if (L.from === id) push("progression", L.to);
      if (L.to === id) push("regression", L.from);
    } else if (L.kind === "related") {
      if (L.from === id) push("related", L.to);
      if (L.to === id) push("related", L.from);
    }
  }
  return out;
}

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0);
}

function add(a: number[], b: number[], scale = 1): number[] {
  return a.map((v, i) => v + scale * (b[i] || 0));
}

function scaleVec(a: number[], s: number): number[] {
  return a.map((v) => v * s);
}

function mean(vecs: number[][], dim: number): number[] {
  if (!vecs.length) return zeros(dim);
  const acc = zeros(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) acc[i]! += v[i] || 0;
  return scaleVec(acc, 1 / vecs.length);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0);
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a)) || 1e-9;
}

function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b));
}

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / s);
}

function tokenize(text: string): string[] {
  const src = String(text || "");
  const mentions = src.match(/@M\d+/gi) || [];
  const rest = src.toLowerCase().replace(/@M\d+/gi, " ");
  const words = rest.split(/[^a-z0-9]+/).filter(Boolean);
  return [...mentions.map((x) => x.toLowerCase()), ...words];
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashEmbed(text: string, width: number): number[] {
  const v = zeros(width);
  for (const t of tokenize(text)) {
    const h = hash32(t);
    const i = h % width;
    v[i]! += h & 1 ? 1 : -1;
  }
  return v;
}

function explanationOf(m: Material): string {
  return String(m.explanation || m.notes || "");
}

function posMap(
  materials: Pick<Material, "id" | "duration">[],
  links: Link[],
  positions?: Map<string, MapPos> | Record<string, MapPos>,
): Map<string, MapPos> {
  const out = new Map<string, MapPos>();
  const get = (id: string): MapPos | undefined => {
    if (!positions) return undefined;
    if (positions instanceof Map) return positions.get(id);
    return positions[id];
  };
  const ids = materials.map((m) => m.id);
  const chain = chainLayout(ids, links);
  for (const m of materials) {
    const given = get(m.id);
    if (given && Number.isFinite(given.x) && Number.isFinite(given.y)) {
      out.set(m.id, given);
      continue;
    }
    const c = chain.get(m.id);
    const yDur = (Math.min(40, Math.max(1, Number(m.duration) || 20)) / 40) * 180;
    out.set(m.id, { x: c ? c.x : 0, y: c && c.rank != null ? c.y : yDur });
  }
  return out;
}

function normalizeXY(positions: Map<string, MapPos>): Map<string, MapPos> {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const out = new Map<string, MapPos>();
  for (const [id, p] of positions) {
    out.set(id, { x: (p.x - minX) / dx, y: (p.y - minY) / dy });
  }
  return out;
}

function setBitFn(sets: MaterialSet[]): (id: string) => number[] {
  const leaves = leafSets(sets);
  const mem = new Map<string, Set<string>>();
  for (const leaf of leaves) mem.set(leaf.id, new Set(effectiveMembers(sets, leaf.id)));
  return (id: string) => leaves.map((leaf) => (mem.get(leaf.id)!.has(id) ? SET_W : 0));
}

function baseOf(m: Material, xy: MapPos, setBits: number[]): number[] {
  return [
    Math.min(40, Math.max(0, Number(m.duration) || 0)) / 40,
    ...hashEmbed(m.name || "", TEXT_W),
    ...hashEmbed(m.look || "", TEXT_W),
    ...hashEmbed(explanationOf(m), TEXT_W),
    ...setBits,
    xy.x,
    xy.y,
  ];
}

/** Constructed GATNE-I: v_i^(related) = b_i + U_i a_i  (M_r = I). */
export function relatedVector(
  id: string,
  materials: Material[],
  links: Link[],
  positions?: Map<string, MapPos> | Record<string, MapPos>,
  sets: MaterialSet[] = [],
): number[] | null {
  const byId = new Map(materials.map((m) => [m.id, m]));
  if (!byId.has(id)) return null;
  const xy = normalizeXY(posMap(materials, links, positions));
  const bitsOf = setBitFn(sets);
  const b = new Map<string, number[]>();
  for (const m of materials) b.set(m.id, baseOf(m, xy.get(m.id) || { x: 0, y: 0 }, bitsOf(m.id)));
  const dim = b.get(id)!.length;
  const n = hopsOf(id, links);
  const counts = KINDS.map((k) => n[k].length);
  const a = counts.every((c) => c === 0) ? [1 / 3, 1 / 3, 1 / 3] : softmax(counts.map((c) => c));
  const cols = KINDS.map((k) => mean(n[k].map((h) => b.get(h.id)!).filter(Boolean), dim));
  let extra = zeros(dim);
  for (let k = 0; k < 3; k++) extra = add(extra, cols[k]!, a[k]);
  return add(b.get(id)!, extra);
}

export const SUGGEST_RELATED_K = 7;

export function suggestRelated(
  id: string,
  materials: Material[],
  links: Link[],
  positions?: Map<string, MapPos> | Record<string, MapPos>,
  k = SUGGEST_RELATED_K,
  sets: MaterialSet[] = [],
): Neighbor[] {
  const vi = relatedVector(id, materials, links, positions, sets);
  if (!vi) return [];
  const n = hopsOf(id, links);
  const skip = new Set<string>([id, ...n.regression.map((x) => x.id), ...n.progression.map((x) => x.id), ...n.related.map((x) => x.id)]);
  const scored: { id: string; s: number }[] = [];
  for (const m of materials) {
    if (skip.has(m.id)) continue;
    const vj = relatedVector(m.id, materials, links, positions, sets);
    if (!vj) continue;
    scored.push({ id: m.id, s: cosine(vi, vj) });
  }
  scored.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
  return scored.slice(0, Math.max(0, k)).map((x, i) => ({ id: x.id, note: "suggested", score: x.s, rank: i + 1 }));
}
