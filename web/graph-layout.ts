import type { Link } from "./types";

export const CHAIN_COL_GAP = 140;
export const CHAIN_ROW_GAP = 90;

export type ChainPlace = { rank: number | null; x: number; y: number; comp: number };

function isChainKind(kind: string): boolean {
  return kind === "progression" || kind === "regression";
}

function hopLeapOf(L: Link): number {
  const n = L.leap;
  if (n == null || !Number.isFinite(n)) return 1;
  return n;
}

/** Longest-path DAG ranks; skip back-edges so cycles finish. from = easier, to = harder. */
export function chainLayout(ids: string[], links: Link[], opts?: { colGap?: number; rowGap?: number }): Map<string, ChainPlace> {
  const colGap = opts?.colGap ?? CHAIN_COL_GAP;
  const rowGap = opts?.rowGap ?? CHAIN_ROW_GAP;
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  const undirected: [string, string][] = [];

  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }

  const seenPair = new Set<string>();
  const leapOf = new Map<string, number>();
  for (const L of links) {
    if (!isChainKind(L.kind)) continue;
    if (!idSet.has(L.from) || !idSet.has(L.to) || L.from === L.to) continue;
    const key = L.from + "->" + L.to;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    leapOf.set(key, hopLeapOf(L));
    out.get(L.from)!.push(L.to);
    inn.get(L.to)!.push(L.from);
    undirected.push([L.from, L.to]);
  }

  const onChain = new Set<string>();
  for (const [a, b] of undirected) {
    onChain.add(a);
    onChain.add(b);
  }

  const color = new Map<string, 0 | 1 | 2>();
  const topo: string[] = [];
  const forward = new Set<string>();

  function dfs(v: string) {
    color.set(v, 1);
    for (const u of out.get(v) || []) {
      const c = color.get(u) ?? 0;
      if (c === 1) continue;
      forward.add(v + "->" + u);
      if (c === 0) dfs(u);
    }
    color.set(v, 2);
    topo.push(v);
  }

  for (const id of ids) {
    if (onChain.has(id) && (color.get(id) ?? 0) === 0) dfs(id);
  }
  topo.reverse();

  const rank = new Map<string, number>();
  for (const v of topo) {
    let r = 0;
    for (const p of inn.get(v) || []) {
      if (!forward.has(p + "->" + v)) continue;
      r = Math.max(r, (rank.get(p) ?? 0) + (leapOf.get(p + "->" + v) ?? 1));
    }
    rank.set(v, r);
  }

  const parent = new Map<string, string>();
  function find(a: string): string {
    let x = a;
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  }
  function union(a: string, b: string) {
    const pa = find(a);
    const pb = find(b);
    if (pa === pb) return;
    parent.set(pa, pb);
  }
  for (const id of onChain) parent.set(id, id);
  for (const [a, b] of undirected) union(a, b);

  const compMembers = new Map<string, string[]>();
  for (const id of onChain) {
    const root = find(id);
    let list = compMembers.get(root);
    if (!list) {
      list = [];
      compMembers.set(root, list);
    }
    list.push(id);
  }
  const comps = [...compMembers.values()].map((m) => m.sort()).sort((a, b) => (a[0] || "").localeCompare(b[0] || ""));
  const compIndex = new Map<string, number>();
  comps.forEach((members, i) => {
    for (const id of members) compIndex.set(id, i);
  });

  const byRank = new Map<number, string[]>();
  for (const id of onChain) {
    const r = rank.get(id) ?? 0;
    let col = byRank.get(r);
    if (!col) {
      col = [];
      byRank.set(r, col);
    }
    col.push(id);
  }
  for (const col of byRank.values()) {
    col.sort((a, b) => {
      const ca = compIndex.get(a) ?? 0;
      const cb = compIndex.get(b) ?? 0;
      return ca - cb || a.localeCompare(b);
    });
  }

  const yOf = new Map<string, number>();
  for (const col of byRank.values()) {
    col.forEach((id, i) => yOf.set(id, i * rowGap));
  }

  const layout = new Map<string, ChainPlace>();
  const gutter: string[] = [];
  for (const id of ids) {
    if (!onChain.has(id)) gutter.push(id);
  }
  gutter.sort();
  gutter.forEach((id, i) => {
    layout.set(id, { rank: null, x: -colGap, y: i * rowGap, comp: 9999 });
  });
  for (const id of onChain) {
    const r = rank.get(id) ?? 0;
    layout.set(id, { rank: r, x: r * colGap, y: yOf.get(id) ?? 0, comp: compIndex.get(id) ?? 0 });
  }
  return layout;
}

export type ViewAngle = { yaw: number; tilt: number }; // yaw = azimuth deg, tilt = elevation from horizon
export const DEFAULT_ANGLE: ViewAngle = { yaw: 90, tilt: 45 };
export const FLOOR_GAP = 150;
export const PARK_FLOOR_DX = 260;
export const TILT_MIN = 5;
export const TILT_MAX = 80;

export function clampAngle(a: ViewAngle): ViewAngle {
  const yaw = ((a.yaw % 360) + 360) % 360;
  const tilt = Math.max(TILT_MIN, Math.min(TILT_MAX, a.tilt));
  return { yaw, tilt };
}

/** Orthographic look-at: azimuth = yaw, elevation from horizon = tilt. SVG y increases down. */
export function project(x: number, y: number, floor: number, a: ViewAngle, ox = 0, oy = 0): { x: number; y: number } {
  const az = (a.yaw * Math.PI) / 180;
  const el = (a.tilt * Math.PI) / 180;
  const X = x - ox;
  const Y = y - oy;
  const z = floor * FLOOR_GAP;
  const sinaz = Math.sin(az);
  const cosaz = Math.cos(az);
  const sinel = Math.sin(el);
  const cosel = Math.cos(el);
  const sx = -sinaz * X + cosaz * Y;
  const sy = -cosaz * sinel * X - sinaz * sinel * Y + cosel * z;
  return { x: ox + sx, y: oy - sy };
}

/** Inverse of project onto a given floor (ground plane if floor is 0). */
export function unproject(sx: number, sy: number, floor: number, a: ViewAngle, ox = 0, oy = 0): { x: number; y: number } {
  const az = (a.yaw * Math.PI) / 180;
  const el = (a.tilt * Math.PI) / 180;
  const sinaz = Math.sin(az);
  const cosaz = Math.cos(az);
  const sinel = Math.sin(el);
  const cosel = Math.cos(el);
  const Sx = sx - ox;
  const Sy = oy - sy - cosel * floor * FLOOR_GAP;
  const c1 = -sinaz;
  const c2 = cosaz;
  const d1 = -cosaz * sinel;
  const d2 = -sinaz * sinel;
  const det = c1 * d2 - c2 * d1;
  if (Math.abs(det) < 1e-9) return { x: ox, y: oy };
  const X = (Sx * d2 - c2 * Sy) / det;
  const Y = (c1 * Sy - d1 * Sx) / det;
  return { x: ox + X, y: oy + Y };
}

/** ticked = tick order (last highest). merge puts every ticked set on floor 1. Unticked park below at floor 0. */
export function floorPlan(ticked: string[], all: string[], merge: boolean): Map<string, number> {
  const out = new Map<string, number>();
  ticked.forEach((id, i) => out.set(id, merge ? 1 : i + 1));
  for (const id of all) if (!out.has(id)) out.set(id, 0);
  return out;
}

/** Push overlapping points apart along their offset. Coincident pairs get a deterministic nudge. Far pairs stay. Optional `r` is a per-point halo (pair gap is r_i + r_j). `view.depthScale` < 1 packs along `side` so a low-tilt floor widens instead of stacking in depth. */
export function pushApart(
  pts: { x: number; y: number; r?: number }[],
  minDist: number,
  rounds = 40,
  view?: { sideX: number; sideY: number; depthScale: number },
): void {
  const n = pts.length;
  if (n < 2 || minDist <= 0) return;
  const fallback = minDist / 2;
  const sl = view ? Math.hypot(view.sideX, view.sideY) : 0;
  const hx = sl > 1e-9 ? view!.sideX / sl : 1;
  const hy = sl > 1e-9 ? view!.sideY / sl : 0;
  const px = -hy;
  const py = hx;
  const k = view ? Math.max(0, Math.min(1, view.depthScale)) : 1;
  const anisotropic = !!view && k < 1 - 1e-9;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pts[j].x - pts[i].x;
        let dy = pts[j].y - pts[i].y;
        let along = anisotropic ? dx * hx + dy * hy : dx;
        let across = anisotropic ? dx * px + dy * py : dy;
        let dist = Math.hypot(along, across * (anisotropic ? k : 1));
        if (anisotropic && Math.abs(along) < 1e-6) {
          along = (i + j) % 2 === 0 ? 1 : -1;
          dist = 0;
        } else if (dist < 1e-9) {
          if (anisotropic) {
            along = (i + j) % 2 === 0 ? 1 : -1;
            across = 0;
          } else {
            const ang = (i * 2 + j) * 1.618;
            along = Math.cos(ang);
            across = Math.sin(ang);
          }
          dist = 0;
        }
        const needDist = Math.max(minDist, (pts[i].r ?? fallback) + (pts[j].r ?? fallback));
        if (dist >= needDist) continue;
        const len = dist || 1;
        const need = (needDist - dist) / 2;
        const na = along / len;
        const nc = anisotropic ? (across * k) / len : across / len;
        const da = na * need;
        const dc = nc * need * (anisotropic ? k : 1);
        if (anisotropic) {
          pts[i].x -= da * hx + dc * px;
          pts[i].y -= da * hy + dc * py;
          pts[j].x += da * hx + dc * px;
          pts[j].y += da * hy + dc * py;
        } else {
          pts[i].x -= da;
          pts[i].y -= dc;
          pts[j].x += da;
          pts[j].y += dc;
        }
      }
    }
  }
}
