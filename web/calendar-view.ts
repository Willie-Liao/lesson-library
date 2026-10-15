import {
  assignOverlapLanes,
  buildMonthCells,
  cloneCalendar,
  createFocusEntry,
  createSchoolActivityEntry,
  createWorkdayEntry,
  emptyCalendar,
  hydrateCalendar,
  normalizeRange,
  splitRangesByWeek,
  validateCalendar,
  type CalendarLessonChip,
} from "./calendar-model";
import type { CalendarData, CalendarEntry, CalendarFocusDefinition, Grade } from "./types";

export type CalendarMode = "navigate" | "focus" | "workday" | "schoolActivity";

export type CalendarViewOptions = {
  root: HTMLElement;
  getGrade: () => Grade;
  load: () => Promise<CalendarData>;
  save: (data: CalendarData) => Promise<CalendarData>;
  onOpenDate: (iso: string) => void;
  loadLessons?: () => Promise<Record<string, CalendarLessonChip[]>>;
  editable?: boolean;
};

const PRESET = ["#3B82F6", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6", "#0EA5E9"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "") continue;
    node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function newDefId(): string {
  return "focus-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function createCalendarView(opts: CalendarViewOptions) {
  const root = opts.root;
  const editable = opts.editable !== false;
  root.classList.toggle("cal-readonly", !editable);
  const grid = root.querySelector(".cal-grid") as HTMLElement;
  const palette = root.querySelector(".cal-palette") as HTMLElement;
  const editor = root.querySelector(".cal-editor") as HTMLElement;
  const errorEl = root.querySelector(".cal-error") as HTMLElement;
  const title = root.querySelector(".cal-title") as HTMLElement;

  let data: CalendarData = emptyCalendar();
  let lastConfirmed: CalendarData = emptyCalendar();
  let year = new Date().getFullYear();
  let month = new Date().getMonth();
  let mode: CalendarMode = "navigate";
  let selectedTagId = "";
  let selectedEntryId = "";
  let error = "";
  let drag: { start: string; end: string } | null = null;
  let saveChain: Promise<void> = Promise.resolve();
  let loaded = false;
  let lessons: Record<string, CalendarLessonChip[]> = {};
  const drafts = {
    focus: { label: "", color: PRESET[0] },
    workday: { label: "", color: "#111827" },
    schoolActivity: { label: "", color: "#6B7280" },
  };

  function setError(msg: string) {
    error = msg;
    errorEl.hidden = !msg;
    errorEl.textContent = msg;
  }

  function visibleEntries(): CalendarEntry[] {
    const grade = opts.getGrade();
    return data.entries.filter((e) => e.scope === "all" || e.scope === grade);
  }

  function mutate(next: CalendarData) {
    const check = validateCalendar(next);
    if (!check.ok) {
      setError(check.message);
      render();
      return;
    }
    data = next;
    setError("");
    render();
    const snapshot = cloneCalendar(next);
    saveChain = saveChain.then(async () => {
      try {
        const saved = hydrateCalendar(await opts.save(snapshot));
        const mergeDefs = (local: CalendarFocusDefinition[], remote: CalendarFocusDefinition[]) => {
          const map = new Map(remote.map((d) => [d.id, d]));
          for (const d of local) map.set(d.id, d);
          return [...map.values()];
        };
        lastConfirmed = cloneCalendar({
          ...saved,
          foci: mergeDefs(snapshot.foci, saved.foci),
          workdays: mergeDefs(snapshot.workdays, saved.workdays),
          schoolActivities: mergeDefs(snapshot.schoolActivities, saved.schoolActivities),
        });
        data = cloneCalendar(lastConfirmed);
        setError("");
      } catch (err) {
        data = cloneCalendar(lastConfirmed);
        setError(err instanceof Error ? err.message : String(err));
      }
      render();
    });
  }

  function paintPalette() {
    palette.replaceChildren();
    palette.hidden = !editable || mode === "navigate";
    if (!editable || mode === "navigate") return;
    const noun = mode === "focus" ? "focus" : mode === "workday" ? "work day" : "school activity";
    const list = (mode === "focus" ? data.foci : mode === "workday" ? data.workdays : data.schoolActivities) || [];
    const draft = drafts[mode];
    list.forEach((f) => {
      const btn = el("button", { type: "button", class: "cal-swatch" + (f.id === selectedTagId ? " on" : "") });
      btn.append(el("i", { style: "background:" + f.color }), document.createTextNode(f.label));
      const x = el("span", { class: "cal-tag-x", title: "Delete " + noun, role: "button" }, "×");
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete “" + f.label + "”? This removes all of its date ranges.")) return;
        const next = cloneCalendar(data);
        if (mode === "focus") {
          next.foci = next.foci.filter((row) => row.id !== f.id);
          next.entries = next.entries.filter((row) => !(row.kind === "focus" && row.focusId === f.id));
        } else if (mode === "workday") {
          next.workdays = next.workdays.filter((row) => row.id !== f.id);
          next.entries = next.entries.filter((row) => !(row.kind === "workday" && row.tagId === f.id));
        } else {
          next.schoolActivities = next.schoolActivities.filter((row) => row.id !== f.id);
          next.entries = next.entries.filter((row) => !(row.kind === "schoolActivity" && row.tagId === f.id));
        }
        if (selectedTagId === f.id) selectedTagId = "";
        mutate(next);
      });
      btn.append(x);
      btn.addEventListener("click", () => {
        selectedTagId = f.id;
        selectedEntryId = "";
        render();
      });
      palette.append(btn);
    });
    const name = el("input", { type: "text", placeholder: "New " + noun + " label", id: "cal-new-label" });
    name.value = draft.label;
    name.addEventListener("input", () => { draft.label = name.value; });
    const color = el("input", { type: "color", value: draft.color, id: "cal-new-color" });
    color.addEventListener("input", () => { draft.color = color.value; });
    const add = el("button", { type: "button", class: "btn solid" }, "Add " + noun);
    const addTag = () => {
      const fallback = mode === "workday" ? "Work day" : mode === "schoolActivity" ? "School activity" : "";
      const label = name.value.trim() || fallback;
      const hex = /^#[0-9A-Fa-f]{6}$/.test(color.value) ? color.value : draft.color;
      if (!label) { setError(noun + " label required"); return; }
      if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) { setError("color must be #RRGGBB"); return; }
      const def: CalendarFocusDefinition = {
        id: (mode === "focus" ? "focus" : mode === "workday" ? "workday" : "school") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        label,
        color: hex,
      };
      const next = cloneCalendar(data);
      if (mode === "focus") next.foci.push(def);
      else if (mode === "workday") next.workdays.push(def);
      else next.schoolActivities.push(def);
      selectedTagId = def.id;
      draft.label = "";
      draft.color = PRESET[(list.length + 1) % PRESET.length];
      mutate(next);
    };
    add.addEventListener("click", (ev) => { ev.stopPropagation(); addTag(); });
    name.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); addTag(); }
    });
    palette.append(name, color, add);
    if (!selectedTagId) return;
    const cur = list.find((f) => f.id === selectedTagId);
    if (!cur) return;
    const rename = el("input", { type: "text", value: cur.label });
    const recolor = el("input", { type: "color", value: cur.color });
    recolor.addEventListener("change", () => {
      if (!/^#[0-9A-Fa-f]{6}$/.test(recolor.value)) return;
      const next = cloneCalendar(data);
      const bucket = mode === "focus" ? next.foci : mode === "workday" ? next.workdays : next.schoolActivities;
      const f = bucket.find((x) => x.id === selectedTagId);
      if (!f) return;
      f.color = recolor.value;
      next.entries.forEach((e) => {
        if ((e.kind === "workday" || e.kind === "schoolActivity") && e.tagId === selectedTagId) e.color = f.color;
      });
      mutate(next);
    });
    const saveDef = el("button", { type: "button", class: "btn" }, "Update " + noun);
    saveDef.addEventListener("click", () => {
      const next = cloneCalendar(data);
      const bucket = mode === "focus" ? next.foci : mode === "workday" ? next.workdays : next.schoolActivities;
      const f = bucket.find((x) => x.id === selectedTagId);
      if (!f) return;
      f.label = rename.value.trim();
      f.color = recolor.value;
      next.entries.forEach((e) => {
        if ((e.kind === "workday" || e.kind === "schoolActivity") && e.tagId === selectedTagId) {
          e.label = f.label;
          e.color = f.color;
        }
      });
      mutate(next);
    });
    palette.append(rename, recolor, saveDef);
  }

  function paintEditor() {
    editor.replaceChildren();
    editor.hidden = !editable || mode === "navigate";
    if (!editable || mode === "navigate") return;
    const entry = data.entries.find((e) => e.id === selectedEntryId);
    if (!entry) return;
    const start = el("input", { type: "date", value: entry.startDate });
    const end = el("input", { type: "date", value: entry.endDate });
    const saveBtn = el("button", { type: "button", class: "btn solid" }, "Save entry");
    saveBtn.addEventListener("click", () => {
      const next = cloneCalendar(data);
      const cur = next.entries.find((e) => e.id === entry.id);
      if (!cur) return;
      const range = normalizeRange(start.value, end.value);
      cur.startDate = range.startDate;
      cur.endDate = range.endDate;
      mutate(next);
    });
    const del = el("button", { type: "button", class: "btn danger" }, "Delete entry");
    del.addEventListener("click", () => {
      const next = cloneCalendar(data);
      next.entries = next.entries.filter((e) => e.id !== entry.id);
      selectedEntryId = "";
      mutate(next);
    });
    const sLab = el("label", {}, "Start"); sLab.append(start);
    const eLab = el("label", {}, "End"); eLab.append(end);
    editor.append(sLab, eLab);
    editor.append(saveBtn, del);
  }

  function commitRange(start: string, end: string) {
    const grade = opts.getGrade();
    try {
      const next = cloneCalendar(data);
      if (mode === "focus") {
        next.entries.push(createFocusEntry(data, selectedTagId, start, end, grade));
      } else if (mode === "workday") {
        next.entries.push(createWorkdayEntry(data, selectedTagId, start, end));
      } else if (mode === "schoolActivity") {
        next.entries.push(createSchoolActivityEntry(data, selectedTagId, start, end));
      }
      mutate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function isoFromEvent(e: Event): string | null {
    const pe = e as PointerEvent;
    if (typeof pe.clientX === "number" && typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(pe.clientX, pe.clientY);
      for (const n of stack) {
        if (!(n instanceof HTMLElement) || !root.contains(n)) continue;
        const day = n.closest("[data-iso]") as HTMLElement | null;
        if (day && root.contains(day)) return day.dataset.iso || null;
      }
      return null;
    }
    const t = e.target as HTMLElement | null;
    const day = t && t.closest ? t.closest("[data-iso]") as HTMLElement | null : null;
    return day && root.contains(day) ? day.dataset.iso || null : null;
  }

  function paintGrid() {
    const first = new Date(year, month, 1);
    title.textContent = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const cells = buildMonthCells(year, month);
    const entries = visibleEntries();
    const rangeEntries = entries;
    const lanes = assignOverlapLanes(rangeEntries);
    const preview = drag ? normalizeRange(drag.start, drag.end) : null;
    const inPreview = (iso: string) => preview && iso >= preview.startDate && iso <= preview.endDate;
    const classDays = ((data.classDays || {})[opts.getGrade()] || []);
    grid.replaceChildren();
    for (let w = 0; w < 6; w++) {
      const week = el("div", { class: "cal-week" });
      const daysRow = el("div", { class: "cal-week-days" });
      const weekCells = cells.slice(w * 7, w * 7 + 7);
      weekCells.forEach((c) => {
        const isoDow = c.dow === 0 ? 7 : c.dow;
        const isClass = editable && classDays.indexOf(isoDow) >= 0;
        const isOff = isClass && entries.some((e) => (e.kind === "workday" || e.kind === "schoolActivity") && e.startDate <= c.iso && c.iso <= e.endDate);
        const day = el("div", {
          class: "cal-day" + (c.inMonth ? "" : " out") + (inPreview(c.iso) ? " in-range" : "") + ((lessons[c.iso] || []).length ? " has-lesson" : "") + (isClass ? " class-day" : "") + (isOff ? " cal-off" : ""),
          "data-iso": c.iso,
          role: "button",
          tabindex: "0",
          "aria-label": c.iso,
        });
        day.append(el("div", { class: "num" }, String(Number(c.iso.slice(8)))));
        const chips = lessons[c.iso] || [];
        const stack = el("div", { class: "cal-day-stack" });
        if (chips.length) {
          const box = el("div", { class: "cal-lessons" });
          chips.forEach((ch) => {
            const line = el(
              "div",
              { class: "cal-lesson", title: ch.name + (ch.extra ? " +" + ch.extra : "") },
              ch.name + (ch.extra ? " +" + ch.extra : ""),
            );
            box.append(line);
          });
          stack.append(box);
        }
        day.append(stack);
        daysRow.append(day);
      });
      week.append(daysRow);
      const laneLayer = el("div", { class: "cal-lanes" });
      const weekStart = weekCells[0].iso;
      const weekEnd = weekCells[6].iso;
      rangeEntries.forEach((entry) => {
        splitRangesByWeek(entry).forEach((seg) => {
          if (seg.endDate < weekStart || seg.startDate > weekEnd) return;
          const s = seg.startDate < weekStart ? weekStart : seg.startDate;
          const e = seg.endDate > weekEnd ? weekEnd : seg.endDate;
          const si = weekCells.findIndex((c) => c.iso === s);
          const ei = weekCells.findIndex((c) => c.iso === e);
          if (si < 0 || ei < 0) return;
          const def = entry.kind === "focus" ? data.foci.find((f) => f.id === entry.focusId) : null;
          const color = entry.kind === "focus" ? (def ? def.color : "#111827") : entry.color;
          const label = entry.kind === "focus" ? (def ? def.label : entry.focusId) : entry.label;
          const bar = el("button", { type: "button", class: "cal-bar", "data-entry": entry.id });
          bar.append(el("span", { class: "cal-bar-label" }, label));
          if (editable) {
            const x = el("span", { class: "cal-tag-x", title: "Delete", role: "button" }, "×");
            x.addEventListener("click", (ev) => {
              ev.stopPropagation();
              const next = cloneCalendar(data);
              next.entries = next.entries.filter((row) => row.id !== entry.id);
              if (selectedEntryId === entry.id) selectedEntryId = "";
              mutate(next);
            });
            bar.append(x);
          }
          bar.style.background = color;
          bar.style.left = ((si / 7) * 100) + "%";
          bar.style.width = (((ei - si + 1) / 7) * 100 - 1) + "%";
          bar.style.top = (lanes[entry.id] * 18) + "px";
          bar.title = label + " " + entry.startDate + "–" + entry.endDate;
          bar.addEventListener("click", (ev) => { ev.stopPropagation(); selectedEntryId = entry.id; render(); });
          laneLayer.append(bar);
        });
      });
      if (preview) {
        splitRangesByWeek(preview).forEach((seg) => {
          if (seg.endDate < weekStart || seg.startDate > weekEnd) return;
          const s = seg.startDate < weekStart ? weekStart : seg.startDate;
          const e = seg.endDate > weekEnd ? weekEnd : seg.endDate;
          const si = weekCells.findIndex((c) => c.iso === s);
          const ei = weekCells.findIndex((c) => c.iso === e);
          if (si < 0 || ei < 0) return;
          const bar = el("div", { class: "cal-bar preview" }, " ");
          bar.style.background = "#15803d";
          bar.style.left = ((si / 7) * 100) + "%";
          bar.style.width = (((ei - si + 1) / 7) * 100 - 1) + "%";
          bar.style.top = "36px";
          laneLayer.append(bar);
        });
      }
      week.append(laneLayer);
      grid.append(week);
    }
  }

  function render() {
    root.querySelectorAll("[data-cal-mode]").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset.calMode === mode);
    });
    paintPalette();
    paintGrid();
    paintEditor();
    root.querySelectorAll(".cal-day").forEach((day) => {
      (day as HTMLElement).style.touchAction = mode === "navigate" ? "pan-y" : "none";
    });
    errorEl.hidden = !error;
    errorEl.textContent = error;
  }

  function paintPreview() {
    if (!drag) {
      root.querySelectorAll(".cal-day").forEach((day) => day.classList.remove("in-range"));
      return;
    }
    const preview = normalizeRange(drag.start, drag.end);
    root.querySelectorAll(".cal-day").forEach((day) => {
      const iso = (day as HTMLElement).dataset.iso || "";
      day.classList.toggle("in-range", iso >= preview.startDate && iso <= preview.endDate);
    });
  }

  function onPointerDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, .cal-palette, .cal-editor, .cal-toolbar")) return;
    const iso = isoFromEvent(e);
    if (!iso) return;
    if (t.closest("[data-entry]")) return;
    if (mode === "navigate") return;
    if (mode !== "navigate" && !selectedTagId) {
      setError("a " + (mode === "focus" ? "focus" : mode === "workday" ? "work day" : "school activity") + " tag must be selected");
      return;
    }
    drag = { start: iso, end: iso };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    paintPreview();
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    const iso = isoFromEvent(e);
    if (!iso) return;
    drag.end = iso;
    paintPreview();
  }
  function onPointerUp(e: PointerEvent) {
    if (!drag) return;
    const iso = isoFromEvent(e) || drag.end;
    const range = normalizeRange(drag.start, iso);
    drag = null;
    paintPreview();
    commitRange(range.startDate, range.endDate);
  }

  root.addEventListener("wheel", (e) => {
    let stack: HTMLElement | null = null;
    const hits = typeof e.clientX === "number" ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    for (const n of hits) {
      if (!(n instanceof HTMLElement) || !root.contains(n)) continue;
      const day = n.closest(".cal-day") as HTMLElement | null;
      if (day) {
        stack = day.querySelector(".cal-day-stack");
        break;
      }
    }
    if (!stack) {
      const day = (e.target as HTMLElement | null)?.closest?.(".cal-day") as HTMLElement | null;
      stack = day && root.contains(day) ? day.querySelector(".cal-day-stack") : null;
    }
    if (!stack) return;
    if (stack.scrollHeight <= stack.clientHeight + 1) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * stack.clientHeight : e.deltaY;
    const atTop = stack.scrollTop <= 0;
    const atBottom = stack.scrollTop + stack.clientHeight >= stack.scrollHeight - 1;
    if ((dy > 0 && atBottom) || (dy < 0 && atTop) || dy === 0) return;
    e.preventDefault();
    e.stopPropagation();
    stack.scrollTop += dy;
  }, { capture: true, passive: false });
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", () => { drag = null; paintPreview(); });
  root.addEventListener("click", (e) => {
    if (mode !== "navigate") return;
    if ((e.target as HTMLElement).closest("[data-entry]")) return;
    const iso = isoFromEvent(e);
    if (iso && (lessons[iso] || []).length) opts.onOpenDate(iso);
  });

  root.querySelectorAll("[data-cal-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!editable) return;
      mode = ((b as HTMLElement).dataset.calMode || "navigate") as CalendarMode;
      selectedTagId = "";
      selectedEntryId = "";
      drag = null;
      render();
    });
  });
  const prev = root.querySelector("[data-cal-nav=\"prev\"]") as HTMLElement;
  const next = root.querySelector("[data-cal-nav=\"next\"]") as HTMLElement;
  const today = root.querySelector("[data-cal-nav=\"today\"]") as HTMLElement;
  prev.addEventListener("click", () => {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    render();
  });
  next.addEventListener("click", () => {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    render();
  });
  today.addEventListener("click", () => {
    const n = new Date();
    year = n.getFullYear();
    month = n.getMonth();
    render();
  });

  async function refresh() {
    data = hydrateCalendar(cloneCalendar(await opts.load()));
    lastConfirmed = cloneCalendar(data);
    loaded = true;
    setError("");
    if (opts.loadLessons) {
      try {
        lessons = await opts.loadLessons();
      } catch {
        lessons = {};
      }
    }
    render();
  }

  function setMonthFromIso(iso: string) {
    year = Number(iso.slice(0, 4));
    month = Number(iso.slice(5, 7)) - 1;
    if (loaded) render();
  }

  return { refresh, render, setMonthFromIso };
}
