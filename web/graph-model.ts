import { SUGGEST_RELATED_K, suggestRelated } from "./gatne";
import type { GhostEdge, GraphEdge, Link, LinkKind, Material, MaterialSet, Neighbor, Neighbors, StrokeTier } from "./types";
import { sharesLeafSet } from "./set-tree";
import { sharesMotorSkill } from "./material-taxonomy";

export const KIND_W: Record<LinkKind, number> = {
  regression: 1,
  progression: 1,
  related: 0.6,
};

export const GHOST_SET = 0.25;

export const LEAP_DEFAULT = 1;
export const LEAP_MIN = 0.1;
export const LEAP_MAX = 3;
export const ELO_K0 = 0.4;
export const ELO_BETA = 0.05;

export function hopLeap(L: Pick<Link, "leap"> | number | null | undefined): number {
  const n = typeof L === "number" ? L : L == null ? undefined : L.leap;
  if (n == null || !Number.isFinite(n)) return LEAP_DEFAULT;
  return n;
}

/** Pelánek (2016) Elo item update. s=1 too easy, s=0 too hard, s=0.5 unclear. */
export function eloUpdateLeap(leap: number, s: number, n: number): { leap: number; nudgeCount: number } {
  const d0 = hopLeap(leap) - 1;
  const P = 1 / (1 + Math.exp(d0));
  const k = ELO_K0 / (1 + ELO_BETA * Math.max(0, n));
  const d1 = d0 + k * (P - s);
  const next = Math.min(LEAP_MAX, Math.max(LEAP_MIN, 1 + d1));
  return { leap: next, nudgeCount: Math.max(0, Math.floor(n)) + 1 };
}

function pairKey(a: string, b: string): string {
  return a < b ? a + "\0" + b : b + "\0" + a;
}

/** Same neighbour walk as server/store.ts and the timeline helpers. */
export function neighborsOf(id: string, links: Link[]): Neighbors {
  const out: Neighbors = { regression: [], progression: [], related: [] };
  const seen = new Set<string>();
  const push = (bucket: keyof Neighbors, other: string, L: Link) => {
    const k = bucket + ":" + other;
    if (seen.has(k) || other === id) return;
    seen.add(k);
    const n: Neighbor = { id: other, note: L.note || "" };
    if (L.tag) n.tag = L.tag;
    if (L.kind === "progression" || L.kind === "regression") n.leap = hopLeap(L);
    out[bucket].push(n);
  };
  for (const L of links) {
    const kind = L.kind;
    if (kind === "regression") {
      if (L.to === id) push("regression", L.from, L);
      if (L.from === id) push("progression", L.to, L);
    } else if (kind === "progression") {
      if (L.from === id) push("progression", L.to, L);
      if (L.to === id) push("regression", L.from, L);
    } else if (kind === "related") {
      if (L.from === id) push("related", L.to, L);
      if (L.to === id) push("related", L.from, L);
    }
  }
  return out;
}

/** Easier/harder are real hops. Also = related hops, then GATNE suggestions. */
export function hopColumns(
  id: string,
  links: Link[],
  materials: Material[],
  positions?: Map<string, { x: number; y: number }> | Record<string, { x: number; y: number }>,
  sets: MaterialSet[] = [],
): { easier: Neighbor[]; harder: Neighbor[]; alts: Neighbor[] } {
  const n = neighborsOf(id, links);
  const seen = new Set<string>([id]);
  const take = (arr: Neighbor[]) =>
    arr.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });
  const easier = take(n.regression);
  const harder = take(n.progression);
  const alts = take(n.related || []);
  for (const s of suggestRelated(id, materials, links, positions, SUGGEST_RELATED_K, sets)) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    alts.push(s);
  }
  return { easier, harder, alts };
}

export function filterMaterials(
  q: string,
  materials: Pick<Material, "id" | "name" | "look" | "notes" | "motorSkills" | "skillRelatedComponents" | "classNotes">[],
  excludeId: string,
): Pick<Material, "id">[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return materials.filter((m) => {
    if (m.id === excludeId) return false;
    const hay = [
      m.id,
      m.name,
      m.look || "",
      m.notes || "",
      ...(m.motorSkills || []),
      ...(m.skillRelatedComponents || []),
      ...(m.classNotes || []).map((n) => n.text || ""),
    ].join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

export type HopGroup = "easier" | "harder" | "alts";

export function hopLinkFor(currentId: string, group: HopGroup, hitId: string, tag?: string, note?: string): Link | null {
  if (!currentId || !hitId || currentId === hitId) return null;
  const n = (note || "").trim();
  if (group === "easier") return { from: hitId, kind: "regression", to: currentId, note: n };
  if (group === "harder") return { from: currentId, kind: "progression", to: hitId, note: n };
  const t = (tag || "").trim();
  if (!t) return null;
  return { from: currentId, kind: "related", to: hitId, note: n, tag: t };
}

/** Members of a named set that still exist. Never a hop. */
export function setBright(set: { members?: string[] } | null | undefined, materials: { id: string }[]): Set<string> {
  const ids = new Set(materials.map((m) => m.id));
  const out = new Set<string>();
  for (const id of set?.members || []) {
    if (ids.has(id)) out.add(id);
  }
  return out;
}

export function hopAdj(id: string, links: Link[]): string[] {
  const n = neighborsOf(id, links);
  const s = new Set<string>();
  for (const bucket of ["regression", "progression", "related"] as const) {
    for (const x of n[bucket]) s.add(x.id);
  }
  return [...s];
}

/** Directed easier → harder neighbors (progression and regression rows both use from=easier). */
export function chainHarderOf(id: string, links: Link[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const L of links) {
    if (L.kind !== "progression" && L.kind !== "regression") continue;
    if (L.from !== id || L.to === id || seen.has(L.to)) continue;
    seen.add(L.to);
    out.push(L.to);
  }
  return out;
}

function chainPath(from: string, to: string, links: Link[]): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string | null>([[from, null]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const v = q[i]!;
    for (const u of chainHarderOf(v, links)) {
      if (prev.has(u)) continue;
      prev.set(u, v);
      if (u === to) {
        const path = [to];
        let cur: string | null = to;
        while (cur && cur !== from) {
          cur = prev.get(cur) ?? null;
          if (cur) path.unshift(cur);
        }
        return path;
      }
      q.push(u);
    }
  }
  return null;
}

/** null = ok. Otherwise a teacher-facing error. */
export function validateProgressionHop(from: string, to: string, links: Link[], names?: Record<string, string>): string | null {
  if (!from || !to || from === to) return "from and to must differ";
  const lab = (id: string) => names?.[id] || id;
  const skip = chainPath(from, to, links);
  if (skip && skip.length > 2) {
    const mid = skip[1]!;
    return (
      lab(to) + " is already further along the progression from " + lab(from) + " (through " + lab(mid) +
      "). Keep the chain linear — do not add " + lab(from) + " → " + lab(to) + ". " +
      lab(mid) + " and " + lab(to) + " are not variations; they are different difficulties."
    );
  }
  const next = chainHarderOf(from, links).filter((id) => id !== to);
  if (next.length) {
    const other = next[0]!;
    const ab = chainPath(other, to, links);
    const ba = chainPath(to, other, links);
    if (!ab && !ba) {
      return (
        lab(from) + " already progresses to " + lab(other) +
        ". A progression chain stays linear. If " + lab(to) + " is the same difficulty as " + lab(other) +
        ", add a related edge tagged \"variation to " + lab(from) + "\" between them, not another progression from " + lab(from) + "."
      );
    }
  }
  return null;
}

/** null = ok. Related is same difficulty, not a chain hop. */
export function validateRelatedHop(from: string, to: string, links: Link[], names?: Record<string, string>): string | null {
  if (!from || !to || from === to) return "from and to must differ";
  const lab = (id: string) => names?.[id] || id;
  const fwd = chainPath(from, to, links);
  const back = chainPath(to, from, links);
  if ((fwd && fwd.length > 1) || (back && back.length > 1)) {
    return (
      lab(from) + " and " + lab(to) + " already sit on a progression chain. They are different difficulties — use progression, not related."
    );
  }
  return null;
}

export function formatKgApplyReport(r: { created?: { nodes?: number; links?: number }; errors?: string[] }): string {
  const nodes = Number(r.created?.nodes) || 0;
  const links = Number(r.created?.links) || 0;
  let line = nodes + " node" + (nodes === 1 ? "" : "s") + " created. " + links + " connection" + (links === 1 ? "" : "s") + " created.";
  if (r.errors && r.errors.length) line += " " + r.errors.length + " failed because " + r.errors.join("; ");
  return line;
}

export function brightSet(id: string, links: Link[], hops = 1): Set<string> {
  const depth = Math.max(1, Math.floor(hops) || 1);
  const s = new Set<string>([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const u of hopAdj(v, links)) {
        if (s.has(u)) continue;
        s.add(u);
        next.push(u);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return s;
}

/** Longest shortest-path on the hop graph \(N(v)\). At least 1. Ghosts do not count. */
export function maxHop(links: Link[]): number {
  const ids = new Set<string>();
  for (const L of links) {
    ids.add(L.from);
    ids.add(L.to);
  }
  let max = 1;
  for (const start of ids) {
    const dist = new Map<string, number>([[start, 0]]);
    const q = [start];
    for (let i = 0; i < q.length; i++) {
      const v = q[i]!;
      const dv = dist.get(v) || 0;
      for (const u of hopAdj(v, links)) {
        if (dist.has(u)) continue;
        const du = dv + 1;
        dist.set(u, du);
        if (du > max) max = du;
        q.push(u);
      }
    }
  }
  return max;
}

export function strokeTier(kinds: Iterable<LinkKind>): StrokeTier {
  const s = new Set(kinds);
  if (s.has("regression") || s.has("progression")) return "chain";
  return "related";
}

export type PendingOp = {
  entity?: string;
  action?: string;
  status?: string;
  tempId?: string;
  id?: string;
  name?: string;
  look?: string;
  notes?: string;
  duration?: number;
  sketch?: string;
  from?: string;
  to?: string;
  kind?: string;
  note?: string;
  tag?: string;
};

export type GraphNode = Material & { degree: number; isolate: boolean; pending?: boolean };

export type GraphModel = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ghosts: GhostEdge[];
};

export function buildModel(materials: Material[], links: Link[], sets: MaterialSet[] = [], pending: PendingOp[] = []): GraphModel {
  const live = (pending || []).filter((op) => op && op.status !== "discarded");
  const extra: Material[] = [];
  for (const op of live) {
    if (op.entity === "material" && op.action === "create" && op.tempId) {
      extra.push({
        id: String(op.tempId),
        name: String(op.name || op.tempId),
        look: String(op.look || ""),
        motorSkills: [],
        skillRelatedComponents: [],
        duration: typeof op.duration === "number" ? op.duration : 20,
        notes: String(op.notes || ""),
      });
    }
  }
  const mats = [...materials, ...extra];
  const pendingLinks: Link[] = [];
  for (const op of live) {
    if (op.entity !== "link" || op.action !== "create" || !op.from || !op.to) continue;
    const kind: LinkKind = op.kind === "regression" || op.kind === "related" ? op.kind : "progression";
    pendingLinks.push({
      from: String(op.from),
      to: String(op.to),
      kind,
      note: String(op.note || ""),
      tag: op.tag ? String(op.tag) : undefined,
    });
  }
  const ids = new Set(mats.map((m) => m.id));
  const real = new Map<string, GraphEdge>();

  for (const L of [...links, ...pendingLinks]) {
    if (!ids.has(L.from) || !ids.has(L.to) || L.from === L.to) continue;
    const key = pairKey(L.from, L.to);
    let e = real.get(key);
    if (!e) {
      const [source, target] = L.from < L.to ? [L.from, L.to] : [L.to, L.from];
      e = {
        source,
        target,
        kinds: [],
        w: 0,
        directed: false,
        notes: [],
        tags: [],
        links: [],
      };
      real.set(key, e);
    }
    if (!e.kinds.includes(L.kind)) e.kinds.push(L.kind);
    e.w = Math.max(e.w, KIND_W[L.kind] ?? 0);
    e.links.push(L);
    if (L.note) e.notes.push(L.note);
    if (L.tag) e.tags.push(L.tag);
    if (L.kind === "progression" || L.kind === "regression") {
      e.directed = true;
      e.easier = L.from;
      e.harder = L.to;
    }
    if (pendingLinks.some((p) => p.from === L.from && p.to === L.to && p.kind === L.kind)) e.pending = true;
  }

  const degree = new Map<string, number>();
  for (const id of ids) degree.set(id, 0);
  for (const e of real.values()) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  const pendingIds = new Set(extra.map((m) => m.id));
  const nodes: GraphNode[] = mats.map((m) => {
    const d = degree.get(m.id) || 0;
    return { ...m, degree: d, isolate: d === 0, pending: pendingIds.has(m.id) };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ghosts: GhostEdge[] = [];
  const ghostDeg = new Map<string, number>();
  const list = nodes.map((n) => n.id);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (real.has(pairKey(a, b))) continue;
      const ma = byId.get(a)!;
      const mb = byId.get(b)!;
      let wGhost = 0;
      let reason: "set" | "cluster" | null = null;
      if (sets.length && sharesLeafSet(sets, a, b)) {
        wGhost = GHOST_SET;
        reason = "set";
      } else if (!sets.length && sharesMotorSkill(ma.motorSkills, mb.motorSkills)) {
        wGhost = GHOST_SET;
        reason = "set";
      }
      if (!wGhost || !reason) continue;
      ghosts.push({ source: a, target: b, wGhost, reason });
      ghostDeg.set(a, (ghostDeg.get(a) || 0) + 1);
      ghostDeg.set(b, (ghostDeg.get(b) || 0) + 1);
    }
  }

  for (const g of ghosts) {
    const da = ghostDeg.get(g.source) || 1;
    const db = ghostDeg.get(g.target) || 1;
    g.wGhost = g.wGhost / Math.min(da, db);
  }

  return { nodes, edges: [...real.values()], ghosts };
}
