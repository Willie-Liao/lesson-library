import { CHAIN_COL_GAP, DEFAULT_ANGLE, FLOOR_GAP, chainLayout, clampAngle, floorPlan, project, pushApart, unproject } from "../web/graph-layout.ts";
import type { Link } from "../web/types.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function pos(layout: ReturnType<typeof chainLayout>, id: string) {
  const p = layout.get(id);
  if (!p) throw new Error("missing " + id);
  return p;
}

const throwChain: Link[] = [
  { from: "M1", kind: "progression", to: "M2", note: "" },
  { from: "M2", kind: "progression", to: "M3", note: "" },
];
const relatedOnly: Link[] = [{ from: "M4", kind: "related", to: "M2", note: "", tag: "throw and catch" }];

{
  const layout = chainLayout(["M1", "M2", "M3"], throwChain);
  assert(pos(layout, "M1").rank === 0, "M1 rank 0");
  assert(pos(layout, "M2").rank === 1, "M2 rank 1");
  assert(pos(layout, "M3").rank === 2, "M3 rank 2");
  assert(pos(layout, "M1").x === 0, "M1 x");
  assert(pos(layout, "M2").x === CHAIN_COL_GAP, "M2 x");
  assert(pos(layout, "M3").x === CHAIN_COL_GAP * 2, "M3 x");
}

{
  const uneven: Link[] = [
    { from: "M1", kind: "progression", to: "M2", note: "", leap: 0.1 },
    { from: "M2", kind: "progression", to: "M3", note: "", leap: 0.5 },
  ];
  const layout = chainLayout(["M1", "M2", "M3"], uneven);
  const g12 = pos(layout, "M2").x - pos(layout, "M1").x;
  const g23 = pos(layout, "M3").x - pos(layout, "M2").x;
  assert(Math.abs(g12 - CHAIN_COL_GAP * 0.1) < 1e-9, "0.1 hop is 0.1 column");
  assert(Math.abs(g23 - CHAIN_COL_GAP * 0.5) < 1e-9, "0.5 hop is 0.5 column");
  assert(g12 !== g23, "uneven leaps yield unequal x gaps");
}

{
  const layout = chainLayout(["M1", "M2", "M3", "M4"], [...throwChain, ...relatedOnly]);
  assert(pos(layout, "M4").rank === null, "related-only neighbour is gutter");
  assert(pos(layout, "M4").x === -CHAIN_COL_GAP, "gutter x");
  assert(pos(layout, "M2").rank === 1, "chain ranks unchanged by related");
}

{
  const routes: Link[] = [
    { from: "M61", kind: "progression", to: "M45", note: "" },
    { from: "M45", kind: "progression", to: "M32", note: "" },
  ];
  const layout = chainLayout(["M1", "M2", "M3", "M61", "M45", "M32"], [...throwChain, ...routes]);
  assert(pos(layout, "M61").rank === 0 && pos(layout, "M45").rank === 1 && pos(layout, "M32").rank === 2, "route chain ranks");
  assert(pos(layout, "M1").y !== pos(layout, "M61").y, "separate components do not share a y");
}

{
  const cycle: Link[] = [
    { from: "A", kind: "progression", to: "B", note: "" },
    { from: "B", kind: "progression", to: "A", note: "" },
  ];
  const layout = chainLayout(["A", "B"], cycle);
  const ra = pos(layout, "A").rank;
  const rb = pos(layout, "B").rank;
  assert(ra !== null && rb !== null, "cycle ranks are finite");
  assert(Number.isFinite(ra) && Number.isFinite(rb), "cycle ranks are numbers");
}

{
  const layout = chainLayout(["M84"], []);
  assert(pos(layout, "M84").rank === null, "isolate is gutter");
  assert(pos(layout, "M84").x === -CHAIN_COL_GAP, "isolate gutter x");
}

{
  const regress: Link[] = [{ from: "M1", kind: "regression", to: "M2", note: "" }];
  const layout = chainLayout(["M1", "M2"], regress);
  assert(pos(layout, "M1").rank === 0 && pos(layout, "M2").rank === 1, "regression from=easier to=harder");
}

{
  const p = project(10, 0, 0, { yaw: 0, tilt: 0 });
  assert(Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9, "az 0 el 0 maps +X off screen-x (looks along X)");
}

{
  const a = { yaw: 0, tilt: 0 };
  const y0 = project(5, 7, 0, a).y;
  const y3 = project(5, 7, 3, a).y;
  assert(Math.abs(y3 - (y0 - 3 * FLOOR_GAP)) < 1e-9, "el 0 lifts floors straight up in SVG y");
}

{
  const p = project(0, 0, 1, { yaw: 90, tilt: 45 });
  const zterm = FLOOR_GAP * Math.cos(Math.PI / 4);
  assert(Math.abs(p.y + zterm) < 1e-9, "floor 1 at side 45 goes up the screen");
}

{
  const a = DEFAULT_ANGLE;
  const xPt = project(1, 0, 0, a);
  const yPt = project(0, 1, 0, a);
  assert(Math.abs(xPt.x + 1) < 1e-9 && Math.abs(xPt.y) < 1e-9, "side 45: +X runs across screen");
  assert(Math.abs(yPt.x) < 1e-9 && Math.abs(yPt.y - Math.sin(Math.PI / 4)) < 1e-9, "side 45: +Y recedes on screen y");
  assert(Math.abs(xPt.x - yPt.x) > 0.5, "side 45 is not a uniform top-down squash");
}

{
  const a = { yaw: 90, tilt: 45 };
  const ox = 4,
    oy = -3;
  const src = { x: 12, y: -8, f: 2 };
  const p = project(src.x, src.y, src.f, a, ox, oy);
  const q = unproject(p.x, p.y, src.f, a, ox, oy);
  assert(Math.abs(q.x - src.x) < 1e-6 && Math.abs(q.y - src.y) < 1e-6, "unproject(project(p)) ≈ p");
}

{
  const p = project(1, 0, 0, { yaw: 90, tilt: 45 });
  assert(Math.abs(p.x + 1) < 1e-9, "yaw 90 maps (1,0) to x≈-1");
}

{
  const c = clampAngle({ yaw: -30, tilt: 120 });
  assert(c.yaw === 330 && c.tilt === 80, "clampAngle wraps yaw and caps tilt");
}

{
  const split = floorPlan(["a", "b"], ["a", "b", "c"], false);
  assert(split.get("a") === 1 && split.get("b") === 2 && split.get("c") === 0, "separate floors park below");
  const merged = floorPlan(["a", "b"], ["a", "b", "c"], true);
  assert(merged.get("a") === 1 && merged.get("b") === 1 && merged.get("c") === 0, "merge ticked onto floor 1 park 0");
  const later = floorPlan(["throw", "catch"], ["throw", "catch", "snap"], false);
  assert(later.get("throw") === 1 && later.get("catch") === 2 && later.get("snap") === 0, "last ticked highest");
}

{
  const glued = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  pushApart(glued, 56);
  const d = Math.hypot(glued[0].x - glued[1].x, glued[0].y - glued[1].y);
  assert(d >= 56 - 1e-6, "glued pair splits to minDist");
  const far = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ];
  pushApart(far, 56);
  assert(far[0].x === 0 && far[0].y === 0 && far[1].x === 200 && far[1].y === 0, "far pair stays put");
  const tagged = [
    { x: 0, y: 0, r: 70 },
    { x: 0, y: 0, r: 70 },
  ];
  pushApart(tagged, 56);
  const td = Math.hypot(tagged[0].x - tagged[1].x, tagged[0].y - tagged[1].y);
  assert(td >= 140 - 1e-6, "halos add: pair gap is r+r");
  const stacked = [
    { x: 0, y: 0 },
    { x: 0, y: 8 },
  ];
  pushApart(stacked, 56, 40, { sideX: 1, sideY: 0, depthScale: 0.08 });
  const sideGap = Math.abs(stacked[0].x - stacked[1].x);
  const depthGap = Math.abs(stacked[0].y - stacked[1].y);
  assert(sideGap >= 56 - 1, "low tilt unsticks along sideways axis");
  assert(depthGap < 20, "low tilt does not explode receding axis");
}

console.log("graph-layout tests ok");
