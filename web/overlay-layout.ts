export type DockSide = "left" | "right";

export function dockBeside(opts: {
  mainLeft: number;
  mainWidth: number;
  flyWidth: number;
  viewport: number;
  side: DockSide;
  gap?: number;
  margin?: number;
}): { mainLeft: number; flyLeft: number } {
  const gap = opts.gap ?? 10;
  const margin = opts.margin ?? 12;
  const dw = opts.mainWidth;
  const fw = opts.flyWidth;
  const vw = opts.viewport;
  let mainLeft = opts.mainLeft;

  if (opts.side === "left") {
    let flyLeft = mainLeft - fw - gap;
    if (flyLeft < margin) {
      flyLeft = margin;
      mainLeft = margin + fw + gap;
    }
    if (mainLeft + dw > vw - margin) {
      flyLeft = margin;
      mainLeft = Math.min(margin + fw + gap, Math.max(margin, vw - margin - dw));
    }
    return { mainLeft, flyLeft };
  }

  let flyLeft = mainLeft + dw + gap;
  if (flyLeft + fw > vw - margin) {
    mainLeft = Math.max(margin, vw - margin - fw - gap - dw);
    flyLeft = mainLeft + dw + gap;
  }
  if (flyLeft + fw > vw - margin) {
    flyLeft = Math.max(margin, vw - margin - fw);
    mainLeft = Math.max(margin, flyLeft - gap - dw);
  }
  return { mainLeft, flyLeft };
}
