import { drag } from "d3-drag";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type Simulation, type SimulationNodeDatum } from "d3-force";
import { pointer, select, type Selection } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { clampAngle, DEFAULT_ANGLE, floorPlan, PARK_FLOOR_DX, project, pushApart, unproject } from "./graph-layout";
import { brightSet, buildModel, hopColumns, hopLeap, maxHop, setBright, strokeTier, type GraphModel, type GraphNode, type PendingOp } from "./graph-model";
import { compactMotorLabel, MOTOR_SKILLS, SKILL_RELATED_COMPONENTS } from "./material-taxonomy";
import { COMPONENT_ROOT_NAME, MOTOR_ROOT_NAME, childrenOf, effectiveMembers, pathLabelsForMaterial, roots, sharesLeafSet } from "./set-tree";
import type { GraphEdge, Link, LinkKind, Material, MaterialSet, SearchHit, SearchResult } from "./types";

type SimNode = GraphNode & SimulationNodeDatum & { ring?: boolean };
type SimLink = Omit<GraphEdge, "source" | "target"> & { source: string | SimNode; target: string | SimNode };
type SimGhost = { source: string | SimNode; target: string | SimNode; wGhost: number };

function idOf(end: string | SimNode): string {
  return typeof end === "string" ? end : end.id;
}

const NOTES_PLACEHOLDER = "How the drill is done. Type @ then a similar drill (name or description), then Polish.";
export const HOVER_DWELL_MS = 2000;

export function bindNoteMentions(
  noteEl: HTMLInputElement | HTMLTextAreaElement,
  mentionOpts: {
    onSearch?: (q: string) => Promise<SearchResult>;
    materials: () => Material[];
    onPick?: () => void;
    onPeek?: (id: string, anchor: HTMLElement) => void;
    onPeekLeave?: () => void;
  },
) {
  if (noteEl.dataset.mentionBound === "1") return;
  if (!noteEl.parentElement) return;
  noteEl.dataset.mentionBound = "1";
  document.querySelectorAll("body > .kg-mention-pop").forEach((old) => {
    const owner = (old as HTMLElement & { _owner?: Node })._owner;
    if (owner && !owner.isConnected) old.remove();
  });
  const pop = document.createElement("div") as HTMLDivElement & { _owner?: Node };
  pop.className = "mat-combo-pop kg-mention-pop open";
  pop.hidden = true;
  pop._owner = noteEl;
  document.body.append(pop);
  let seq = 0;
  let timer = 0;

  const place = () => {
    const r = noteEl.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.left = Math.round(r.left) + "px";
    pop.style.top = Math.round(r.bottom + 4) + "px";
    pop.style.width = Math.round(Math.max(r.width, 240)) + "px";
    pop.style.minWidth = "240px";
    pop.style.zIndex = "260";
  };

  const insert = (id: string) => {
    const v = noteEl.value;
    let at = -1;
    for (let i = 0; i < v.length; i++) if (v[i] === "@") at = i;
    noteEl.value = (at >= 0 ? v.slice(0, at) : v) + "@" + id + " ";
    pop.hidden = true;
    noteEl.focus();
    mentionOpts.onPick?.();
  };

  const addGroup = (title: string, hits: SearchHit[], emptyText: string) => {
    const g = document.createElement("div");
    g.className = "kg-hit-group";
    const lab = document.createElement("div");
    lab.className = "kg-hit-label";
    lab.textContent = title;
    g.append(lab);
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "mute";
      empty.textContent = emptyText;
      g.append(empty);
    } else {
      for (const h of hits) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn";
        b.textContent = (h.id || "") + " " + (h.name || "");
        b.addEventListener("mousedown", (ev) => ev.preventDefault());
        b.addEventListener("click", () => insert(h.id));
        b.addEventListener("mouseover", () => mentionOpts.onPeek?.(h.id, b));
        b.addEventListener("mouseout", (ev) => {
          const next = ev.relatedTarget as Node | null;
          if (next && (b.contains(next) || pop.contains(next))) return;
          mentionOpts.onPeekLeave?.();
        });
        g.append(b);
      }
    }
    pop.append(g);
  };

  const showPop = () => {
    pop.hidden = false;
    place();
  };

  const paintHint = (text: string) => {
    pop.replaceChildren();
    const mute = document.createElement("div");
    mute.className = "mute";
    mute.textContent = text;
    pop.append(mute);
    showPop();
  };

  const openAt = (v: string) => {
    let at = -1;
    for (let i = 0; i < v.length; i++) if (v[i] === "@") at = i;
    if (at < 0) return null;
    const after = v.slice(at + 1);
    if (/^M\d+(\s|$)/.test(after)) return null;
    return after;
  };

  const run = async (q: string) => {
    if (!noteEl.isConnected) {
      pop.remove();
      return;
    }
    const needle = q.trim();
    const mine = ++seq;
    if (!needle) {
      paintHint("Type a name or how the drill is done");
      return;
    }
    if (!mentionOpts.onSearch) {
      const n = needle.toLowerCase();
      const rows = mentionOpts.materials().filter((m) => (m.id + " " + m.name).toLowerCase().includes(n)).slice(0, 8);
      pop.replaceChildren();
      addGroup("Match by keyword", rows.map((m) => ({ id: m.id, name: m.name, score: 1 })), "No name/cue/notes/set match");
      addGroup("Match by semantic", [], "No semantic matches");
      showPop();
      return;
    }
    const res = await mentionOpts.onSearch(needle);
    if (mine !== seq) return;
    pop.replaceChildren();
    addGroup("Match by keyword", res.keyword || [], "No name/cue/notes/set match");
    addGroup("Match by semantic", res.semantic || [], "No semantic matches");
    showPop();
  };

  noteEl.addEventListener("input", () => {
    const q = openAt(noteEl.value);
    if (q == null) {
      pop.hidden = true;
      mentionOpts.onPeekLeave?.();
      return;
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => { void run(q); }, 220);
  });
  noteEl.addEventListener("blur", () => setTimeout(() => {
    pop.hidden = true;
    mentionOpts.onPeekLeave?.();
  }, 180));
  pop.addEventListener("mouseleave", () => mentionOpts.onPeekLeave?.());
}

export type GraphViewOpts = {
  sketchSrc: (m: Material) => string;
  toast: (msg: string) => void;
  onCreateLink: (L: Link) => Promise<void>;
  onDeleteLink: (from: string, kind: LinkKind, to: string) => Promise<void>;
  onSearch?: (q: string) => Promise<SearchResult>;
  onPolish?: (kind: string, text: string, context: string) => Promise<{ text: string }>;
  onCreateSet?: (input: { name: string; note?: string; members: string[] }) => Promise<{ id: string } | void>;
  onUpdateSet?: (id: string, patch: { name?: string; note?: string; members?: string[] }) => Promise<void>;
  onDeleteSet?: (id: string) => Promise<void>;
  onAddSetToTimeline?: (id: string) => void;
  onPeekNode?: (id: string, anchor: HTMLElement) => void;
  onHoverPeek?: (id: string, anchor: HTMLElement) => void;
  onHoverPeekLeave?: () => void;
  onUpdateMaterial?: (id: string, patch: Partial<Material>) => Promise<void>;
  onHopHover?: (anchor: HTMLElement, info: { id: string; kind: "regression" | "progression" | "related" }) => void;
  onHopLeave?: (e: MouseEvent) => void;
  onEdgeHover?: (anchor: HTMLElement, edge: { links: { from: string; to: string; kind: string; note?: string }[]; pending?: boolean }) => void;
  onEdgeLeave?: (e: MouseEvent) => void;
};

const NODE_FILL = "#34d399";

const SET_COLORS = ["#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6", "#f97316", "#06b6d4"];

export function setColor(id: string): string {
  const n = Number((/^S(\d+)$/.exec(id) || [])[1] || 0);
  return SET_COLORS[(Math.max(n, 1) - 1) % SET_COLORS.length]!;
}

type Pt = { x: number; y: number };

function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts.slice();
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function hullPath(pts: Pt[], pad: number, shape: "hull" | "poly" = "hull"): string {
  if (shape === "poly") {
    if (!pts.length) return "";
    return "M " + pts.map((p) => p.x + " " + p.y).join(" L ") + " Z";
  }
  if (!pts.length) return "";
  if (pts.length === 1) {
    const p = pts[0]!;
    return `M ${p.x - pad} ${p.y} A ${pad} ${pad} 0 1 0 ${p.x + pad} ${p.y} A ${pad} ${pad} 0 1 0 ${p.x - pad} ${p.y}`;
  }
  if (pts.length === 2) {
    const a = pts[0]!;
    const b = pts[1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * pad;
    const ny = (dx / len) * pad;
    return `M ${a.x + nx} ${a.y + ny} L ${b.x + nx} ${b.y + ny} A ${pad} ${pad} 0 0 0 ${b.x - nx} ${b.y - ny} L ${a.x - nx} ${a.y - ny} A ${pad} ${pad} 0 0 0 ${a.x + nx} ${a.y + ny} Z`;
  }
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const grown = pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
  });
  const hull = convexHull(grown);
  if (hull.length < 3) return hullPath(hull, pad);
  return "M " + hull.map((p) => p.x + " " + p.y).join(" L ") + " Z";
}

function asNode(end: string | SimNode, byId: Map<string, SimNode>): SimNode | undefined {
  if (typeof end === "object") return end;
  return byId.get(end);
}

export function createGraphView(opts: GraphViewOpts) {
  const svgEl = document.getElementById("kg-svg") as SVGSVGElement | null;
  const side = document.getElementById("kg-side");
  const bodiesEl = document.getElementById("kg-facets");
  const searchEl = document.getElementById("kg-search") as HTMLInputElement | null;
  const hitsEl = document.getElementById("kg-hits");
  const unlinkedEl = document.getElementById("kg-unlinked") as HTMLInputElement | null;
  const hopsEl = document.getElementById("kg-hops") as HTMLInputElement | null;
  const layoutLayersBtn = document.getElementById("kg-layout-layers");
  const angleBtn = document.getElementById("kg-angle");
  const planeOpts = document.getElementById("kg-plane-opts");
  const planeOneBtn = document.getElementById("kg-plane-one");
  const planeEachBtn = document.getElementById("kg-plane-each");
  const spreadBtn = document.getElementById("kg-spread");
  const angleHint = document.getElementById("kg-angle-hint");
  const selectBar = document.getElementById("kg-select-bar");
  const selectCount = document.getElementById("kg-select-count");
  const selectName = document.getElementById("kg-select-name") as HTMLInputElement | null;
  const selectSources = document.getElementById("kg-select-sources");
  const selectPanelSet = document.getElementById("kg-select-panel-set");
  const selectPanelLink = document.getElementById("kg-select-panel-link");
  const selectTabSet = document.getElementById("kg-select-tab-set");
  const selectTabLink = document.getElementById("kg-select-tab-link");
  const nodeTip = document.getElementById("kg-node-tip");
  const drawPop = document.getElementById("kg-draw-pop");
  const edgePop = document.getElementById("kg-edge-pop");
  if (!svgEl) {
    return { update() {}, setFocus() {}, getFocus: () => null as string | null, getPositions: () => ({}), fit() {}, restoreCamera() {}, pause() {} };
  }

  let materials: Material[] = [];
  let links: Link[] = [];
  let sets: MaterialSet[] = [];
  let model: GraphModel = { nodes: [], edges: [], ghosts: [] };
  let pendingOps: PendingOp[] = [];
  let framedPendingKey = "";
  let focus: string | null = null;
  let focusedSet: string | null = null;
  let pickMode = false;
  const picked = new Set<string>();
  let pickTab: "set" | "link" = "set";
  let pickSource: string | null = null;
  let filterSnapshot: string[] | null = null;
  let lastKeyword: SearchHit[] = [];
  let lastSemantic: SearchHit[] = [];
  let setFilter: string[] = [];
  let extraIds: string[] = [];
  let peekVisitId: string | null = null;
  let showUnlinked = false;
  let paused = false;
  let layoutMode: "draw" | "layers" = "draw";
  let floorSets: string[] = [];
  let mergeFloors = false;
  let plateBoxes = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  let plateBoxKey = "";
  let angle = { ...DEFAULT_ANGLE };
  let angleArmed = false;
  let origin = { x: 0, y: 0 };
  let drawArmed = false;
  let histSkip = false;
  let sideHist: { ids: string[]; i: number } = { ids: [], i: -1 };
  let selectBarMoved = false;
  let selectBarDrag: { dx: number; dy: number; pointer: number } | null = null;
  let searchTimer = 0;
  let dragging = false;
  let dragMoved = false;
  let fittedOnce = false;
  let dragOrigin = { x: 0, y: 0, px: 0, py: 0, k: 1 };
  let hopCount = 1;
  let tipId: string | null = null;
  let tipOpen = false;
  let tipHideT = 0;
  let tipShowT = 0;
  const KG_VIEW_KEY = "flag-lesson-library-kg-view";
  let savedZoom: { k: number; x: number; y: number } | null = null;

  try {
    const raw = JSON.parse(localStorage.getItem(KG_VIEW_KEY) || "");
    if (raw && (raw.layoutMode === "layers" || raw.layoutMode === "draw")) layoutMode = raw.layoutMode;
    if (raw && typeof raw.mergeFloors === "boolean") mergeFloors = raw.mergeFloors;
    if (raw && typeof raw.yaw === "number" && typeof raw.tilt === "number") angle = clampAngle({ yaw: raw.yaw, tilt: raw.tilt });
    if (raw && raw.origin && typeof raw.origin.x === "number" && typeof raw.origin.y === "number") origin = { x: raw.origin.x, y: raw.origin.y };
    if (raw && Array.isArray(raw.setFilter)) setFilter = raw.setFilter.filter((id: unknown) => typeof id === "string");
    if (raw && Array.isArray(raw.extraIds)) extraIds = raw.extraIds.filter((id: unknown) => typeof id === "string");
    if (raw && raw.zoom && typeof raw.zoom.k === "number") savedZoom = { k: raw.zoom.k, x: Number(raw.zoom.x) || 0, y: Number(raw.zoom.y) || 0 };
  } catch {
    /* keep defaults */
  }
  paused = layoutMode === "layers";
  try {
    peekVisitId = new URLSearchParams(location.search).get("peek");
  } catch {
    peekVisitId = null;
  }
  if (peekVisitId && !extraIds.includes(peekVisitId)) extraIds.push(peekVisitId);

  function saveKgView() {
    try {
      const z = zoomTransform(svgEl as SVGSVGElement);
      localStorage.setItem(
        KG_VIEW_KEY,
        JSON.stringify({
          layoutMode,
          mergeFloors,
          yaw: angle.yaw,
          tilt: angle.tilt,
          origin,
          setFilter,
          extraIds,
          zoom: { k: z.k, x: z.x, y: z.y },
        }),
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  let spreading = false;

  function hopsNow(): number {
    const cap = maxHop(links);
    return Math.max(1, Math.min(cap, hopCount));
  }

  function lit(): Set<string> {
    const ids = new Set(materials.map((m) => m.id));
    let out: Set<string>;
    if (picked.size) {
      out = new Set<string>();
      for (const id of picked) if (ids.has(id)) out.add(id);
    } else if (setFilter.length) {
      out = new Set<string>();
      for (const sid of setFilter) {
        for (const id of effectiveMembers(sets, sid)) if (ids.has(id)) out.add(id);
      }
    } else if (focusedSet) {
      out = new Set(effectiveMembers(sets, focusedSet).filter((id) => ids.has(id)));
    } else if (!focus) {
      out = new Set();
    } else {
      out = brightSet(focus, links, hopsNow());
    }
    for (const id of extraIds) if (ids.has(id)) out.add(id);
    return out;
  }

  function syncHopsInput() {
    if (!hopsEl) return;
    const cap = maxHop(links);
    hopsEl.max = String(cap);
    hopCount = Math.max(1, Math.min(cap, hopCount));
    hopsEl.value = String(hopCount);
    hopsEl.title = "Hops to keep bright (1–" + cap + ")";
  }

  const svg = select(svgEl);
  svg.selectAll("*").remove();
  const root = svg.append("g").attr("class", "kg-root");
  const ghostG = root.append("g").attr("class", "kg-ghosts");
  const hullG = root.append("g").attr("class", "kg-hulls");
  const floorG = root.append("g").attr("class", "kg-floors");
  const linkG = root.append("g").attr("class", "kg-links");
  const labelG = root.append("g").attr("class", "kg-elabels");
  const nodeG = root.append("g").attr("class", "kg-nodes");
  const pivotG = root.append("g").attr("class", "kg-pivot").style("display", "none");
  pivotG.append("circle").attr("r", 6).attr("class", "kg-pivot-dot");

  const defs = svg.append("defs");
    for (const [name, color] of [
      ["arr-progress", "var(--progress)"],
      ["arr-regress", "var(--regress)"],
      ["arr-related", "var(--related)"],
      ["arr-tag", "var(--tag)"],
    ] as const) {
      for (const [suffix, opacity] of [
        ["", 0.32],
        ["-bright", 1],
        ["-dim", 0.06],
      ] as const) {
        defs
          .append("marker")
          .attr("id", name + suffix)
          .attr("viewBox", "0 -5 10 10")
          .attr("refX", 18)
          .attr("refY", 0)
          .attr("markerWidth", 7)
          .attr("markerHeight", 7)
          .attr("orient", "auto")
          .append("path")
          .attr("d", "M0,-5L10,0L0,5")
          .attr("fill", color)
          .attr("fill-opacity", opacity);
      }
    }

  const simNodes: SimNode[] = [];
  const simLinks: SimLink[] = [];
  const simGhosts: SimGhost[] = [];
  const byId = new Map<string, SimNode>();

  const sim: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(78)
        .strength((d) => d.w),
    )
    .force(
      "ghost",
      forceLink<SimNode, SimGhost>(simGhosts)
        .id((d) => d.id)
        .distance(130)
        .strength((d) => (d as SimGhost).wGhost),
    )
    .force("charge", forceManyBody<SimNode>().strength(-140))
    .force("collide", forceCollide<SimNode>().radius((d) => (d.isolate && !showUnlinked ? 10 : 28)))
    .force("center", forceCenter(0, 0).strength(0.2))
    .force("ring", forceRadial<SimNode>(220).strength((d) => (d.isolate && !showUnlinked ? 0.7 : 0)));

  const zoomer: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.15, 6])
    .filter((ev) => {
      if (dragging) return false;
      if (angleArmed) return false;
      if (ev.type === "wheel" || ev.type === "dblclick") return ev.type === "wheel";
      const t = ev.target as Element | null;
      if (t && typeof t.closest === "function" && t.closest(".kg-node, .kg-edge")) return false;
      return !ev.ctrlKey;
    })
    .on("zoom", (ev) => {
      root.attr("transform", ev.transform.toString());
    })
    .on("end", () => {
      saveKgView();
    });
  svg.call(zoomer);
  svg.on("dblclick.zoom", null);

  if (side) {
    side.addEventListener("mouseover", (e) => {
      const t = e.target as HTMLElement;
      const lab = t.closest("[data-nb] > b");
      const hop = t.closest("[data-nb] .kg-hop");
      if ((!lab && !hop) || !side.contains(t) || !focus) return;
      const box = (lab || hop)?.closest("[data-nb]") as HTMLElement | null;
      const kind = box?.dataset.nb;
      if (kind !== "regression" && kind !== "progression" && kind !== "related") return;
      opts.onHopHover?.(side, { id: focus, kind });
    });
    side.addEventListener("mouseleave", (e) => opts.onHopLeave?.(e));
  }

  sim.on("tick", () => {
    if (dragging) return;
    ticked();
  });

  const svgNode = svgEl;
  function size() {
    const w = svgNode.clientWidth || 800;
    const h = svgNode.clientHeight || 560;
    (sim.force("center") as ReturnType<typeof forceCenter>).x(w / 2).y(h / 2);
    (sim.force("ring") as ReturnType<typeof forceRadial>).x(w / 2).y(h / 2).radius(Math.min(w, h) * 0.42);
    return { w, h };
  }

  function rebuildSim() {
    const prev = new Map(simNodes.map((n) => [n.id, n]));
    simNodes.length = 0;
    byId.clear();
    for (const n of model.nodes) {
      const old = prev.get(n.id);
      const node: SimNode = {
        ...n,
        x: old?.x,
        y: old?.y,
        vx: old?.vx,
        vy: old?.vy,
        fx: old?.fx,
        fy: old?.fy,
      };
      simNodes.push(node);
      byId.set(n.id, node);
    }
    simLinks.length = 0;
    for (const e of model.edges) simLinks.push({ ...e });
    simGhosts.length = 0;
    for (const g of model.ghosts) simGhosts.push({ ...g });
    sim.nodes(simNodes);
    (sim.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>>).links(simLinks);
    (sim.force("ghost") as ReturnType<typeof forceLink<SimNode, SimGhost>>).links(simGhosts);
    const hadLayout = [...prev.values()].some((n) => n.x != null && n.y != null);
    size();
    if (!hadLayout) {
      sim.alpha(0.85);
      sim.tick(90);
      sim.alpha(0);
    }
    pinAll();
    nodeG.classed("kg-no-anim", true);
    draw();
    const pendingKey = simNodes.filter((n) => n.pending).map((n) => n.id).sort().join(",")
      + "|" + simLinks.filter((e) => e.pending).map((e) => idOf(e.source) + ">" + idOf(e.target)).sort().join(",");
    if (pendingKey && pendingKey !== framedPendingKey) {
      layoutPendingCluster();
      draw();
      framedPendingKey = pendingKey;
    }
    applyFocus();
    if (!fittedOnce) {
      if (savedZoom && Number.isFinite(savedZoom.k)) {
        svg.call(zoomer.transform, zoomIdentity.translate(savedZoom.x, savedZoom.y).scale(savedZoom.k));
      } else {
        fit();
      }
      fittedOnce = true;
    }
    sim.stop();
    window.setTimeout(() => nodeG.classed("kg-no-anim", false), 0);
  }

  function proj(x: number, y: number, floor = 0) {
    return project(x, y, floor, angle, origin.x, origin.y);
  }

  function syncLayoutButtons() {
    layoutLayersBtn?.classList.toggle("solid", layoutMode === "layers");
    if (planeOpts) {
      planeOpts.hidden = layoutMode !== "layers";
      planeOpts.classList.toggle("open", layoutMode === "layers");
    }
    planeOneBtn?.classList.toggle("solid", mergeFloors);
    planeEachBtn?.classList.toggle("solid", !mergeFloors);
    if (spreadBtn) spreadBtn.hidden = layoutMode !== "layers";
    syncAngleUi();
  }

  function syncAngleUi() {
    const layers = layoutMode === "layers";
    const title = `yaw ${Math.round(angle.yaw)}° · tilt ${Math.round(angle.tilt)}°`;
    if (angleBtn) {
      angleBtn.hidden = !layers;
      angleBtn.classList.toggle("solid", angleArmed);
      angleBtn.classList.toggle("is-fist", layers && angleArmed && dragging);
      angleBtn.title = title;
    }
    if (angleHint) angleHint.hidden = !(layers && angleArmed && !dragging);
    svgNode.classList.toggle("kg-angle-armed", layers && angleArmed);
    svgNode.classList.toggle("kg-angle-dragging", layers && angleArmed && dragging);
    floorG.classed("kg-no-anim", layers && angleArmed && dragging);
    paintPivot();
  }

  function paintPivot() {
    const show = layoutMode === "layers" && angleArmed;
    pivotG.style("display", show ? null : "none");
    if (!show) return;
    const p = proj(origin.x, origin.y, 0);
    pivotG.attr("transform", `translate(${p.x},${p.y})`);
  }

  function seedFloorSets() {
    if (picked.size) {
      floorSets = setFilter.slice();
      return;
    }
    if (setFilter.length) {
      floorSets = setFilter.slice();
      return;
    }
    const ids: string[] = [];
    for (const rootSet of roots(sets, "first")) {
      for (const s of taxonomyLeaves(rootSet)) ids.push(s.id);
    }
    floorSets = ids;
  }

  function setLayoutMode(mode: "draw" | "layers") {
    if (layoutMode === mode) return;
    layoutMode = mode;
    if (mode !== "layers") angleArmed = false;
    if (mode === "layers") {
      angle = { ...DEFAULT_ANGLE };
      origin = { x: 0, y: 0 };
      plateBoxes = new Map();
      plateBoxKey = "";
    }
    syncLayoutButtons();
    if (mode === "draw") {
      for (const n of simNodes) {
        n.fx = undefined;
        n.fy = undefined;
      }
      paused = false;
      sim.nodes(simNodes);
      (sim.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>>).links(simLinks);
      (sim.force("ghost") as ReturnType<typeof forceLink<SimNode, SimGhost>>).links(simGhosts);
      size();
      sim.alpha(0.85);
      sim.tick(90);
      sim.alpha(0);
      pinAll();
      draw();
      applyFocus();
      fit();
      saveKgView();
      sim.stop();
      return;
    }
    paused = true;
    pinAll();
    sim.stop();
    seedFloorSets();
    draw();
    applyFocus();
    fit();
    saveKgView();
  }

  function pinAll() {
    for (const n of simNodes) {
      n.fx = n.x;
      n.fy = n.y;
      n.vx = 0;
      n.vy = 0;
    }
  }

  function visibleNode(n: SimNode): boolean {
    if (n.isolate && !showUnlinked && !focus) return true;
    return true;
  }

  function nodeClass(n: SimNode): string {
    const parts = ["kg-node"];
    if (n.isolate) parts.push("isolate");
    const added = extraIds.includes(n.id);
    if (picked.size) {
      parts.push(picked.has(n.id) || added ? "bright" : "dim");
    } else if (focus || focusedSet || setFilter.length) {
      const bright = lit();
      parts.push(bright.has(n.id) ? "bright" : "dim");
    }
    if (picked.has(n.id)) parts.push("picked");
    if (!picked.size && setFilter.length) {
      const allow = new Set<string>();
      for (const sid of setFilter) {
        for (const id of effectiveMembers(sets, sid)) allow.add(id);
      }
      if (!allow.has(n.id) && !added) parts.push("facet-dim");
    }
    if (focus === n.id || peekVisitId === n.id) parts.push("kg-focus");
    if (n.pending) parts.push("pending");
    if (n.isolate && !n.pending && !showUnlinked && !focus && !focusedSet && !setFilter.length && !added) parts.push("parked");
    return parts.join(" ");
  }

  function primaryKind(e: { kinds: LinkKind[]; directed?: boolean }): LinkKind {
    if (e.directed || e.kinds.includes("progression") || e.kinds.includes("regression")) return "progression";
    return "related";
  }

  function marker(e: { kinds: LinkKind[]; directed: boolean }, mode: "soup" | "bright" | "dim"): string | null {
    if (!e.directed) return null;
    const suffix = mode === "bright" ? "-bright" : mode === "dim" ? "-dim" : "";
    return "url(#arr-progress" + suffix + ")";
  }

  function edgeIsDim(d: SimLink): boolean {
    if (picked.size) {
      return !picked.has(idOf(d.source)) || !picked.has(idOf(d.target));
    }
    if (!focus && !focusedSet && !setFilter.length) return false;
    const bright = lit();
    return !bright.has(idOf(d.source)) || !bright.has(idOf(d.target));
  }

  function edgeMarkMode(d: SimLink): "soup" | "bright" | "dim" {
    if (picked.size) return edgeIsDim(d) ? "dim" : "bright";
    if (!focus && !focusedSet && !setFilter.length) return "soup";
    return edgeIsDim(d) ? "dim" : "bright";
  }

  function paintEdgeMarks(sel: Selection<SVGLineElement, SimLink, SVGGElement, unknown>) {
    sel
      .classed("dim", (d) => edgeMarkMode(d) === "dim")
      .classed("bright", (d) => edgeMarkMode(d) === "bright")
      .attr("stroke-width", (d) => {
        if (strokeTier(d.kinds) !== "chain") return 2;
        const hops = d.links.filter((L) => L.kind === "progression" || L.kind === "regression");
        const leap = hops.length ? Math.max(...hops.map((L) => hopLeap(L))) : 1;
        return 1 + 1.5 * leap;
      })
      .attr("marker-end", (d) => marker(d, edgeMarkMode(d)) || null);
  }

  function paintNodeMarks(g: Selection<SVGGElement, SimNode, any, unknown>, d: SimNode) {
    const show = tipOpen && tipId === d.id;
    const hopN = show ? Math.min(5, d.degree) : 0;
    const dots = g.select("g.kg-dots").selectAll("circle").data(Array.from({ length: hopN }));
    dots.exit().remove();
    dots
      .enter()
      .append("circle")
      .attr("r", 2.2)
      .merge(dots as unknown as Selection<SVGCircleElement, unknown, SVGGElement, SimNode>)
      .attr("cx", (_, i) => Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 8) * 22)
      .attr("cy", (_, i) => Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 8) * 22);
    const mine = show ? sets.filter((s) => s.members.includes(d.id)).map((s) => s.id) : [];
    const sd = g.select("g.kg-set-dots").selectAll("circle").data(mine);
    sd.exit().remove();
    sd.enter()
      .append("circle")
      .attr("r", 3.6)
      .merge(sd as unknown as Selection<SVGCircleElement, string, SVGGElement, SimNode>)
      .attr("cx", (_, i) => -10 + i * 9)
      .attr("cy", -22)
      .attr("fill", (sid) => setColor(sid))
      .attr("stroke", "#fff")
      .attr("stroke-width", 1);
  }

  function refreshNodeMarks() {
    nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").each(function (d) {
      paintNodeMarks(select(this), d);
    });
  }

  function hideNodeTip() {
    window.clearTimeout(tipHideT);
    window.clearTimeout(tipShowT);
    const wasOpen = tipOpen;
    tipId = null;
    tipOpen = false;
    if (nodeTip) {
      nodeTip.hidden = true;
      nodeTip.classList.remove("open");
    }
    if (wasOpen) refreshNodeMarks();
  }

  function placeNodeTip(el: Element) {
    if (!nodeTip) return;
    nodeTip.hidden = false;
    nodeTip.classList.add("open");
    const r = el.getBoundingClientRect();
    const w = nodeTip.offsetWidth || 180;
    const h = nodeTip.offsetHeight || 48;
    let left = r.right + 10;
    let top = r.top;
    if (left + w > window.innerWidth - 12) left = r.left - w - 10;
    if (top + h > window.innerHeight - 12) top = Math.max(8, window.innerHeight - h - 12);
    if (top < 8) top = 8;
    nodeTip.style.left = Math.round(Math.max(8, left)) + "px";
    nodeTip.style.top = Math.round(top) + "px";
  }

  function fillNodeTip() {
    if (!nodeTip || !tipId) return;
    const node = model.nodes.find((n) => n.id === tipId);
    const m = materials.find((x) => x.id === tipId);
    const name = m ? m.id + " " + m.name : tipId;
    const hops = node?.degree || 0;
    const mine = sets.filter((s) => s.members.includes(tipId!));
    if (!tipOpen) {
      nodeTip.innerHTML = `<button type="button" class="kg-tip-more on">More info</button><div class="mute kg-tip-hint">Click to see hops and sets</div>`;
    } else {
      const hopLine = hops
        ? `Dark dots = hops from this card. ${hops > 5 ? "5 of " + hops + " shown." : hops + (hops === 1 ? " hop." : " hops.")}`
        : "Dark dots = hops. This card has none yet.";
      const setRows = mine.length
        ? mine
            .map(
              (s) =>
                `<div class="kg-tip-set"><i class="dot" style="background:${setColor(s.id)}"></i>${escapeAttr(s.name || s.id)}</div>`,
            )
            .join("")
        : `<div class="mute">Not in a set</div>`;
      nodeTip.innerHTML = `<button type="button" class="kg-tip-more on">More info</button>
        <div class="kg-tip-body">
          <div class="kg-tip-name">${escapeAttr(name)}</div>
          <p class="mute">${hopLine}</p>
          <p class="mute">Coloured dots = sets this card belongs to.</p>
          ${setRows}
        </div>`;
    }
    nodeTip.querySelector(".kg-tip-more")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      tipOpen = !tipOpen;
      fillNodeTip();
      refreshNodeMarks();
      const g = nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").filter((d) => d.id === tipId).node();
      if (g) placeNodeTip(g);
    });
  }

  function openNodeTip(d: SimNode, el: Element) {
    if (tipId !== d.id) tipOpen = false;
    tipId = d.id;
    fillNodeTip();
    placeNodeTip(el);
  }

  function draw() {
    const edgeKey = (d: SimLink) => idOf(d.source) + "|" + idOf(d.target);
    const linkSel = linkG.selectAll<SVGLineElement, SimLink>("line.kg-edge").data(simLinks, edgeKey);
    linkSel.exit().remove();
    const linkEnter = linkSel.enter().append("line");
    const linksMerged = linkEnter.merge(linkSel);
    linksMerged
      .attr("class", (d) => "kg-edge tier-" + strokeTier(d.kinds) + " k-" + primaryKind(d) + (d.pending ? " pending" : ""))
      .attr("data-ends", (d) => idOf(d.source) + "|" + idOf(d.target))
      .attr("stroke-dasharray", (d) => (d.pending ? "8 5" : null));
    paintEdgeMarks(linksMerged);
    const hitSel = linkG.selectAll<SVGLineElement, SimLink>("line.kg-edge-hit").data(simLinks, edgeKey);
    hitSel.exit().remove();
    const hitMerged = hitSel.enter().append("line").attr("class", "kg-edge-hit").merge(hitSel);

    const labSel = labelG.selectAll<SVGTextElement, SimLink>("text").data(simLinks, (d) => idOf(d.source) + "|" + idOf(d.target));
    labSel.exit().remove();
    labSel.enter().append("text").attr("class", "kg-elabel");

    const nodeSel = nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").data(simNodes, (d) => d.id);
    nodeSel.exit().remove();
    const enter = nodeSel.enter().append("g").attr("class", "kg-node");
    enter.append("rect").attr("class", "kg-hit");
    enter.append("circle").attr("class", "kg-disc");
    enter.append("text").attr("class", "kg-id").attr("text-anchor", "middle").attr("dy", "0.35em");
    enter.append("text").attr("class", "kg-name").attr("text-anchor", "middle").attr("dy", "28");
    enter.append("text").attr("class", "kg-skills").attr("text-anchor", "middle").attr("dy", "42");
    enter.append("g").attr("class", "kg-dots");
    enter.append("g").attr("class", "kg-set-dots");

    enter.call(
      drag<SVGGElement, SimNode>()
        .filter(() => !pickMode && !angleArmed)
        .on("start", function (ev, d) {
          ev.sourceEvent.stopPropagation();
          sim.stop();
          dragging = true;
          dragMoved = false;
          nodeG.classed("kg-no-anim", true);
          const src = ev.sourceEvent as MouseEvent;
          dragOrigin = {
            x: d.x ?? 0,
            y: d.y ?? 0,
            px: src.clientX,
            py: src.clientY,
            k: zoomTransform(svgNode).k || 1,
          };
        })
        .on("drag", function (ev, d) {
          const src = ev.sourceEvent as MouseEvent;
          const k = dragOrigin.k || 1;
          const dx = (src.clientX - dragOrigin.px) / k;
          const dy = (src.clientY - dragOrigin.py) / k;
          if (dx === 0 && dy === 0) return;
          if (layoutMode === "layers") {
            const pt = pointer(src, svgNode);
            const z = zoomTransform(svgNode);
            const [lx, ly] = z.invert(pt);
            const fl = floorsByNode().get(d.id) ?? 0;
            const p = unproject(lx, ly, fl, angle, origin.x, origin.y);
            d.x = p.x;
            d.y = p.y;
          } else {
            d.x = dragOrigin.x + dx;
            d.y = dragOrigin.y + dy;
          }
          d.fx = d.x;
          d.fy = d.y;
          d.vx = 0;
          d.vy = 0;
          if (Math.hypot(src.clientX - dragOrigin.px, src.clientY - dragOrigin.py) > 3) dragMoved = true;
          ticked();
        })
        .on("end", function (_ev, d) {
          dragging = false;
          d.vx = 0;
          d.vy = 0;
          d.fx = d.x;
          d.fy = d.y;
          nodeG.classed("kg-no-anim", false);
        }),
    );

    const merged = enter.merge(nodeSel);
    merged.attr("class", (d) => nodeClass(d));
    merged.select("circle.kg-disc").attr("r", (d) => {
      const onChosen = extraIds.includes(d.id) || (setFilter.length ? lit().has(d.id) : !!focusedSet && lit().has(d.id));
      const small = !d.pending && d.isolate && !showUnlinked && !focus && !onChosen;
      return small ? 7 : 16;
    }).attr("fill", (d) => (d.pending ? "none" : NODE_FILL))
      .attr("stroke", (d) => (d.pending ? "#111827" : null))
      .attr("stroke-width", (d) => (d.pending ? 2 : null))
      .attr("stroke-dasharray", (d) => (d.pending ? "5 3.5" : null));
    merged.select("text.kg-id").text((d) => d.id);
    merged.select("text.kg-name").text((d) => d.name);
    merged.select("text.kg-skills").text((d) => compactMotorLabel(d.motorSkills));
    merged.each(function (d) {
      paintNodeMarks(select(this), d);
      const g = this as SVGGElement;
      let minX = -18, minY = -18, maxX = 18, maxY = 18;
      g.querySelectorAll("circle.kg-disc, text").forEach((node) => {
        try {
          const b = (node as SVGGraphicsElement).getBBox();
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.width);
          maxY = Math.max(maxY, b.y + b.height);
        } catch {
          /* text not laid out yet */
        }
      });
      select(g).select("rect.kg-hit")
        .attr("x", minX - 8)
        .attr("y", minY - 6)
        .attr("width", Math.max(16, maxX - minX + 16))
        .attr("height", Math.max(16, maxY - minY + 12));
    });

    merged.on("click", (ev, d) => {
      ev.stopPropagation();
      if (dragMoved) {
        dragMoved = false;
        if (!pickMode) return;
      }
      onNodeClick(d);
    });
    merged.on("mouseenter", function (ev, d) {
      if (dragging || pickMode) return;
      window.clearTimeout(tipHideT);
      window.clearTimeout(tipShowT);
      const el = this as SVGGElement;
      tipShowT = window.setTimeout(() => {
        if (d.pending) opts.onHoverPeek?.(d.id, el as unknown as HTMLElement);
        else openNodeTip(d, el);
      }, HOVER_DWELL_MS);
    });
    merged.on("mouseleave", () => {
      window.clearTimeout(tipShowT);
      window.clearTimeout(tipHideT);
      tipHideT = window.setTimeout(() => hideNodeTip(), 220);
    });

    let edgeShowT = 0;
    const onEdgeClick = (ev: MouseEvent, d: SimLink) => {
      ev.stopPropagation();
      openEdgePop(ev, d);
    };
    const onEdgeEnter = function (this: SVGLineElement, _ev: MouseEvent, d: SimLink) {
      window.clearTimeout(edgeShowT);
      const el = this;
      edgeShowT = window.setTimeout(() => {
        opts.onEdgeHover?.(el as unknown as HTMLElement, d);
      }, HOVER_DWELL_MS);
    };
    const onEdgeLeave = (ev: MouseEvent) => {
      window.clearTimeout(edgeShowT);
      opts.onEdgeLeave?.(ev);
    };
    hitMerged.on("click", onEdgeClick).on("mouseenter", onEdgeEnter).on("mouseleave", onEdgeLeave);

    void visibleNode;
    ticked();
  }

  function currentPlan(): Map<string, number> {
    return floorPlan(floorSets, sets.map((s) => s.id), mergeFloors);
  }

  function draftFloorIndex(): number {
    if (!picked.size) return 0;
    const plan = currentPlan();
    let max = 0;
    for (const sid of floorSets) max = Math.max(max, plan.get(sid) ?? 0);
    return max + 1;
  }

  function floorsByNode(): Map<string, number> {
    const map = new Map<string, number>();
    if (layoutMode !== "layers") return map;
    const plan = currentPlan();
    for (const sid of floorSets) {
      const f = plan.get(sid) ?? 0;
      for (const id of effectiveMembers(sets, sid)) {
        map.set(id, Math.max(map.get(id) ?? 0, f));
      }
    }
    if (picked.size) {
      const draft = draftFloorIndex();
      for (const id of picked) map.set(id, draft);
    }
    return map;
  }

  function xyAt(n: SimNode | undefined, floors: Map<string, number>): Pt {
    const x = n?.x ?? 0;
    const y = n?.y ?? 0;
    if (layoutMode !== "layers") return { x, y };
    return proj(x, y, n ? floors.get(n.id) ?? 0 : 0);
  }

  function ticked() {
    const floors = floorsByNode();
    linkG.selectAll<SVGLineElement, SimLink>("line")
      .attr("x1", (d) => xyAt(asNode(d.easier && byId.has(d.easier) ? d.easier : idOf(d.source), byId), floors).x)
      .attr("y1", (d) => xyAt(asNode(d.easier && byId.has(d.easier) ? d.easier : idOf(d.source), byId), floors).y)
      .attr("x2", (d) => xyAt(asNode(d.harder && byId.has(d.harder) ? d.harder : idOf(d.target), byId), floors).x)
      .attr("y2", (d) => xyAt(asNode(d.harder && byId.has(d.harder) ? d.harder : idOf(d.target), byId), floors).y);

    labelG.selectAll<SVGTextElement, SimLink>("text")
      .attr("x", (d) => {
        const a = xyAt(asNode(idOf(d.source), byId), floors);
        const b = xyAt(asNode(idOf(d.target), byId), floors);
        return (a.x + b.x) / 2;
      })
      .attr("y", (d) => {
        const a = xyAt(asNode(idOf(d.source), byId), floors);
        const b = xyAt(asNode(idOf(d.target), byId), floors);
        return (a.y + b.y) / 2 - 6;
      })
      .text(null)
      .each(function (d) {
        const el = select(this);
        el.selectAll("tspan").remove();
        if (!focus && !focusedSet && !setFilter.length) return;
        const a = idOf(d.source);
        const b = idOf(d.target);
        const bright = lit();
        if (!bright.has(a) || !bright.has(b)) return;
        const kind = d.kinds.includes("progression") ? "progression" : d.kinds.includes("regression") ? "regression" : "related";
        const extra = [d.tags[0], d.notes[0]].filter(Boolean).join(" · ");
        el.append("tspan").attr("x", el.attr("x")).attr("dy", "0").text(kind);
        if (extra) el.append("tspan").attr("x", el.attr("x")).attr("dy", "11").text(extra);
      });

    nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").attr("transform", (d) => {
      const p = xyAt(d, floors);
      return `translate(${p.x},${p.y})`;
    });
    paintHull();
    paintFloors();
    paintPivot();
  }

  function paintHull() {
    if (layoutMode === "layers") {
      hullG.selectAll("path").remove();
      return;
    }
    const rows = sets
      .map((s) => {
        const pts = [...setBright(s, materials)]
          .map((id) => byId.get(id))
          .filter((n): n is SimNode => !!n && n.x != null && n.y != null)
          .map((n) => ({ x: n.x as number, y: n.y as number }));
        return { s, pts };
      })
      .filter((row) => row.pts.length >= 2);
    const sel = hullG.selectAll<SVGPathElement, { s: MaterialSet; pts: Pt[] }>("path").data(rows, (d) => d.s.id);
    sel.exit().remove();
    sel
      .enter()
      .append("path")
      .merge(sel)
      .attr("class", (d) => "kg-hull" + (setFilter.includes(d.s.id) || focusedSet === d.s.id ? " on" : ""))
      .attr("fill", (d) => setColor(d.s.id))
      .attr("fill-opacity", (d) => (setFilter.includes(d.s.id) || focusedSet === d.s.id ? 0.28 : 0.16))
      .attr("stroke", (d) => setColor(d.s.id))
      .attr("stroke-opacity", (d) => (setFilter.includes(d.s.id) || focusedSet === d.s.id ? 0.9 : 0.55))
      .attr("stroke-width", (d) => (setFilter.includes(d.s.id) || focusedSet === d.s.id ? 3 : 2))
      .attr("d", (d) => hullPath(d.pts, d.pts.length === 2 ? 72 : 34));
  }

  function floorCentroid(s: MaterialSet): Pt | null {
    const ids = effectiveMembers(sets, s.id);
    const pts = ids
      .map((id) => byId.get(id))
      .filter((n): n is SimNode => !!n && n.x != null && n.y != null)
      .map((n) => ({ x: n.x as number, y: n.y as number }));
    if (!pts.length) return null;
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  }

  function paintRisers() {
    floorG.select("g.kg-risers").selectAll("line").remove();
  }

  function paintFloors() {
    if (layoutMode !== "layers") {
      floorG.selectAll("g.kg-floor").remove();
      floorG.selectAll("g.kg-draft").remove();
      floorG.selectAll("g.kg-risers").selectAll("line").remove();
      return;
    }
    seedFloorSets();
    const tickedIds = new Set(floorSets);
    const plan = currentPlan();
    const nodeFloors = floorsByNode();
    const boxKey =
      sets.map((s) => s.id + ":" + s.members.join(".")).join("|") +
      "/" +
      floorSets.join(",") +
      "/" +
      mergeFloors +
      "/" +
      [...picked].join(",");
    if (boxKey !== plateBoxKey) {
      plateBoxes = new Map();
      plateBoxKey = boxKey;
    }
    const rows = [...sets].sort((a, b) => (plan.get(a.id) ?? 0) - (plan.get(b.id) ?? 0));
    const noAnim = dragging;
    floorG.classed("kg-no-anim", noAnim);
    const sel = floorG.selectAll<SVGGElement, MaterialSet>("g.kg-floor:not(.kg-draft)").data(rows, (d) => d.id);
    const enter = sel.enter().append("g").attr("class", "kg-floor");
    enter.style("opacity", "0.1");
    enter.append("path").attr("class", "kg-hull kg-floor-hull").style("cursor", "pointer");
    enter.append("text").attr("class", "kg-floor-lab").attr("text-anchor", "middle");
    sel.exit().remove();
    const merged = enter.merge(sel);
    const pad = 38;
    merged.sort((a, b) => (plan.get(a.id) ?? 0) - (plan.get(b.id) ?? 0));
    merged.each(function (s) {
      const g = select(this);
      const parked = !tickedIds.has(s.id);
      const floor = plan.get(s.id) ?? 1;
      const ids = effectiveMembers(sets, s.id);
      const sitters = ids.filter((id) => (nodeFloors.get(id) ?? 0) === floor);
      const simPts = sitters
        .map((id) => byId.get(id))
        .filter((n): n is SimNode => !!n && n.x != null && n.y != null)
        .map((n) => ({ x: n.x as number, y: n.y as number }));
      let box = plateBoxes.get(s.id);
      if (simPts.length) {
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const p of simPts) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
        box = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
        plateBoxes.set(s.id, box);
      } else if (!box) {
        const allPts = ids
          .map((id) => byId.get(id))
          .filter((n): n is SimNode => !!n && n.x != null && n.y != null)
          .map((n) => ({ x: n.x as number, y: n.y as number }));
        if (allPts.length) {
          let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
          for (const p of allPts) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          box = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
          plateBoxes.set(s.id, box);
        }
      }
      const corners = box
        ? [
            { x: box.minX, y: box.minY },
            { x: box.maxX, y: box.minY },
            { x: box.maxX, y: box.maxY },
            { x: box.minX, y: box.maxY },
          ].map((p) => proj(p.x, p.y, floor))
        : [];
      g.select("path.kg-floor-hull")
        .attr("d", hullPath(corners, 0, "poly"))
        .attr("fill", setColor(s.id))
        .attr("fill-opacity", parked ? 0.08 : 0.32)
        .attr("stroke", setColor(s.id))
        .attr("stroke-width", tickedIds.has(s.id) ? 3 : 2)
        .on("click", (ev) => {
          ev.stopPropagation();
          if (drawArmed) return;
          setSetFocus(s.id);
        });
      if (box) {
        const pc = proj((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, floor);
        g.select("text.kg-floor-lab").attr("x", pc.x).attr("y", pc.y).text(s.name || s.id);
      } else {
        g.select("text.kg-floor-lab").text("");
      }
      g.select("g.kg-floor-copies").remove();
    });

    const draftData = picked.size ? ["draft"] : [];
    const draftSel = floorG.selectAll<SVGGElement, string>("g.kg-draft").data(draftData);
    draftSel.exit().remove();
    const draftEnter = draftSel.enter().append("g").attr("class", "kg-floor kg-draft");
    draftEnter.append("path").attr("class", "kg-hull kg-floor-hull");
    draftEnter.append("text").attr("class", "kg-floor-lab").attr("text-anchor", "middle");
    const draftMerged = draftEnter.merge(draftSel);
    if (picked.size) {
      const dFloor = draftFloorIndex();
      const simPts = [...picked]
        .map((id) => byId.get(id))
        .filter((n): n is SimNode => !!n && n.x != null && n.y != null)
        .map((n) => ({ x: n.x as number, y: n.y as number }));
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of simPts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const dBox = simPts.length
        ? { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
        : null;
      const dCorners = dBox
        ? [
            { x: dBox.minX, y: dBox.minY },
            { x: dBox.maxX, y: dBox.minY },
            { x: dBox.maxX, y: dBox.maxY },
            { x: dBox.minX, y: dBox.maxY },
          ].map((p) => proj(p.x, p.y, dFloor))
        : [];
      draftMerged.select("path.kg-floor-hull").attr("d", hullPath(dCorners, 0, "poly"));
      if (dBox) {
        const pc = proj((dBox.minX + dBox.maxX) / 2, (dBox.minY + dBox.maxY) / 2, dFloor);
        draftMerged.select("text.kg-floor-lab").attr("x", pc.x).attr("y", pc.y).text("New set");
      } else {
        draftMerged.select("text.kg-floor-lab").text("");
      }
    }

    const applyLift = () => {
      merged
        .attr("transform", (s) => {
          const parked = !tickedIds.has(s.id);
          return parked ? `translate(${PARK_FLOOR_DX},0)` : null;
        })
        .style("opacity", (s) => (tickedIds.has(s.id) ? "1" : "0.1"));
    };

    if (noAnim) {
      floorG.classed("kg-lifting", false);
      applyLift();
      paintRisers();
    } else {
      floorG.classed("kg-lifting", true);
      floorG.select("g.kg-risers").selectAll("line").remove();
      requestAnimationFrame(() => {
        applyLift();
      });
      window.setTimeout(() => {
        if (!floorG.classed("kg-lifting")) return;
        floorG.classed("kg-lifting", false);
        paintRisers();
      }, 450);
      merged.on("transitionend.floor", (ev) => {
        const te = ev as unknown as TransitionEvent;
        if (te.propertyName && te.propertyName !== "transform") return;
        floorG.classed("kg-lifting", false);
        paintRisers();
      });
    }
  }

  function applyFocus() {
    nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").attr("class", (d) => nodeClass(d));
    paintEdgeMarks(linkG.selectAll<SVGLineElement, SimLink>("line.kg-edge"));
    fillSide();
    ticked();
  }

  function rememberFocus(id: string | null) {
    if (histSkip || !id) return;
    const ids = sideHist.ids.slice(0, sideHist.i + 1);
    if (ids[ids.length - 1] === id) {
      sideHist = { ids, i: ids.length - 1 };
      return;
    }
    ids.push(id);
    while (ids.length > 3) ids.shift();
    sideHist = { ids, i: ids.length - 1 };
  }

  function histGo(dir: -1 | 1) {
    const ni = sideHist.i + dir;
    if (ni < 0 || ni >= sideHist.ids.length) return;
    sideHist.i = ni;
    histSkip = true;
    setFocus(sideHist.ids[ni] || null);
    histSkip = false;
  }

  function setFocus(id: string | null) {
    rememberFocus(id);
    focus = id;
    if (id) focusedSet = null;
    drawArmed = false;
    hidePops();
    applyFocus();
  }

  function setSetFocus(id: string | null) {
    focusedSet = id;
    if (id) focus = null;
    drawArmed = false;
    hidePops();
    applyFocus();
  }

  function onNodeClick(d: SimNode) {
    if (drawArmed) {
      if (!focus || focus === d.id) {
        opts.toast("Click a different node to link");
        return;
      }
      openDrawPop(d.id);
      return;
    }
    if (pickMode) {
      if (!picked.has(d.id)) togglePicked(d.id);
      else setFocus(d.id);
      return;
    }
    if (focus && focus !== d.id) {
      openDrawPop(d.id);
      return;
    }
    setFocus(d.id);
  }

  function hidePops() {
    hideNodeTip();
    if (drawPop) {
      drawPop.hidden = true;
      drawPop.classList.remove("open");
    }
    if (edgePop) {
      edgePop.hidden = true;
      edgePop.classList.remove("open");
    }
  }

  function placePop(el: HTMLElement, ev: { clientX: number; clientY: number }) {
    el.hidden = false;
    el.classList.add("open");
    const w = el.offsetWidth || 280;
    const h = el.offsetHeight || 180;
    let left = ev.clientX + 12;
    let top = ev.clientY + 12;
    if (left + w > window.innerWidth - 12) left = ev.clientX - w - 12;
    if (top + h > window.innerHeight - 12) top = ev.clientY - h - 12;
    el.style.left = Math.round(Math.max(8, left)) + "px";
    el.style.top = Math.round(Math.max(8, top)) + "px";
  }

  function openDrawPop(toId: string) {
    if (!drawPop || !focus) return;
    const from = focus;
    (drawPop.querySelector("[name=from]") as HTMLInputElement).value = from;
    (drawPop.querySelector("[name=to]") as HTMLInputElement).value = toId;
    const title = drawPop.querySelector(".kg-pop-title");
    const fm = materials.find((m) => m.id === from);
    const tm = materials.find((m) => m.id === toId);
    if (title) title.textContent = (fm ? fm.id + " " + fm.name : from) + " → " + (tm ? tm.id + " " + tm.name : toId);
    const noteEl = drawPop.querySelector("#kg-draw-note") as HTMLInputElement | null;
    const kind = drawPop.querySelector("#kg-draw-kind") as HTMLSelectElement;
    const related = kind && kind.value === "related";
    if (noteEl) noteEl.placeholder = related ? "e.g. Legs or Legs: why this pile" : "Why this hop";
    placePop(drawPop, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
  }

  function openEdgePop(ev: MouseEvent, e: SimLink) {
    if (!edgePop) return;
    const box = edgePop.querySelector(".kg-edge-list") as HTMLElement;
    if (!box) return;
    box.replaceChildren();
    for (const L of e.links) {
      const row = document.createElement("div");
      row.className = "kg-edge-row";
      const lab = document.createElement("div");
      const chain = L.kind === "progression" || L.kind === "regression";
      const leapLab = chain ? ` <span class="kg-leap">${hopLeap(L).toFixed(1)}</span>` : "";
      lab.innerHTML = `<b>${escapeAttr(L.kind)}</b>${leapLab}${L.tag ? `<div class="mute">${escapeAttr(L.tag)}</div>` : ""}${L.note ? `<div class="mute">${escapeAttr(L.note)}</div>` : ""}`;
      const btn = document.createElement("button");
      btn.className = "btn danger";
      btn.type = "button";
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        await opts.onDeleteLink(L.from, L.kind, L.to);
        hidePops();
      });
      row.append(lab, btn);
      box.append(row);
    }
    placePop(edgePop, ev);
  }

  function sameSet(id: string): Material[] {
    return materials.filter((x) => x.id !== id && sharesLeafSet(sets, id, x.id)).slice(0, 8);
  }

  function mentionHtml(note: string): string {
    const bits = String(note || "").split(/(@M\d+)/g);
    return bits
      .map((bit) => {
        const m = /^@M\d+$/.exec(bit);
        if (!m) return escapeAttr(bit).replace(/\n/g, "<br>");
        const id = bit.slice(1);
        const o = materials.find((x) => x.id === id);
        if (!o) return `<span class="mute">${bit}</span>`;
        return `<button type="button" class="kg-mention" data-kg-peek="${id}">${id} ${o.name}</button>`;
      })
      .join("");
  }

  function bindMentions(root: HTMLElement) {
    root.querySelectorAll("[data-kg-peek]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = (btn as HTMLElement).dataset.kgPeek || "";
        opts.onPeekNode?.(id, btn as HTMLElement);
      });
    });
  }

  function wireNoteMentions(noteEl: HTMLInputElement | HTMLTextAreaElement, onPick?: () => void) {
    bindNoteMentions(noteEl, {
      onSearch: opts.onSearch,
      materials: () => materials,
      onPick,
      onPeek: opts.onHoverPeek,
      onPeekLeave: opts.onHoverPeekLeave,
    });
  }

  function histNavHtml() {
    const back = sideHist.i <= 0 ? " disabled" : "";
    const fwd = sideHist.i < 0 || sideHist.i >= sideHist.ids.length - 1 ? " disabled" : "";
    return `<div class="kg-hist" role="group" aria-label="Recent cards">
      <button type="button" class="kg-hist-btn" id="kg-hist-back"${back} aria-label="Previous card">←</button>
      <button type="button" class="kg-hist-btn" id="kg-hist-fwd"${fwd} aria-label="Next card">→</button>
    </div>`;
  }

  function bindHistNav() {
    document.getElementById("kg-hist-back")?.addEventListener("click", () => histGo(-1));
    document.getElementById("kg-hist-fwd")?.addEventListener("click", () => histGo(1));
  }

  function fillSide() {
    if (!side) return;
    const setChips = (except?: string) =>
      sets
        .filter((s) => s.id !== except)
        .map(
          (s) =>
            `<button type="button" class="kg-set-chip${setFilter.includes(s.id) || focusedSet === s.id ? " on" : ""}" data-kg-set="${s.id}" style="--set-c:${setColor(s.id)}">${s.name || s.id}</button>`,
        )
        .join("");

    if (focusedSet) {
      const s = sets.find((x) => x.id === focusedSet);
      if (!s) {
        focusedSet = null;
      } else {
        const rows = s.members
          .map((id) => {
            const o = materials.find((y) => y.id === id);
            return `<div class="kg-set-member"><button type="button" class="kg-hop" data-kg-focus="${id}">${id} ${o ? o.name : ""}</button><button type="button" class="btn danger" data-kg-drop="${id}">Remove</button></div>`;
          })
          .join("");
        side.innerHTML = `
          <div class="kg-side-head">
            ${histNavHtml()}
            <div class="kg-side-id">${s.id}</div>
            <input id="kg-set-name" type="text" value="${escapeAttr(s.name)}" />
            <input id="kg-set-note" type="text" placeholder="Why these go together" value="${escapeAttr(s.note)}" />
            <div class="kg-set-note-preview">${mentionHtml(s.note) || `<span class="mute">Type @ to mention a card</span>`}</div>
          </div>
          <div class="kg-set-list">${rows || `<span class="mute">No members</span>`}</div>
          <button type="button" class="btn danger" id="kg-set-del">Delete activity set</button>
          <div class="kg-set-chips">${setChips(s.id)}</div>
        `;
        bindSetChips(side);
        bindHistNav();
        side.querySelectorAll("[data-kg-focus]").forEach((btn) => {
          btn.addEventListener("click", () => setFocus((btn as HTMLElement).dataset.kgFocus || null));
        });
        side.querySelectorAll("[data-kg-drop]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = (btn as HTMLElement).dataset.kgDrop;
            if (!id || !opts.onUpdateSet) return;
            const next = s.members.filter((m) => m !== id);
            await opts.onUpdateSet(s.id, { members: next });
          });
        });
        const nameEl = document.getElementById("kg-set-name") as HTMLInputElement | null;
        const noteEl = document.getElementById("kg-set-note") as HTMLInputElement | null;
        const saveMeta = async () => {
          if (!opts.onUpdateSet) return;
          await opts.onUpdateSet(s.id, { name: nameEl?.value || s.name, note: noteEl?.value || "" });
        };
        nameEl?.addEventListener("change", saveMeta);
        noteEl?.addEventListener("change", saveMeta);
        if (noteEl) wireNoteMentions(noteEl, saveMeta);
        bindMentions(side);
        document.getElementById("kg-set-del")?.addEventListener("click", async () => {
          if (!opts.onDeleteSet) return;
          if (!confirm("Delete activity set " + (s.name || s.id) + "?")) return;
          await opts.onDeleteSet(s.id);
        });
        return;
      }
    }

    if (!focus) {
      side.innerHTML = `<div class="kg-side-empty">${histNavHtml()}<h3>Select an activity</h3><p class="mute">Click a node. Neighbours within the hops control stay bright. Second click draws a typed link. Or select an activity set below.</p><div class="kg-set-chips">${setChips() || `<span class="mute">No activity sets yet — search activities to make one.</span>`}</div></div>`;
      bindSetChips(side);
      bindHistNav();
      return;
    }
    const m = materials.find((x) => x.id === focus);
    if (!m) return;
    const cols = hopColumns(focus, links, materials, getPositions(), sets);
    const src = opts.sketchSrc(m);
    const hop = (arr: { id: string; note: string; tag?: string; rank?: number }[], ranked = false) => {
      if (!arr.length) return `<span class="mute">—</span>`;
      let marked = false;
      return arr
        .map((x, i) => {
          const o = materials.find((y) => y.id === x.id);
          const suggested = x.note === "suggested";
          const tag = x.tag && !suggested ? `<div class="mute kg-hop-tag">${escapeAttr(x.tag)}</div>` : "";
          const note = !suggested && x.note ? `<div class="mute kg-hop-tag">${escapeAttr(x.note)}</div>` : "";
          const rankPrefix = ranked && suggested ? `${x.rank || i + 1}. ` : "";
          const row = `<button type="button" class="kg-hop" data-kg-focus="${x.id}">${rankPrefix}${x.id} ${o ? o.name : ""}</button>${tag}${note}`;
          if (suggested && !marked) {
            marked = true;
            return `<div class="mute kg-suggested-break">-- below are suggested --</div>${row}`;
          }
          return row;
        })
        .join("");
    };
    const same = sameSet(focus);
    const paths = pathLabelsForMaterial(sets, m.id);
    const pathHtml = paths.length
      ? paths.map((p) => `<div class="mute">${escapeAttr(p.label)}</div>`).join("")
      : `<div class="mute">No set</div>`;
    const mine = sets.filter((s) => s.members.includes(m.id));
    const mineHtml = mine.length
      ? `<div class="kg-set-chips">${mine
          .map(
            (s) =>
              `<span class="kg-set-chip-wrap" style="--set-c:${setColor(s.id)}"><button type="button" class="kg-set-chip" data-kg-set="${s.id}">${escapeAttr(s.name || s.id)}</button><button type="button" class="kg-set-x" data-kg-leave="${s.id}" title="Remove from this activity set" aria-label="Remove from ${escapeAttr(s.name || s.id)}">×</button></span>`,
          )
          .join("")}</div>`
      : "";
    const explain = String(m.notes || "")
      .replace(/^\s*Sketch:\s*(?:library\/media_library\/flag football|media_library|canva-sketches|library\/sketches)\/\S+\s*$/gmi, "")
      .replace(/(?:library\/media_library\/flag football|media_library|canva-sketches|library\/sketches)\/[\w\-.]+\.(?:png|jpe?g|webp|gif|mp4|m4v|webm|mov)/gi, "")
      .replace(/^\s*Drill notes:\s*\S+\s*$/gmi, "")
      .replace(/^\s*Sketch:\s*$/gmi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    side.innerHTML = `
      <div class="kg-side-head">
        ${histNavHtml()}
        <div class="kg-side-id">${m.id}</div>
        <h3>${m.name}</h3>
        <div class="mute">${m.duration || "—"} min</div>
        ${pathHtml}
      </div>
      <label class="kg-look"><b>What to look for</b>
        <textarea id="kg-look-edit" rows="3">${escapeAttr(m.look || "")}</textarea>
      </label>
      <label class="kg-look"><b>Explanation</b>
        <span class="field-with-polish">
          <textarea id="kg-notes-edit" rows="5" placeholder="${escapeAttr(NOTES_PLACEHOLDER)}">${escapeAttr(explain)}</textarea>
          <button class="btn" type="button" id="kg-notes-polish" title="Make this explanation shorter and clearer">Polish</button>
        </span>
      </label>
      <div class="kg-cols">
        <div data-nb="regression"><b class="k-regression">Easier</b>${hop(cols.easier)}</div>
        <div data-nb="progression"><b class="k-progression">Harder</b>${hop(cols.harder)}</div>
      </div>
      <div class="kg-cols">
        <div data-nb="related"><b class="k-related">Related</b>${hop(cols.alts, true)}</div>
        <div><b>Shared sets</b>${same.length ? same.map((x) => `<button type="button" class="kg-hop" data-kg-focus="${x.id}">${x.id} ${x.name}</button>`).join("") : `<span class="mute">—</span>`}</div>
      </div>
      ${mineHtml}
      ${src ? (/\.(mp4|webm|mov)(\?|#|$)/i.test(src) ? `<video class="kg-pic" src="${src}" muted playsinline preload="metadata"></video>` : `<img class="kg-pic" src="${src}" alt="" />`) : ""}
    `;
    side.querySelectorAll("[data-kg-focus]").forEach((btn) => {
      btn.addEventListener("click", () => setFocus((btn as HTMLElement).dataset.kgFocus || null));
    });
    bindSetChips(side);
    bindHistNav();
    const lookEl = document.getElementById("kg-look-edit") as HTMLTextAreaElement | null;
    lookEl?.addEventListener("change", async () => {
      if (!focus || !opts.onUpdateMaterial) return;
      const look = lookEl.value;
      m.look = look;
      await opts.onUpdateMaterial(focus, { look });
    });
    const notesEl = document.getElementById("kg-notes-edit") as HTMLTextAreaElement | null;
    notesEl?.addEventListener("change", async () => {
      if (!focus || !opts.onUpdateMaterial) return;
      const notes = notesEl.value.trim();
      m.notes = notes;
      await opts.onUpdateMaterial(focus, { notes });
    });
    if (notesEl) wireNoteMentions(notesEl);
    const polishBtn = document.getElementById("kg-notes-polish") as HTMLButtonElement | null;
    polishBtn?.addEventListener("click", async () => {
      if (!focus || !opts.onPolish || !notesEl) return;
      const draft = notesEl.value.trim();
      const ids: string[] = [];
      const re = /@M(\d+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(draft))) {
        const id = "M" + mm[1];
        if (!ids.includes(id)) ids.push(id);
      }
      const tagged = ids.map((id) => {
        const card = materials.find((x) => x.id === id);
        if (!card) return null;
        const notes = String(card.notes || "")
          .replace(/^\s*Sketch:\s*.*$/gmi, "")
          .trim();
        return { id: card.id, name: card.name, look: card.look || "", notes };
      }).filter(Boolean);
      if (!draft) {
        opts.toast("Write something first");
        return;
      }
      polishBtn.disabled = true;
      const prev = polishBtn.textContent;
      polishBtn.textContent = "…";
      try {
        const text = (await opts.onPolish("explanation", draft, JSON.stringify({ title: m.id + " " + m.name, tagged }))).text;
        notesEl.value = text;
        m.notes = text;
        await opts.onUpdateMaterial?.(focus, { notes: text });
        opts.toast("Polished");
      } catch (err) {
        opts.toast(String(err instanceof Error ? err.message : err).slice(0, 180));
      } finally {
        polishBtn.disabled = false;
        polishBtn.textContent = prev;
      }
    });
    bindMentions(side);
  }

  function bindSetChips(root: HTMLElement) {
    root.querySelectorAll("[data-kg-set]").forEach((btn) => {
      btn.addEventListener("click", () => setSetFocus((btn as HTMLElement).dataset.kgSet || null));
    });
    root.querySelectorAll("[data-kg-leave]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sid = (btn as HTMLElement).dataset.kgLeave;
        if (!sid || !focus || !opts.onUpdateSet) return;
        const s = sets.find((x) => x.id === sid);
        if (!s) return;
        await opts.onUpdateSet(sid, { members: s.members.filter((id) => id !== focus) });
      });
    });
  }

  function escapeAttr(v: string) {
    return String(v || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function taxonomyLeaves(rootSet: MaterialSet): MaterialSet[] {
    const vocab =
      rootSet.name === MOTOR_ROOT_NAME ? MOTOR_SKILLS : rootSet.name === COMPONENT_ROOT_NAME ? SKILL_RELATED_COMPONENTS : null;
    if (!vocab) return childrenOf(sets, rootSet.id);
    const nested = childrenOf(sets, rootSet.id);
    const pool = nested.length ? nested : sets.filter((s) => s.id !== rootSet.id);
    const byName = new Map<string, MaterialSet>();
    for (const s of pool) {
      if ((vocab as readonly string[]).includes(s.name) && !byName.has(s.name)) byName.set(s.name, s);
    }
    return vocab.map((name) => byName.get(name)).filter((s): s is MaterialSet => !!s);
  }

  function refreshLayerFloors() {
    if (layoutMode !== "layers") return;
    seedFloorSets();
    paintFloors();
  }

  function commitFacetFilter() {
    paintFacets();
    applyFocus();
    draw();
    refreshLayerFloors();
    saveKgView();
  }

  function facetSkillGroupIds(rootSet: MaterialSet): string[] {
    return [rootSet.id, ...taxonomyLeaves(rootSet).map((s) => s.id)];
  }

  function facetIndieIds(): string[] {
    return roots(sets, "independent").map((s) => s.id);
  }

  function facetGroupSelection(rootSet: MaterialSet): string | null {
    const group = new Set(facetSkillGroupIds(rootSet));
    return setFilter.find((id) => group.has(id)) ?? null;
  }

  function clearFacetIds(ids: Iterable<string>) {
    const drop = new Set(ids);
    setFilter = setFilter.filter((id) => !drop.has(id));
  }

  function normalizeSetFilter() {
    for (const rootSet of roots(sets, "first")) {
      const leaves = taxonomyLeaves(rootSet).map((s) => s.id);
      if (setFilter.includes(rootSet.id) && !leaves.some((id) => setFilter.includes(id))) {
        setFilter = setFilter.filter((id) => id !== rootSet.id);
      }
    }
  }

  function pickSkillFacet(rootSet: MaterialSet, id: string | null) {
    clearFacetIds(facetSkillGroupIds(rootSet));
    if (id) {
      setFilter = [...setFilter, id];
      focusedSet = id;
    } else if (focusedSet && facetSkillGroupIds(rootSet).includes(focusedSet)) {
      focusedSet = setFilter[setFilter.length - 1] ?? null;
    }
    commitFacetFilter();
  }

  function toggleSkillLeaf(rootSet: MaterialSet, leafId: string) {
    if (facetGroupSelection(rootSet) === leafId) pickSkillFacet(rootSet, null);
    else pickSkillFacet(rootSet, leafId);
  }

  function pickIndieFacet(id: string) {
    const on = setFilter.includes(id);
    clearFacetIds(facetIndieIds());
    if (!on) {
      setFilter = [...setFilter, id];
      focusedSet = id;
    } else if (focusedSet === id) {
      focusedSet = setFilter[setFilter.length - 1] ?? null;
    }
    commitFacetFilter();
  }

  function paintFacets() {
    if (!bodiesEl) return;
    bodiesEl.replaceChildren();
    const all = document.createElement("button");
    all.type = "button";
    all.className = "kg-facet-chip" + (setFilter.length === 0 ? " on" : "");
    all.textContent = "All skills";
    all.addEventListener("click", () => {
      setFilter = [];
      focusedSet = null;
      commitFacetFilter();
    });
    const indieGroup = document.createElement("div");
    indieGroup.className = "kg-facet-group";
    const indieTitle = document.createElement("div");
    indieTitle.className = "kg-facet-root";
    indieTitle.textContent = "Activity set";
    const top = document.createElement("div");
    top.className = "kg-facet-kids";
    top.append(all);
    for (const s of roots(sets, "independent")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kg-facet-chip" + (setFilter.includes(s.id) ? " on" : "");
      btn.textContent = s.name || s.id;
      btn.title = "Show this activity set";
      btn.addEventListener("click", () => pickIndieFacet(s.id));
      top.append(btn);
    }
    indieGroup.append(indieTitle, top);
    bodiesEl.append(indieGroup);
    for (const rootSet of roots(sets, "first")) {
      const group = document.createElement("div");
      group.className = "kg-facet-group";
      const head = document.createElement("div");
      head.className = "kg-facet-root";
      head.textContent = rootSet.name || rootSet.id;
      const kids = document.createElement("div");
      kids.className = "kg-facet-kids";
      const selected = facetGroupSelection(rootSet);
      const allIn = document.createElement("button");
      allIn.type = "button";
      allIn.className = "kg-facet-chip" + (!selected ? " on" : "");
      allIn.textContent = "All";
      allIn.title = "Show every activity in this skill";
      allIn.addEventListener("click", () => pickSkillFacet(rootSet, null));
      kids.append(allIn);
      for (const s of taxonomyLeaves(rootSet)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kg-facet-chip" + (selected === s.id ? " on" : "");
        btn.textContent = s.name || s.id;
        btn.addEventListener("click", () => toggleSkillLeaf(rootSet, s.id));
        kids.append(btn);
      }
      group.append(head, kids);
      bodiesEl.append(group);
    }
  }

  svg.on("click", () => {
    dragMoved = false;
    if (drawArmed || pickMode) return;
    hideNodeTip();
    setFocus(null);
    setSetFocus(null);
  });

  function facetIdsForPicked(): string[] {
    const ids: string[] = [];
    for (const s of roots(sets, "independent")) {
      const mem = new Set(effectiveMembers(sets, s.id));
      for (const id of picked) {
        if (mem.has(id)) {
          ids.push(s.id);
          break;
        }
      }
    }
    for (const rootSet of roots(sets, "first")) {
      for (const s of taxonomyLeaves(rootSet)) {
        const mem = new Set(effectiveMembers(sets, s.id));
        let hit = false;
        for (const id of picked) {
          if (mem.has(id)) {
            hit = true;
            break;
          }
        }
        if (hit) ids.push(s.id);
      }
    }
    return ids;
  }

  function setPickTab(tab: "set" | "link") {
    pickTab = tab;
    if (selectPanelSet) selectPanelSet.hidden = tab !== "set";
    if (selectPanelLink) selectPanelLink.hidden = tab !== "link";
    selectTabSet?.classList.toggle("on", tab === "set");
    selectTabLink?.classList.toggle("on", tab === "link");
  }

  function paintLinkSources() {
    if (!selectSources) return;
    selectSources.replaceChildren();
    if (!pickSource || !picked.has(pickSource)) pickSource = [...picked][0] || null;
    for (const id of picked) {
      const m = materials.find((x) => x.id === id);
      const lab = document.createElement("label");
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "kg-select-source";
      r.checked = pickSource === id;
      r.addEventListener("change", () => {
        pickSource = id;
      });
      lab.append(r, document.createTextNode(m ? m.id + " " + m.name : id));
      selectSources.append(lab);
    }
  }

  function placeSelectBar() {
    if (!selectBar || !picked.size || selectBarMoved) return;
    const path = floorG.select("g.kg-draft path").node() as SVGPathElement | null;
    let clientX = window.innerWidth / 2;
    let clientY = window.innerHeight / 2;
    if (path) {
      const b = path.getBoundingClientRect();
      if (b.width || b.height) {
        clientX = b.right;
        clientY = b.top;
      }
    }
    placePop(selectBar, { clientX, clientY });
  }

  function onPickedChanged() {
    const on = picked.size > 0;
    if (on && filterSnapshot === null) filterSnapshot = setFilter.slice();
    pickMode = on;
    if (!on) {
      drawArmed = false;
      pickSource = null;
      selectBarMoved = false;
      if (filterSnapshot) {
        setFilter = filterSnapshot.slice();
        filterSnapshot = null;
      }
      paintFacets();
      paintSearchHits();
      syncSelectBar();
      applyFocus();
      return;
    }
    setFilter = facetIdsForPicked();
    paintFacets();
    if (layoutMode !== "layers") setLayoutMode("layers");
    else refreshLayerFloors();
    paintSearchHits();
    applyFocus();
    syncSelectBar();
  }

  function togglePicked(id: string) {
    if (picked.has(id)) {
      picked.delete(id);
      onPickedChanged();
      return;
    }
    picked.add(id);
    onPickedChanged();
    setFocus(id);
  }

  function syncSelectBar() {
    if (selectBar) selectBar.hidden = !pickMode;
    if (selectCount) selectCount.textContent = picked.size + " selected";
    const list = document.getElementById("kg-select-picks");
    if (list) {
      list.replaceChildren();
      [...picked]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .forEach((id) => {
          const m = materials.find((x) => x.id === id);
          const row = document.createElement("div");
          row.className = "kg-select-pick";
          const drop = document.createElement("button");
          drop.type = "button";
          drop.className = "btn kg-select-drop";
          drop.title = "Unselect";
          drop.textContent = "-";
          drop.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            togglePicked(id);
          });
          const name = document.createElement("button");
          name.type = "button";
          name.className = "kg-select-name";
          name.textContent = m ? m.id + " " + m.name : id;
          name.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setFocus(id);
          });
          row.append(drop, name);
          list.append(row);
        });
    }
    if (pickMode) {
      paintLinkSources();
      setPickTab(pickTab);
      placeSelectBar();
      requestAnimationFrame(() => placeSelectBar());
    }
  }

  function setPickMode(on: boolean) {
    if (!on) {
      picked.clear();
      onPickedChanged();
      return;
    }
    pickMode = picked.size > 0;
    syncSelectBar();
    applyFocus();
  }

  selectTabSet?.addEventListener("click", () => setPickTab("set"));
  selectTabLink?.addEventListener("click", () => setPickTab("link"));
  selectBar?.addEventListener("mousedown", (ev) => ev.stopPropagation());
  selectBar?.addEventListener("click", (ev) => ev.stopPropagation());
  selectBar?.addEventListener("pointerdown", (ev) => {
    if (!selectBar || ev.button !== 0) return;
    const t = ev.target as Element | null;
    if (t && t.closest("button, input, textarea, select, label, a")) return;
    const r = selectBar.getBoundingClientRect();
    selectBarDrag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, pointer: ev.pointerId };
    selectBar.classList.add("kg-dragging");
    try {
      selectBar.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    ev.preventDefault();
  });
  function onSelectBarMove(ev: PointerEvent) {
    if (!selectBar || !selectBarDrag || ev.pointerId !== selectBarDrag.pointer) return;
    const w = selectBar.offsetWidth;
    const h = selectBar.offsetHeight;
    let left = ev.clientX - selectBarDrag.dx;
    let top = ev.clientY - selectBarDrag.dy;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    selectBar.style.left = Math.round(left) + "px";
    selectBar.style.top = Math.round(top) + "px";
    selectBarMoved = true;
  }
  function endSelectBarDrag(ev: PointerEvent) {
    if (!selectBarDrag || ev.pointerId !== selectBarDrag.pointer) return;
    selectBarDrag = null;
    selectBar?.classList.remove("kg-dragging");
  }
  selectBar?.addEventListener("pointermove", onSelectBarMove);
  selectBar?.addEventListener("pointerup", endSelectBarDrag);
  selectBar?.addEventListener("pointercancel", endSelectBarDrag);
  document.getElementById("kg-select-draw-from")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!pickSource) {
      opts.toast("Pick a source card");
      return;
    }
    focus = pickSource;
    focusedSet = null;
    drawArmed = true;
    nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").attr("class", (d) => nodeClass(d));
    const others = [...picked].filter((id) => id !== pickSource);
    if (others.length === 1) {
      openDrawPop(others[0]!);
      return;
    }
    opts.toast("Click another node to link");
  });
  document.getElementById("kg-select-clear")?.addEventListener("click", () => {
    picked.clear();
    onPickedChanged();
  });
  document.getElementById("kg-select-cancel")?.addEventListener("click", () => setPickMode(false));
  document.getElementById("kg-select-make")?.addEventListener("click", async () => {
    if (!opts.onCreateSet) return;
    if (picked.size < 2) {
      opts.toast("Pick at least two activities");
      return;
    }
    const name = (selectName?.value || "").trim();
    const members = [...picked];
    try {
      const created = await opts.onCreateSet({ name, members });
      if (selectName) selectName.value = "";
      setPickMode(false);
      if (created && created.id) setSetFocus(created.id);
    } catch (err) {
      opts.toast(err instanceof Error ? err.message : String(err));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (hitsEl && !hitsEl.hidden) {
        hitsEl.hidden = true;
        return;
      }
      hidePops();
      if (pickMode) {
        setPickMode(false);
        return;
      }
      setFocus(null);
      setSetFocus(null);
    }
  });

  if (unlinkedEl) {
    unlinkedEl.addEventListener("change", () => {
      showUnlinked = unlinkedEl.checked;
      (sim.force("ring") as ReturnType<typeof forceRadial>).strength((d) => ((d as SimNode).isolate && !showUnlinked ? 0.7 : 0));
      (sim.force("collide") as ReturnType<typeof forceCollide>).radius((d) => ((d as SimNode).isolate && !showUnlinked ? 10 : 28));
      if (!paused) {
        pinAll();
        sim.stop();
      }
      draw();
      applyFocus();
    });
  }

  if (nodeTip) {
    nodeTip.addEventListener("mouseenter", () => window.clearTimeout(tipHideT));
    nodeTip.addEventListener("mouseleave", () => {
      window.clearTimeout(tipHideT);
      tipHideT = window.setTimeout(() => hideNodeTip(), 220);
    });
    nodeTip.addEventListener("click", (ev) => ev.stopPropagation());
  }

  layoutLayersBtn?.addEventListener("click", () => {
    setLayoutMode(layoutMode === "layers" ? "draw" : "layers");
  });
  planeOneBtn?.addEventListener("click", () => {
    mergeFloors = true;
    syncLayoutButtons();
    ticked();
    saveKgView();
  });
  planeEachBtn?.addEventListener("click", () => {
    mergeFloors = false;
    syncLayoutButtons();
    ticked();
    saveKgView();
  });
  syncLayoutButtons();

  angleBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (layoutMode !== "layers") return;
    angleArmed = !angleArmed;
    if (!angleArmed) {
      dragging = false;
      floorG.classed("kg-no-anim", false);
    }
    syncAngleUi();
  });
  svg.on("contextmenu.angle", (ev) => {
    if (!angleArmed || layoutMode !== "layers") return;
    (ev as MouseEvent).preventDefault();
  });
  svg.on("mousedown.angle", (ev) => {
    const e = ev as MouseEvent;
    if (!angleArmed || layoutMode !== "layers") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 2) {
      const pt = pointer(e, svgNode);
      const z = zoomTransform(svgNode);
      const [lx, ly] = z.invert(pt);
      origin = unproject(lx, ly, 0, angle, origin.x, origin.y);
      ticked();
      paintFloors();
      syncAngleUi();
      saveKgView();
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    dragOrigin = { x: angle.yaw, y: angle.tilt, px: e.clientX, py: e.clientY, k: 1 };
    floorG.classed("kg-no-anim", true);
    syncAngleUi();
  });
  function onAngleMove(e: MouseEvent) {
    if (!angleArmed || !dragging || !svgNode.classList.contains("kg-angle-dragging")) return;
    angle = clampAngle({
      yaw: dragOrigin.x + (e.clientX - dragOrigin.px) * 0.4,
      tilt: dragOrigin.y + (e.clientY - dragOrigin.py) * 0.3,
    });
    ticked();
    paintFloors();
    syncAngleUi();
  }
  function endAngleDrag() {
    if (!angleArmed || !svgNode.classList.contains("kg-angle-dragging")) return;
    dragging = false;
    floorG.classed("kg-no-anim", false);
    syncAngleUi();
    paintRisers();
    saveKgView();
  }
  window.addEventListener("mousemove", onAngleMove);
  window.addEventListener("mouseup", endAngleDrag);

  hopsEl?.addEventListener("input", () => {
    if (hopsEl.value === "") return;
    const cap = maxHop(links);
    const n = Math.floor(Number(hopsEl.value));
    hopCount = Number.isFinite(n) ? Math.max(1, Math.min(cap, n)) : 1;
    hopsEl.value = String(hopCount);
    applyFocus();
  });
  hopsEl?.addEventListener("change", () => {
    const cap = maxHop(links);
    const n = Math.floor(Number(hopsEl.value));
    hopCount = Number.isFinite(n) ? Math.max(1, Math.min(cap, n)) : 1;
    hopsEl.value = String(hopCount);
    applyFocus();
  });
  hopsEl?.addEventListener("mousedown", (ev) => ev.stopPropagation());

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => runSearch(searchEl.value), 220);
    });
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch(searchEl.value);
      }
    });
    searchEl.addEventListener("focus", () => {
      if (searchEl.value.trim() && (lastKeyword.length || lastSemantic.length)) {
        paintSearchHits();
        placeHits();
      }
    });
  }

  function placeHits() {
    if (!hitsEl || !searchEl || hitsEl.hidden) return;
    const r = searchEl.getBoundingClientRect();
    hitsEl.style.left = Math.round(r.left) + "px";
    hitsEl.style.top = Math.round(r.bottom + 4) + "px";
    hitsEl.style.width = Math.round(r.width) + "px";
  }

  function paintHitGroup(title: string, hits: SearchHit[], emptyText: string) {
    if (!hitsEl) return;
    const g = document.createElement("div");
    g.className = "kg-hit-group";
    const lab = document.createElement("div");
    lab.className = "kg-hit-label";
    lab.textContent = title;
    g.append(lab);
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "mute";
      empty.textContent = emptyText;
      g.append(empty);
    } else {
      for (const h of hits) {
        const row = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = picked.has(h.id);
        cb.addEventListener("click", (ev) => ev.stopPropagation());
        cb.addEventListener("change", () => togglePicked(h.id));
        row.addEventListener("click", (ev) => {
          if (ev.target === cb) return;
          ev.preventDefault();
          if (!picked.has(h.id)) {
            cb.checked = true;
            togglePicked(h.id);
          } else setFocus(h.id);
        });
        row.append(cb, document.createTextNode((h.name || h.id) + " · " + h.id));
        g.append(row);
      }
    }
    hitsEl.append(g);
  }

  function paintSearchHits() {
    if (!hitsEl) return;
    const hasQ = !!(searchEl && searchEl.value.trim());
    if (!hasQ) {
      hitsEl.hidden = true;
      return;
    }
    hitsEl.hidden = false;
    hitsEl.replaceChildren();
    paintHitGroup("Match by keyword", lastKeyword, "No name/cue/notes/set match");
    paintHitGroup("Match by semantic", lastSemantic, "No semantic matches");
    placeHits();
  }

  async function runSearch(q: string) {
    if (!opts.onSearch) return;
    const needle = q.trim();
    if (!needle) {
      lastKeyword = [];
      lastSemantic = [];
      if (hitsEl) hitsEl.hidden = true;
      return;
    }
    const res = await opts.onSearch(needle);
    lastKeyword = res.keyword || [];
    lastSemantic = res.semantic || [];
    paintSearchHits();
  }

  document.addEventListener("mousedown", (e) => {
    if (!hitsEl || hitsEl.hidden) return;
    const t = e.target as Node;
    if (hitsEl.contains(t) || searchEl?.contains(t)) return;
    hitsEl.hidden = true;
  });

  if (drawPop) {
    const kind = drawPop.querySelector("#kg-draw-kind") as HTMLSelectElement | null;
    const noteEl = drawPop.querySelector("#kg-draw-note") as HTMLInputElement | null;
    kind?.addEventListener("change", () => {
      const related = kind.value === "related";
      if (noteEl) noteEl.placeholder = related ? "e.g. Legs or Legs: why this pile" : "Why this hop";
    });
    drawPop.querySelector("#kg-draw-cancel")?.addEventListener("click", () => hidePops());
    drawPop.querySelector("#kg-draw-ok")?.addEventListener("click", async () => {
      const from = (drawPop.querySelector("[name=from]") as HTMLInputElement).value;
      const to = (drawPop.querySelector("[name=to]") as HTMLInputElement).value;
      const k = (kind?.value || "related") as LinkKind;
      const raw = (noteEl?.value || "").trim();
      const L: Link = { from, kind: k, to, note: "" };
      if (k === "related") {
        if (!raw) {
          opts.toast("Related to needs a tag");
          return;
        }
        if (raw.includes(":")) {
          const [tag, ...rest] = raw.split(":");
          L.tag = tag.trim();
          L.note = rest.join(":").trim();
          if (!L.tag) {
            opts.toast("Related to needs a tag");
            return;
          }
        } else L.tag = raw;
      } else L.note = raw;
      await opts.onCreateLink(L);
      hidePops();
    });
  }

  edgePop?.querySelector("#kg-edge-close")?.addEventListener("click", () => hidePops());

  function layoutPendingCluster() {
    const pending = simNodes.filter((n) => n.pending && n.x != null && n.y != null);
    const unplaced = simNodes.filter((n) => n.pending && (n.x == null || n.y == null));
    const all = pending.concat(unplaced);
    if (!all.length) return;
    const { w, h } = size();
    const vertical = h > w * 1.1;
    const cols = vertical ? 1 : Math.min(3, all.length);
    const rows = Math.ceil(all.length / cols);
    const scale = all.length <= 2 ? 1.85 : 1.5;
    const roomY = h / scale - 28;
    const gapY = rows > 1 ? Math.min(108, Math.max(76, (roomY - 64) / rows)) : 0;
    const gapX = cols > 1 ? Math.min(190, (w / scale - 48) / cols) : 0;
    all.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      n.x = (col - (cols - 1) / 2) * gapX;
      n.y = (row - (rows - 1) / 2) * gapY;
      n.fx = n.x;
      n.fy = n.y;
    });
    const floors = floorsByNode();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of all) {
      const p = xyAt(n, floors);
      const half = Math.max(48, Math.min(110, 8 + (n.name || n.id).length * 3.1));
      minX = Math.min(minX, p.x - half);
      maxX = Math.max(maxX, p.x + half);
      minY = Math.min(minY, p.y - 28);
      maxY = Math.max(maxY, p.y + 54);
    }
    const bw = Math.max(90, maxX - minX);
    const bh = Math.max(80, maxY - minY);
    const fitted = 0.9 * Math.min(w / bw, h / bh);
    const scaleUsed = Math.min(scale, Math.max(1.2, fitted));
    const tx = w / 2 - scaleUsed * ((minX + maxX) / 2);
    const ty = h / 2 - scaleUsed * ((minY + maxY) / 2);
    svg.call(zoomer.transform, zoomIdentity.translate(tx, ty).scale(scaleUsed));
  }

  function fit(id?: string) {
    const { w, h } = size();
    if (id) {
      const n = byId.get(id);
      if (n && n.x != null && n.y != null) {
        const p = xyAt(n, floorsByNode());
        const scale = 2.4;
        const tx = w / 2 - scale * p.x;
        const ty = h / 2 - scale * p.y;
        svg.call(zoomer.transform, zoomIdentity.translate(tx, ty).scale(scale));
        saveKgView();
      }
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      if (!showUnlinked && n.isolate && !focus) continue;
      const p = xyAt(n, floorsByNode());
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (layoutMode === "layers" && sets.length) {
      const tickedIds = new Set(floorSets);
      const plan = currentPlan();
      for (const s of sets) {
        const floor = plan.get(s.id) ?? 1;
        const parked = !tickedIds.has(s.id);
        for (const id of effectiveMembers(sets, s.id)) {
          const n = byId.get(id);
          if (!n || n.x == null || n.y == null) continue;
          const p = proj(n.x, n.y, floor);
          const x = p.x + (parked ? PARK_FLOOR_DX : 0);
          minX = Math.min(minX, x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (!Number.isFinite(minX)) {
      svg.call(zoomer.transform, zoomIdentity);
      return;
    }
    const bw = Math.max(40, maxX - minX);
    const bh = Math.max(40, maxY - minY);
    const scale = Math.min(2.4, 0.86 * Math.min(w / bw, h / bh));
    const tx = w / 2 - scale * (minX + bw / 2);
    const ty = h / 2 - scale * (minY + bh / 2);
    svg.call(zoomer.transform, zoomIdentity.translate(tx, ty).scale(scale));
    saveKgView();
  }

  function spreadOnFloors() {
    if (layoutMode !== "layers" || spreading) return;
    seedFloorSets();
    const floors = floorsByNode();
    const groups = new Map<number, SimNode[]>();
    for (const n of simNodes) {
      if (n.x == null || n.y == null) continue;
      const f = floors.get(n.id) ?? 0;
      if (f <= 0) continue;
      const g = groups.get(f);
      if (g) g.push(n);
      else groups.set(f, [n]);
    }
    const elById = new Map<string, SVGGElement>();
    nodeG.selectAll<SVGGElement, SimNode>("g.kg-node").each(function (d) {
      elById.set(d.id, this);
    });
    const labelW = new Map<string, number>();
    labelG.selectAll<SVGTextElement, SimLink>("text").each(function (d) {
      try {
        const b = this.getBBox();
        if (b.width) labelW.set(idOf(d.source) + "|" + idOf(d.target), b.width);
      } catch {
        /* empty label */
      }
    });
    const from: { n: SimNode; x: number; y: number }[] = [];
    const to: { x: number; y: number }[] = [];
    for (const [floor, members] of groups) {
      if (members.length < 2) continue;
      const ids = new Set(members.map((n) => n.id));
      const edgeHalo = new Map<string, number>();
      for (const e of simLinks) {
        const a = idOf(e.source);
        const b = idOf(e.target);
        if (!ids.has(a) || !ids.has(b)) continue;
        const kind = e.kinds.includes("progression")
          ? "progression"
          : e.kinds.includes("regression")
            ? "regression"
            : "related";
        const extra = [e.tags[0], e.notes[0]].filter(Boolean).join(" · ");
        const w = labelW.get(a + "|" + b) || 6.2 * Math.max(kind.length, extra.length, 1);
        const share = 10 + w / 4;
        edgeHalo.set(a, Math.max(edgeHalo.get(a) ?? 0, share));
        edgeHalo.set(b, Math.max(edgeHalo.get(b) ?? 0, share));
      }
      const pack = members.map((n) => {
        const p = proj(n.x as number, n.y as number, floor);
        let halo = 22;
        const el = elById.get(n.id);
        if (el) {
          try {
            const b = el.getBBox();
            if (b.width || b.height) halo = Math.max(22, b.width / 2, b.height / 2);
          } catch {
            /* estimate below */
          }
        }
        halo = Math.max(halo, edgeHalo.get(n.id) ?? 0) + 4;
        return { x: p.x, y: p.y, r: halo };
      });
      pushApart(pack, 32, 80);
      members.forEach((n, i) => {
        from.push({ n, x: n.x as number, y: n.y as number });
        const q = unproject(pack[i].x, pack[i].y, floor, angle, origin.x, origin.y);
        to.push(q);
      });
    }
    if (!from.length) return;
    spreading = true;
    floorG.classed("kg-no-anim", true);
    plateBoxes = new Map();
    plateBoxKey = "";
    const dur = 420;
    const t0 = performance.now();
    const ease = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u);
    const step = (now: number) => {
      const u = ease(Math.min(1, (now - t0) / dur));
      for (let i = 0; i < from.length; i++) {
        const s = from[i];
        s.n.x = s.x + (to[i].x - s.x) * u;
        s.n.y = s.y + (to[i].y - s.y) * u;
      }
      pinAll();
      ticked();
      if (u < 1) {
        requestAnimationFrame(step);
        return;
      }
      spreading = false;
      floorG.classed("kg-no-anim", false);
      saveKgView();
    };
    requestAnimationFrame(step);
  }

  function zoomBy(factor: number) {
    const { w, h } = size();
    svg.call(zoomer.scaleBy, factor, [w / 2, h / 2]);
  }

  document.getElementById("kg-zoom-in")?.addEventListener("click", () => zoomBy(1.28));
  document.getElementById("kg-zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.28));
  document.getElementById("kg-zoom-fit")?.addEventListener("click", () => fit());
  spreadBtn?.addEventListener("click", spreadOnFloors);

  window.addEventListener("resize", () => {
    size();
  });
  window.addEventListener("beforeunload", () => {
    saveKgView();
  });

  function update(nextMaterials: Material[], nextLinks: Link[], nextSets: MaterialSet[] = [], nextPending: PendingOp[] = []) {
    materials = nextMaterials;
    links = nextLinks;
    sets = nextSets;
    pendingOps = nextPending || [];
    floorSets = floorSets.filter((id) => sets.some((s) => s.id === id));
    setFilter = setFilter.filter((id) => sets.some((s) => s.id === id));
    normalizeSetFilter();
    model = buildModel(materials, links, sets, pendingOps);
    const pendingIds = new Set(pendingOps.filter((op) => op.status !== "discarded" && op.tempId).map((op) => String(op.tempId)));
    if (focus && !materials.some((m) => m.id === focus) && !pendingIds.has(focus)) focus = null;
    if (focusedSet && !sets.some((s) => s.id === focusedSet)) focusedSet = null;
    syncHopsInput();
    paintFacets();
    rebuildSim();
  }

  function restoreCamera() {
    try {
      const raw = JSON.parse(localStorage.getItem(KG_VIEW_KEY) || "");
      const z = raw && raw.zoom;
      if (z && typeof z.k === "number") {
        svg.call(zoomer.transform, zoomIdentity.translate(Number(z.x) || 0, Number(z.y) || 0).scale(z.k));
        return;
      }
    } catch {
      /* keep current camera */
    }
    if (savedZoom) svg.call(zoomer.transform, zoomIdentity.translate(savedZoom.x, savedZoom.y).scale(savedZoom.k));
  }

  size();

  function getPositions(): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of simNodes) {
      if (typeof n.x === "number" && typeof n.y === "number") out[n.id] = { x: n.x, y: n.y };
    }
    return out;
  }

  return {
    update,
    setFocus,
    getFocus: () => focus,
    getPositions,
    fit,
    restoreCamera,
    pause() {
      paused = true;
      sim.stop();
    },
  };
}
