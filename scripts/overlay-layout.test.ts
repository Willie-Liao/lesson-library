import { dockBeside } from "../web/overlay-layout.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const left = dockBeside({
  mainLeft: 24,
  mainWidth: 400,
  flyWidth: 400,
  viewport: 1200,
  side: "left",
});
assert(left.flyLeft === 12, "easier sits at the left margin");
assert(left.mainLeft === 12 + 400 + 10, "main panel shifts right of easier");
assert(left.flyLeft + 400 + 10 === left.mainLeft, "easier docks flush left of main");

const right = dockBeside({
  mainLeft: 24,
  mainWidth: 400,
  flyWidth: 400,
  viewport: 1200,
  side: "right",
});
assert(right.mainLeft === 24, "main stays when there is room on the right");
assert(right.flyLeft === 24 + 400 + 10, "harder docks flush right of main");

console.log("overlay-layout tests ok");
