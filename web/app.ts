// Extracted from the timeline template. DOM-heavy; types live in types.ts for the API.
// @ts-nocheck
import { api } from "./api";
import { createCalendarView } from "./calendar-view";
import { GRADE_TOKEN, formatIsoDate, lessonChipsFromSlotIds, parseIsoDate } from "./calendar-model";
import { chainLayout } from "./graph-layout";
import { formatKgApplyReport, hopColumns as graphHopColumns, hopLeap, hopLinkFor, neighborsOf } from "./graph-model";
import { bindNoteMentions, createGraphView, HOVER_DWELL_MS } from "./graph-view";
import { dockBeside } from "./overlay-layout";
import { MOTOR_SKILLS, SKILL_RELATED_COMPONENTS, facetText } from "./material-taxonomy";
import { MOTOR_ROOT_NAME, COMPONENT_ROOT_NAME, childrenOf, effectiveMembers, pathLabel, pathOf, pathLabelsForMaterial, roots, treeRows, wouldCycle } from "./set-tree";

  /* ==========================================================================
     TYPES (documentation only — mirrored in lesson-library/web/types.ts)

     Material  { id:"M2", name, slot:"instant"|"skill"|"key", look, motorSkills, skillRelatedComponents, duration?:number, notes?: string, sketch?: string }
     Link      { from, kind:"regression"|"progression"|"related", to, note, tag?: string }
     Foci      { items:[{ n:number, text:string }], now:number }
     Period    { id:"2026-09-10-G6", date:"2026-09-10", grade:"G6"|"G7",     // id = file name; `key` below is the Key SLOT (a material id)
                 instant?:id, skill?:id, key?:id,
                 times:{ instant:{start:"HH:MM", end:"HH:MM"}, skill:{...}, key:{...} },
                 reflection:{ flags:string[], text:string, savedAt?:string } }
     Suggestion{ focus:number, summary:string,
                 instant:{id,why}, skill:{id,why}, key:{id,why},
                 reads:{ foci:number, nodes:number, edges:number, layout:boolean, reflection:boolean } }
     ========================================================================== */

  const KINDS = {
    regression:   "Regression of",
    progression:  "Progression to",
    related:      "Related to",
  };
  const DEFAULT_PERIOD_START = "08:00";
  function matDuration(m) {
    const n = Number(m && m.duration);
    return Number.isFinite(n) && n >= 1 ? Math.min(40, Math.round(n)) : 20;
  }
  function facetPop(root) {
    if (!root) return null;
    return document.querySelector('.facet-select-pop[data-for="' + root.dataset.facetId + '"]') || root.querySelector(".facet-select-pop");
  }
  function checkedValues(root) {
    const pop = facetPop(root);
    const box = pop || root;
    if (!box) return [];
    return [...box.querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value);
  }
  function facetSummary(selected) {
    return selected && selected.length ? selected.join(", ") : "Choose…";
  }
  function syncFacetBtn(root) {
    const btn = root && root.querySelector(".facet-select-btn");
    if (btn) btn.textContent = facetSummary(checkedValues(root));
  }
  function closeFacetSelects(except) {
    document.querySelectorAll(".facet-select.open").forEach((c) => {
      if (except && c === except) return;
      c.classList.remove("open");
      const pop = facetPop(c);
      if (pop) {
        pop.hidden = true;
        pop.classList.remove("open");
        if (pop.parentElement !== c) c.appendChild(pop);
      }
    });
  }
  let facetSeq = 0;
  let keepSetFilterPop = false;
  function fillFacetSelect(root, vocab, selected) {
    if (!root) return;
    if (!root.dataset.facetId) root.dataset.facetId = "fs-" + (++facetSeq);
    const leftover = document.querySelector('.facet-select-pop[data-for="' + root.dataset.facetId + '"]');
    if (leftover && leftover.parentElement !== root) leftover.remove();
    root.classList.add("facet-select");
    root.replaceChildren();
    const btn = el("button", { type: "button", class: "facet-select-btn btn" }, facetSummary(selected));
    const pop = el("div", { class: "facet-select-pop", "data-for": root.dataset.facetId, hidden: "true" });
    for (const item of vocab) {
      const value = typeof item === "string" ? item : item.value;
      const label = typeof item === "string" ? item : item.label;
      const lab = el("label");
      const cb = el("input", { type: "checkbox", value });
      if ((selected || []).includes(value)) cb.checked = true;
      lab.append(cb, document.createTextNode(label));
      pop.append(lab);
    }
    root.append(btn, pop);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (root.classList.contains("open")) closeFacetSelects();
      else openFacetSelect(root);
    });
  }
  function openFacetSelect(root) {
    closeFacetSelects(root);
    root.classList.add("open");
    const btn = root.querySelector(".facet-select-btn");
    const pop = facetPop(root);
    if (!pop || !btn) return;
    document.body.appendChild(pop);
    pop.hidden = false;
    pop.classList.add("open");
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.round(r.left) + "px";
    pop.style.width = Math.round(Math.max(r.width, 220)) + "px";
    let top = r.bottom + 4;
    const h = Math.min(240, pop.scrollHeight || 240);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    pop.style.top = Math.round(top) + "px";
  }
  function treeChildNames(rootName, fallback) {
    const r = (state.sets || []).find((s) => s.name === rootName && !s.parent);
    if (!r) return fallback.slice();
    const kids = childrenOf(state.sets, r.id).map((s) => s.name).filter(Boolean);
    return kids.length ? kids : fallback.slice();
  }
  function fillAddFacets(host, ids) {
    host = host || $("#m-sets");
    if (!host) return;
    if (!ids) ids = state.addFormSets || [];
    const dropAttr = host === $("#m-sets") ? "data-add-form-drop" : "data-op-set-drop";
    host.replaceChildren();
    host.className = "wide he-cell" + (ids.length ? "" : " he-empty");
    ids.forEach((id) => {
      const set = (state.sets || []).find((s) => s.id === id);
      if (!set) return;
      const line = el("div", { class: "he-path" });
      taxonomyPath(set).forEach((s, i) => {
        if (i) line.append(document.createTextNode(" - "));
        line.append(el("span", { "data-set": s.id }, s.name || s.id));
      });
      line.append(el("button", { type: "button", class: "he-x", [dropAttr]: id, title: "Remove from this activity set" }, "−"));
      host.append(line);
    });
    host.append(addSetSelect("", ids));
  }
  function openHePicker(td, m) {
    closeFacetSelects();
    td.querySelectorAll(".he-picker").forEach((n) => n.remove());
    const wrap = el("div", { class: "he-picker" });
    const motors = el("div");
    const comps = el("div");
    fillFacetSelect(motors, treeChildNames(MOTOR_ROOT_NAME, MOTOR_SKILLS), m.motorSkills || []);
    fillFacetSelect(comps, treeChildNames(COMPONENT_ROOT_NAME, SKILL_RELATED_COMPONENTS), m.skillRelatedComponents || []);
    const save = el("button", { class: "btn solid", type: "button" }, "Save");
    save.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api.updateMaterial(m.id, {
        motorSkills: checkedValues(motors),
        skillRelatedComponents: checkedValues(comps),
      });
      await loadGraph();
    });
    wrap.append(motors, comps, save);
    td.append(wrap);
  }
  function addMinutes(hhmm, n) {
    const [h, m] = (hhmm || "00:00").split(":").map(Number);
    let t = h * 60 + m + n;
    if (t < 0) t = 0;
    t = t % (24 * 60);
    return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  }
  function ensureTimes(p) { return p; }
  function minutesBetween(a, b) {
    const [ah, am] = (a || "00:00").split(":").map(Number);
    const [bh, bm] = (b || "00:00").split(":").map(Number);
    return (bh * 60 + bm) - (ah * 60 + am);
  }
  function actSpanMins(act) {
    const d = minutesBetween(act && act.start, act && act.end);
    if (d > 0) return d;
    return matDuration(matById(act && act.id));
  }
  function restackActs(acts, originStart) {
    let start = originStart || DEFAULT_PERIOD_START;
    (acts || []).forEach((a) => {
      const mins = actSpanMins(a);
      a.start = start;
      a.end = addMinutes(start, mins);
      start = a.end;
    });
    return acts;
  }
  /* ==========================================================================
     STATE (in-memory mirror of what api returned; render functions read this)
     ========================================================================== */
  const NOTES_PLACEHOLDER = "How the drill is done. Type @ then a similar drill (name or description), then Polish.";
  const state = { materials: [], links: [], sets: [], pendingOps: [], pendingSel: new Set(), foci: { items: [], now: 1 }, period: null, suggestion: null, suggestionDate: null, drawerId: null, drawerAnchor: null, peekId: null, peekAnchor: null, peekSide: null, overlayW: 400, overlayH: 360, filter: "", nameQ: "", nameQHits: null, sort: "id", setSortKeys: [], pathOrder: {}, matText: "look", canva: [], addPick: null, addSet: null, addFormSets: [], setSheet: null, drag: null, view: "graph", tlMode: "edit", hitlSession: "" };
  let graphView;
  const OVERLAY_SIZE_KEY = "flag-lesson-library-overlay-size";
  const VIEW_KEY = "flag-lesson-library-view";
  const GRADE_KEY = "flag-lesson-library-grade";
  const TL_MODE_KEY = "flag-lesson-library-tl-mode";
  const TL_LANE_KEY = "flag-lesson-library-tl-lanes";
  const TL_LANE_MIN = 120;
  const TL_LANE_DEFAULT = 280;
  function defaultOverlayH() { return Math.round(Math.min(window.innerHeight * 0.52, 480)); }
  function clampOverlay(w, h) {
    const vw = window.innerWidth, vh = window.innerHeight;
    return {
      w: Math.max(240, Math.min(Math.round(w), Math.max(240, vw - 24))),
      h: Math.max(180, Math.min(Math.round(h), Math.max(180, vh - 24)))
    };
  }
  function overlaySize() { return clampOverlay(state.overlayW, state.overlayH); }
  function readSavedOverlaySize() {
    try {
      const s = JSON.parse(localStorage.getItem(OVERLAY_SIZE_KEY) || "");
      if (s && s.w && s.h) { const c = clampOverlay(s.w, s.h); state.overlayW = c.w; state.overlayH = c.h; return; }
    } catch (e) {}
    state.overlayW = 400;
    state.overlayH = defaultOverlayH();
  }
  function saveOverlaySize() {
    try { localStorage.setItem(OVERLAY_SIZE_KEY, JSON.stringify(overlaySize())); } catch (e) {}
  }
  function clampTlH(n) {
    return Math.max(TL_LANE_MIN, Math.round(Number(n) || TL_LANE_DEFAULT));
  }
  function readSavedTlLanes() {
    try {
      const s = JSON.parse(localStorage.getItem(TL_LANE_KEY) || "");
      if (s && typeof s === "object") {
        state.tlH = {
          stack: clampTlH(s.stack || s.skill || TL_LANE_DEFAULT),
          foot: Math.max(76, Math.round(Number(s.foot) || 210)),
        };
        state.tlScrollH = Math.max(0, Math.round(Number(s.scroll) || 0));
        const actH = {};
        if (s.actH && typeof s.actH === "object") {
          Object.keys(s.actH).forEach((k) => {
            const n = Math.max(88, Math.round(Number(s.actH[k]) || 0));
            if (n) actH[k] = n;
          });
        }
        state.tlActH = actH;
      }
    } catch (e) {}
  }
  function saveTlLanes() {
    try { localStorage.setItem(TL_LANE_KEY, JSON.stringify({ ...state.tlH, scroll: state.tlScrollH || 0, actH: state.tlActH || {} })); } catch (e) {}
  }
  function applyTlLaneHeights() {
    const grid = $("#tl-grid");
    if (!grid || !state.tlH) return;
    grid.style.setProperty("--tl-h-stack", (state.tlH.stack || TL_LANE_DEFAULT) + "px");
    grid.style.setProperty("--tl-h-foot", (state.tlH.foot || 210) + "px");
    const heights = state.tlActH || {};
    grid.querySelectorAll(".tl-act").forEach((box) => {
      const cell = box.closest(".tl-cell");
      const key = (cell && cell.dataset.period ? cell.dataset.period : "") + ":" + String(box.dataset.act || "");
      const h = Math.round(Number(heights[key]) || 0);
      if (h >= 88) {
        box.style.height = h + "px";
        box.style.minHeight = h + "px";
        box.style.maxHeight = h + "px";
      } else {
        box.style.height = "";
        box.style.minHeight = "";
        box.style.maxHeight = "";
      }
    });
  }
  readSavedOverlaySize();
  readSavedTlLanes();

  const $ = (sel) => document.querySelector(sel);
  /** isoLocal(date) → "YYYY-MM-DD" in the browser's local zone. Never use toISOString() for period ids: in UTC+8 it returns yesterday after 08:00. */
  const isoLocal = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const addDaysIso = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoLocal(d); };
  const fmtDate = (iso) => { const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
  const FLAG_PAIRS = [["too slow", "too fast"], ["too easy", "too hard"]];
  function periodEmpty(p) {
    if (!p) return true;
    const refl = p.reflection && ((p.reflection.flags && p.reflection.flags.length) || String(p.reflection.text || "").trim());
    return !periodActs(p).length && !refl;
  }
  const periodIsBlank = periodEmpty;
  function emptyAct(id, start, end) {
    return { id, start: start || DEFAULT_PERIOD_START, end: end || "08:20", easier: [], harder: [], alts: [] };
  }
  function normAct(a) {
    if (!a) return null;
    if (typeof a === "string") return emptyAct(a);
    const m = matById(a.id);
    const start = a.start || DEFAULT_PERIOD_START;
    const end = a.end || addMinutes(start, matDuration(m));
    return { id: a.id, start, end, easier: [].concat(a.easier || []), harder: [].concat(a.harder || []), alts: [].concat(a.alts || []) };
  }
  function periodActs(p) {
    return Array.isArray(p && p.activities) ? p.activities.map(normAct).filter((a) => a && a.id) : [];
  }
  function writeActs(p, acts) {
    p.activities = acts;
  }
  function membersForLane(members, excluded, already) {
    const skip = new Set([].concat(excluded || [], already || []));
    const seen = new Set();
    const out = [];
    for (const id of members) {
      if (skip.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  /** Next-lesson target: first FLAG date after `fromDate` with no pins; else the first calendar date after the last saved period that has no file for this grade. Never date+1 into a weekend or a day that already has a class. */
  function firstBlankDate(periods, fromDate) {
    const from = fromDate || (periods[0] && periods[0].date) || isoLocal(new Date());
    const laterBlank = periods.find((p) => p.date > from && periodIsBlank(p));
    if (laterBlank) return laterBlank.date;
    const last = periods[periods.length - 1];
    const taken = new Set(periods.map((p) => p.date));
    let d = addDaysIso(last ? last.date : from, 1);
    while (taken.has(d)) d = addDaysIso(d, 1);
    return d;
  }
  /** Next saved class on or after `iso`, else the last class before it. Blank (unpinned) days are skipped. */
  function nearestClassDate(periods, iso) {
    const withClass = (periods || []).filter((p) => !periodIsBlank(p));
    if (!withClass.length) return "";
    const upcoming = withClass.filter((p) => p.date >= iso);
    if (upcoming.length) return upcoming[0].date;
    return withClass[withClass.length - 1].date;
  }
  const el = (tag, attrs, text) => { const n = document.createElement(tag); if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };
  const matById = (id) => state.materials.find((m) => m.id === id);
  const label = (id) => { const m = matById(id); return m ? m.id + " " + m.name : id; };
  function sketchRel(hit) {
    const n = String(hit || "").replace(/\\/g, "/").split("?")[0];
    const name = (n.split("/").pop() || "").replace(/%20/g, " ");
    if (!name || !/\.(png|jpe?g|webp|gif|mp4|m4v|webm|mov)$/i.test(name)) return "";
    return "library/media_library/flag football/" + name;
  }
  function sketchSrc(m, all) {
    const fromNotes = [...String((m && m.notes) || "").matchAll(/(?:library\/media_library\/flag football|media_library|canva-sketches|library\/sketches)\/[\w\-.]+\.(?:png|jpe?g|webp|gif|mp4|m4v|webm|mov)/gi)].map((x) => x[0]);
    const hits = [];
    const add = (h) => {
      const rel = sketchRel(h);
      if (rel && hits.indexOf(rel) < 0) hits.push(rel);
    };
    if (m && m.sketch) add(m.sketch);
    else if (!(m && m.sketch === "")) fromNotes.forEach(add);
    const srcs = hits.map((rel) => "/assets/" + rel.split("/").map(encodeURIComponent).join("/"));
    if (all) return srcs;
    return srcs[0] || "";
  }
  function sketchIsVideo(src) {
    return /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(String(src || ""));
  }
  function sketchMedia(src, className, alt) {
    if (sketchIsVideo(src)) {
      const v = el("video", { class: className || "", src, muted: "", playsinline: "", preload: "metadata" });
      v.muted = true;
      return v;
    }
    return el("img", { class: className || "", src, alt: alt || "" });
  }
  /** Timeline explanation: material notes (drawer Explanation), minus sketch file lines. */
  function matExplain(m) {
    const notes = String((m && m.notes) || "")
      .replace(/^\s*Sketch:\s*(?:library\/media_library\/flag football|media_library|canva-sketches|library\/sketches)\/\S+\s*$/gmi, "")
      .replace(/(?:library\/media_library\/flag football|media_library|canva-sketches|library\/sketches)\/[\w\-.]+\.(?:png|jpe?g|webp|gif|mp4|m4v|webm|mov)/gi, "")
      .replace(/^\s*Drill notes:\s*\S+\s*$/gmi, "")
      .replace(/^\s*Sketch:\s*$/gmi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (notes) return notes;
    return String((m && m.look) || "").trim();
  }
  function fillPicChooser() {
    const grid = $("#pic-chooser-grid"); if (!grid) return;
    const cur = sketchRel((matById(state.drawerId) || {}).sketch || "");
    grid.replaceChildren();
    (state.canva || []).forEach((rel) => {
      const key = sketchRel(rel);
      const btn = el("button", { type: "button", "data-pick-sketch": rel, class: cur === key ? "on" : "", title: rel });
      btn.append(sketchMedia("/assets/" + key.split("/").map(encodeURIComponent).join("/"), "", ""));
      btn.append(el("span", {}, (key.split("/").pop() || "").replace(/\.[^.]+$/, "")));
      grid.append(btn);
    });
  }
  function closePicChooser() {
    const box = $("#pic-chooser"); if (!box) return;
    box.classList.remove("open");
    box.hidden = true;
  }
  function openPicChooser(anchor) {
    const box = $("#pic-chooser"); if (!box) return;
    fillPicChooser();
    box.hidden = false;
    box.classList.add("open");
    const r = (anchor || $("#dr-pic-replace")).getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 24);
    let left = r.left;
    if (left + w > window.innerWidth - 12) left = Math.max(12, window.innerWidth - w - 12);
    let top = r.bottom + 8;
    const h = Math.min(box.offsetHeight || 280, window.innerHeight * 0.56);
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  }
  function paintPicEls(img, empty, nameEl, m) {
    if (!img) return;
    const src = sketchSrc(m);
    if (nameEl) {
      if (!src) nameEl.textContent = "No picture";
      else {
        const rel = sketchRel(m.sketch || src);
        nameEl.textContent = rel.split("/").pop().replace(/\?.*$/, "") || "Picture";
      }
    }
    const host = img.parentElement;
    let vid = host && host.querySelector("video.pic-media");
    if (src) {
      const url = src + (src.includes("media_library/") ? "?t=" + Date.now() : "");
      if (sketchIsVideo(src)) {
        img.removeAttribute("src");
        img.hidden = true;
        if (!vid) {
          vid = el("video", { class: "pic-media", muted: "", playsinline: "", preload: "metadata" });
          vid.muted = true;
          img.after(vid);
        }
        vid.src = url;
        vid.hidden = false;
      } else {
        if (vid) { vid.removeAttribute("src"); vid.hidden = true; }
        img.src = url;
        img.hidden = false;
        img.onerror = () => (img.hidden = true);
      }
      if (empty) empty.hidden = true;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      if (vid) { vid.removeAttribute("src"); vid.hidden = true; }
      if (empty) empty.hidden = false;
    }
  }
  function paintDrawerPic(m) {
    paintPicEls($("#dr-img"), $("#dr-pic-empty"), $("#dr-pic-name"), m);
  }
  function paintNeighbors(nb, id) {
    nb.replaceChildren();
    const n = neighborsOf(id);
    [["regression", "Easier"], ["progression", "Harder"], ["related", "Related"]].forEach(([k, title]) => {
      const box = el("div", { "data-nb": k }); box.append(el("b", { class: "k-" + k }, title));
      if (!n[k].length) box.append(el("span", { class: "mute" }, "—"));
      n[k].forEach((x) => {
        const s = el("div", { class: "id", "data-open": x.id, style: "cursor:pointer" }, label(x.id));
        if (x.tag || x.note) s.append(el("div", { class: "mute" }, [x.tag, x.note].filter(Boolean).join(" · ")));
        box.append(s);
      });
      nb.append(box);
    });
  }
  let toastT; function toast(msg, ms) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms || 1800); }

  /* ==========================================================================
     GRAPH HELPERS — pure functions on state.links. Same logic lives in
     server/store.ts so the LLM prompt and the UI agree on neighbours.
     ========================================================================== */

  /** neighborsOf(id) → { regression:[{id,note,tag}], progression:[...], related:[...] }
   *  regression  = nodes EASIER than id  (rows kind=regression with to=id, plus rows kind=progression with to=id)
   *  progression = nodes HARDER than id  (rows kind=progression with from=id, plus rows kind=regression with from=id)
   *  related is symmetric; tag is a label on the hop. */
  function neighborsOf(id, links) {
    links = links || state.links;
    const out = { regression: [], progression: [], related: [] };
    const seen = new Set();
    const push = (bucket, other, L) => { const k = bucket + ":" + other; if (seen.has(k) || other === id) return; seen.add(k); const row = { id: other, note: L.note || "", tag: L.tag }; if (L.kind === "progression" || L.kind === "regression") row.leap = hopLeap(L); out[bucket].push(row); };
    for (const L of links) {
      const kind = L.kind;
      if (kind === "regression")  { if (L.to === id) push("regression", L.from, L); if (L.from === id) push("progression", L.to, L); }
      else if (kind === "progression") { if (L.from === id) push("progression", L.to, L); if (L.to === id) push("regression", L.from, L); }
      else if (kind === "related") { if (L.from === id) push("related", L.to, L); if (L.to === id) push("related", L.from, L); }
    }
    return out;
  }

  /** hopChoices(id, dir) → the full list shown in a hop popover. dir = "regression" | "progression".
   *  Falls back to related + tags + same-slot items so the popover is never empty when the chain is thin. */
  function hopChoices(id, dir) {
    const n = neighborsOf(id);
    const direct = n[dir].map((x) => Object.assign({ direct: true }, x));
    if (direct.length) return direct;
    const m = matById(id);
    const soft = [].concat(n.related).map((x) => Object.assign({ direct: false }, x));
    if (soft.length) return soft;
    const dur = matDuration(m);
    return state.materials.filter((x) => x.id !== id && Math.abs(matDuration(x) - dur) <= 5).slice(0, 6).map((x) => ({ id: x.id, note: "similar duration (no link yet)", direct: false }));
  }

  /* ==========================================================================
     RENDER — PANEL 1: FOCI
     ========================================================================== */
  function renderFoci() {
    const row = $("#foci-row");
    row.querySelectorAll(".focus").forEach((n) => n.remove());
    const input = $("#focus-new");
    state.foci.items.forEach((f) => {
      const chip = el("div", { class: "focus" + (f.n === state.foci.now ? " now" : ""), "data-n": f.n });
      chip.append(el("span", { class: "n" }, String(f.n)), document.createTextNode(" " + f.text), el("span", { class: "x", "data-remove": f.n, title: "remove" }, "✕"));
      row.insertBefore(chip, input);
    });
    renderReads();
  }
  $("#foci-row").addEventListener("click", async (e) => {
    const x = e.target.closest("[data-remove]");
    if (x) { // UI → PUT /api/foci
      const n = Number(x.dataset.remove);
      state.foci.items = state.foci.items.filter((f) => f.n !== n).map((f, i) => ({ n: i + 1, text: f.text }));
      if (!state.foci.items.some((f) => f.n === state.foci.now)) state.foci.now = state.foci.items.length ? 1 : 0;
      await api.saveFoci(state.foci); renderFoci(); return;
    }
    const chip = e.target.closest(".focus");
    if (chip) { state.foci.now = Number(chip.dataset.n); await api.saveFoci(state.foci); renderFoci(); }
  });
  $("#focus-new").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    state.foci.items.push({ n: state.foci.items.length + 1, text: e.target.value.trim() });
    e.target.value = ""; await api.saveFoci(state.foci); renderFoci();
  });

  /* ==========================================================================
     RENDER — PANEL 2: LIBRARY TABLES
     ========================================================================== */
  function passesMat(m) {
    if (state.filter && ![m.id, m.name, m.look, m.notes, facetText(m.motorSkills, m.skillRelatedComponents), String(matDuration(m))].join(" ").toLowerCase().includes(state.filter)) return false;
    if (state.nameQ) {
      if (state.nameQHits) {
        if (state.nameQHits.indexOf(m.id) < 0) return false;
      } else if (!(m.name || "").toLowerCase().includes(state.nameQ)) return false;
    }
    const keys = state.setSortKeys || [];
    if (keys.length) {
      const hit = keys.some((id) => effectiveMembers(state.sets || [], id).includes(m.id));
      if (!hit) return false;
    }
    return true;
  }
  function passes(text) { return !state.filter || text.toLowerCase().includes(state.filter); }

  function paintAddPickBar() {
    const hint = $("#add-pick-hint");
    const text = $("#add-pick-text");
    if (state.addPick) {
      if (text) {
        const verb = state.addPick.mode === "replace" ? "Changing" : "Adding to";
        const action = state.addPick.mode === "replace" ? "Change" : "Add";
        text.textContent = verb + " activity · " + state.addPick.periodId + " — quick-search the name, then " + action + ".";
      }
      if (hint) hint.hidden = false;
    } else if (hint) hint.hidden = true;
  }
  function scrollToAddPickHint() {
    const lib = $("#library");
    const hint = $("#add-pick-hint");
    if (!lib || !hint || hint.hidden) return;
    lib.scrollIntoView({ block: "nearest" });
    const lr = lib.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    lib.scrollTop += hr.top - lr.top - 8;
  }
  async function openMaterialPicker(p, extra) {
    extra = extra || {};
    setView("table");
    const scroller = document.querySelector(".tl-scroll");
    state.addPick = {
      periodId: p.id,
      scrollLeft: scroller ? scroller.scrollLeft : 0,
      date: p.date,
      grade: p.grade,
      mode: extra.mode || "add",
      actIndex: extra.actIndex,
      draft: extra.draft || ""
    };
    paintAddPickBar();
    renderMaterials();
    scrollToAddPickHint();
    const nq = $("#name-q");
    if (nq) { nq.focus(); nq.select(); }
  }
  async function backToTimeline() {
    const pick = state.addPick;
    state.addPick = null;
    paintAddPickBar();
    renderMaterials();
    const tl = $("#timeline");
    if (tl) tl.scrollIntoView({ block: "start" });
    if (pick && pick.date) {
      $("#p-date").value = pick.date;
      if (pick.grade) $("#p-grade").value = pick.grade;
      await loadPeriod();
      const sc = document.querySelector(".tl-scroll");
      if (sc) sc.scrollLeft = pick.scrollLeft;
      const cell = document.querySelector('.tl-cell[data-period="' + pick.periodId + '"]');
      if (cell) cell.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }

  function matIdNum(id) {
    const m = /^M(\d+)$/.exec(id || "");
    return m ? Number(m[1]) : 0;
  }
  function sortMaterials(rows) {
    const sort = state.sort || "id";
    const copy = rows.slice();
    const keys = state.setSortKeys || [];
    const memberMaps = keys.map((id) => new Set(effectiveMembers(state.sets || [], id)));
    let byBase = (a, b) => matIdNum(a.id) - matIdNum(b.id);
    if (sort === "duration") {
      byBase = (a, b) => matDuration(a) - matDuration(b) || matIdNum(a.id) - matIdNum(b.id);
    } else if (sort === "hyperedge") {
      const order = new Map(treeRows(state.sets).map((r, i) => [r.set.id, i]));
      const key = (m) => {
        const paths = pathLabelsForMaterial(state.sets, m.id).filter((p) => !childrenOf(state.sets, p.set.id).length);
        const pref = ((state.pathOrder || {})[m.id] || [])[0];
        const p = (pref && paths.find((x) => x.set.id === pref)) || paths[0];
        if (!p) return [9999, "zzz"];
        return [order.get(p.set.id) ?? 9998, p.label];
      };
      byBase = (a, b) => {
        const ka = key(a), kb = key(b);
        return ka[0] - kb[0] || String(ka[1]).localeCompare(String(kb[1])) || matIdNum(a.id) - matIdNum(b.id);
      };
    } else if (sort === "relation") {
      const layout = chainLayout(copy.map((m) => m.id), state.links);
      byBase = (a, b) => {
        const pa = layout.get(a.id);
        const pb = layout.get(b.id);
        const aG = pa && pa.rank == null;
        const bG = pb && pb.rank == null;
        if (aG && !bG) return 1;
        if (bG && !aG) return -1;
        return (pa?.comp ?? 9999) - (pb?.comp ?? 9999) || (pa?.rank ?? 9999) - (pb?.rank ?? 9999) || matIdNum(a.id) - matIdNum(b.id);
      };
    }
    copy.sort((a, b) => {
      for (let i = memberMaps.length - 1; i >= 0; i--) {
        const mem = memberMaps[i];
        const ia = mem.has(a.id) ? 0 : 1;
        const ib = mem.has(b.id) ? 0 : 1;
        if (ia !== ib) return ia - ib;
      }
      return byBase(a, b);
    });
    return copy;
  }
  function addSetSelect(materialId, skipIds) {
    const sel = el("select", { class: "cell he-add-select", "data-add-set": materialId });
    sel.append(el("option", { value: "" }, "+ add to an activity set"));
    const mine = new Set([
      ...(state.sets || []).filter((s) => materialId && s.members.includes(materialId)).map((s) => s.id),
      ...(skipIds || []),
    ]);
    const seen = new Set();
    const indie = el("optgroup", { label: "Activity set" });
    for (const s of roots(state.sets || [], "independent")) {
      if (mine.has(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      indie.append(el("option", { value: s.id }, s.name || s.id));
    }
    if (indie.childNodes.length) sel.append(indie);
    const named = [MOTOR_ROOT_NAME, COMPONENT_ROOT_NAME]
      .map((name) => (state.sets || []).find((s) => s.name === name && !s.parent))
      .filter(Boolean);
    for (const r of named) {
      const group = el("optgroup", { label: r.name === COMPONENT_ROOT_NAME ? "Skill" : r.name || r.id });
      const kids = childrenOf(state.sets, r.id);
      let leaves = kids;
      if (!leaves.length) {
        const vocab = r.name === MOTOR_ROOT_NAME ? MOTOR_SKILLS : SKILL_RELATED_COMPONENTS;
        leaves = treeChildNames(r.name, vocab)
          .map((name) => state.sets.find((s) => s.name === name))
          .filter(Boolean);
      }
      leaves.forEach((s) => {
        if (mine.has(s.id) || seen.has(s.id)) return;
        seen.add(s.id);
        group.append(el("option", { value: s.id }, s.name || s.id));
      });
      if (group.childNodes.length) sel.append(group);
    }
    return sel;
  }
  function taxonomyPath(set) {
    const path = pathOf(state.sets, set.id);
    if (path.length >= 2) return path.map((s) => (s.name === COMPONENT_ROOT_NAME ? { ...s, name: "Skill" } : s));
    const motor = (state.sets || []).find((s) => s.name === MOTOR_ROOT_NAME && !s.parent);
    const comp = (state.sets || []).find((s) => s.name === COMPONENT_ROOT_NAME && !s.parent);
    if (motor && MOTOR_SKILLS.includes(set.name)) return [motor, set];
    if (comp && SKILL_RELATED_COMPONENTS.includes(set.name)) return [{ ...comp, name: "Skill" }, set];
    return path.length ? path : [set];
  }
  function hyperedgeCell(m) {
    const td = el("td", { class: "he-cell" });
    const paths = pathLabelsForMaterial(state.sets, m.id).filter((p) => !childrenOf(state.sets, p.set.id).length);
    const order = (state.pathOrder && state.pathOrder[m.id]) || [];
    paths.sort((a, b) => {
      const ia = order.indexOf(a.set.id);
      const ib = order.indexOf(b.set.id);
      const ra = ia < 0 ? order.length + 1 : ia;
      const rb = ib < 0 ? order.length + 1 : ib;
      return ra - rb || a.label.localeCompare(b.label);
    });
    if (!paths.length) {
      td.className = "he-cell he-empty";
      td.append(addSetSelect(m.id));
      return td;
    }
    paths.forEach((p) => {
      const line = el("div", { class: "he-path", "data-he-path": p.set.id });
      line.append(el("span", {
        class: "he-sort-drag",
        draggable: "true",
        "data-he-sort-drag": p.set.id,
        title: "Drag onto another activity set to swap order",
      }));
      taxonomyPath(p.set).forEach((s, i) => {
        if (i) line.append(document.createTextNode(" - "));
        line.append(el("span", { "data-set": s.id }, s.name || s.id));
      });
      line.append(el("button", { type: "button", class: "he-x", "data-he-drop": p.set.id, title: "Remove from this activity set" }, "−"));
      td.append(line);
    });
    td.append(addSetSelect(m.id));
    return td;
  }

  function renderMaterials() {
    if (!keepSetFilterPop) closeFacetSelects();
    const tb = $("#materials-table tbody"); tb.replaceChildren();
    const filtered = state.materials.filter(passesMat);
    const rows = (state.nameQ && state.nameQHits)
      ? state.nameQHits.map((id) => filtered.find((m) => m.id === id)).filter(Boolean)
      : sortMaterials(filtered);
    $("#mat-caption").textContent = "Materials — " + rows.length + (rows.length !== state.materials.length ? " of " + state.materials.length : "") + " rows";
    const filterEl = $("#mat-set-filter");
    if (filterEl) {
      const keys = state.setSortKeys || [];
      const rank = new Map(keys.map((id, i) => [id, i + 1]));
      const seen = new Set();
      const choices = [];
      for (const s of roots(state.sets || [], "independent")) {
        if (!seen.has(s.id)) { seen.add(s.id); choices.push(s); }
      }
      for (const r of roots(state.sets || [], "first")) {
        let leaves = childrenOf(state.sets, r.id);
        if (!leaves.length) {
          const vocab = r.name === MOTOR_ROOT_NAME ? MOTOR_SKILLS : SKILL_RELATED_COMPONENTS;
          leaves = vocab.map((name) => (state.sets || []).find((s) => s.name === name)).filter(Boolean);
        }
        leaves.forEach((s) => { if (!seen.has(s.id)) { seen.add(s.id); choices.push(s); } });
      }
      const names = new Map(choices.map((s) => [s.id, s.name || s.id]));
      const summary = keys.length
        ? keys.map((id, i) => (i + 1) + " " + (names.get(id) || id)).join(", ")
        : "All sets";
      const sig = choices.map((s) => s.id).join(",");
      if (filterEl.dataset.sig !== sig) {
        fillFacetSelect(filterEl, choices.map((s) => ({
          value: s.id,
          label: (rank.get(s.id) ? rank.get(s.id) + " " : "") + (s.name || s.id),
        })), keys);
        filterEl.dataset.sig = sig;
      }
      const pop = facetPop(filterEl);
      if (pop) {
        pop.querySelectorAll("label").forEach((lab) => {
          const cb = lab.querySelector("input");
          if (!cb) return;
          const n = rank.get(cb.value);
          cb.checked = !!n;
          const text = lab.childNodes[lab.childNodes.length - 1];
          if (text) text.textContent = (n ? n + " " : "") + (names.get(cb.value) || cb.value);
        });
      }
      const btn = filterEl.querySelector(".facet-select-btn");
      if (btn) btn.textContent = summary;
    }
    const textEl = $("#mat-text-col"); if (textEl) textEl.value = state.matText === "notes" ? "notes" : "look";
    const textField = state.matText === "notes" ? "notes" : "look";
    const polishKind = textField === "notes" ? "explanation" : "look";
    rows.forEach((m) => {
      const tr = el("tr", { "data-id": m.id });
      tr.append(el("td", { class: "id", "data-open": m.id, title: "open node" }, m.id));
      const nameTd = el("td", { class: "cell-polish" });
      const nameInner = el("div", { class: "cell-polish-inner" });
      const name = el("div", { contenteditable: "true", "data-field": "name" }, m.name);
      nameInner.append(
        name,
        el("button", { class: "btn", type: "button", "data-polish": "name", title: "Make this title shorter and clearer" }, "Polish"),
      );
      nameTd.append(nameInner);
      const durTd = el("td");
      durTd.append(el("input", { type: "number", min: "1", max: "40", class: "cell", "data-field": "duration", value: String(matDuration(m)), title: "Estimate minutes" }));
      const lookTd = el("td", { class: "cell-polish" });
      const lookInner = el("div", { class: "cell-polish-inner" });
      const ta = el("textarea", {
        class: "cell-text",
        "data-field": textField,
        rows: "5",
        placeholder: textField === "notes" ? NOTES_PLACEHOLDER : "Cue or setup",
      });
      ta.value = m[textField] || "";
      lookInner.append(
        ta,
        el("button", { class: "btn", type: "button", "data-polish": polishKind, title: textField === "notes" ? "Make this explanation shorter and clearer" : "Make this cue shorter and clearer" }, "Polish"),
      );
      lookTd.append(lookInner);
      if (textField === "notes") {
        bindNoteMentions(ta, {
          onSearch: (q) => api.search(q, 12),
          materials: () => state.materials,
          onPeek: (id, anchor) => showPeek(anchor, id, "right", true),
          onPeekLeave: hidePeekSoon,
        });
      }
      const he = hyperedgeCell(m);
      const pic = el("td", { class: "pic-cell" });
      const row = el("div", { class: "pic-row" });
      const src = sketchSrc(m);
      if (src) row.append(sketchMedia(src, "thumb", ""));
      else row.append(el("span", { class: "thumb empty" }, "—"));
      const lab = el("label", { class: "btn file-btn" }, "Attach");
      lab.append(el("input", { type: "file", accept: "video/mp4,video/webm,video/quicktime,video/*,image/gif,image/png,image/jpeg,image/webp,.mp4,.m4v,.webm,.mov,.gif", "data-sketch-file": m.id }));
      row.append(lab);
      pic.append(row);
      const pin = el("td");
      const picking = !!state.addPick;
      const replacing = picking && state.addPick.mode === "replace";
      const pb = el("button", {
        class: "btn" + (picking ? " solid" : ""),
        type: "button",
        "data-pin": m.id,
        title: replacing ? "change activity in " + state.addPick.periodId : picking ? "add to " + state.addPick.periodId : "pin on this period (append if others exist)"
      }, replacing ? "Change" : picking ? "Add" : "pin");
      pin.append(pb);
      const del = el("td"); del.append(el("button", { class: "btn danger", type: "button", "data-del-mat": m.id }, "Remove"));
      tr.append(nameTd, durTd, lookTd, he, pic, pin, del); tb.append(tr);
    });
    document.querySelectorAll("#tl-grid .tl-act").forEach((box) => {
      const peek = box.querySelector("[data-peek]");
      const mat = peek && matById(peek.dataset.peek);
      if (!mat) return;
      const expl = matExplain(mat);
      let node = box.querySelector(":scope > .tl-act-explain");
      if (expl) {
        if (!node) {
          node = el("div", { class: "tl-act-explain" });
          const head = box.querySelector(":scope > .tl-act-head");
          if (head) head.after(node);
          else box.prepend(node);
        }
        node.textContent = expl;
      } else if (node) node.remove();
    });
  }

  function renderLinks() {
    const tb = $("#links-table tbody"); tb.replaceChildren();
    const rows = state.links.filter((L) => {
      const chain = L.kind === "progression" || L.kind === "regression";
      return passes([label(L.from), KINDS[L.kind], chain ? hopLeap(L).toFixed(1) : "", L.tag || "", label(L.to), L.note].join(" "));
    });
    $("#link-caption").textContent = "Links — " + rows.length + (rows.length !== state.links.length ? " of " + state.links.length : "") + " rows";
    rows.forEach((L) => {
      const tr = el("tr", { "data-from": L.from, "data-kind": L.kind, "data-to": L.to });
      tr.append(el("td", { "data-peek": L.from, title: "Hover to preview" }, label(L.from)));
      const k = el("td");
      const chain = L.kind === "progression" || L.kind === "regression";
      k.append(el("span", { class: "kind k-" + L.kind }, (KINDS[L.kind] || L.kind) + (chain ? " · " + hopLeap(L).toFixed(1) : "")));
      if (L.tag) k.append(el("div", { class: "mute" }, L.tag));
      tr.append(k);
      tr.append(el("td", { "data-peek": L.to, title: "Hover to preview" }, label(L.to)));
      const noteTd = el("td", { class: "cell-polish" });
      noteTd.append(
        el("div", {
          contenteditable: "true",
          "data-field": "note",
          title: L.tag ? "tag: note" : "note",
        }, L.tag ? (L.tag + (L.note ? ": " + L.note : "")) : L.note),
        el("button", { class: "btn", type: "button", "data-polish": "note", title: "Make this note shorter and clearer" }, "Polish"),
      );
      tr.append(noteTd);
      const del = el("td"); del.append(el("button", { class: "btn danger", type: "button", "data-del-link": "1" }, "Remove")); tr.append(del);
      tb.append(tr);
    });
  }

  function relatedTagChoices() {
    return [...new Set(state.links.filter((L) => L.kind === "related").map((L) => (L.tag || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  function fillRelatedTagList() {
    const dl = $("#l-tag-list"); if (!dl) return;
    dl.replaceChildren();
    relatedTagChoices().forEach((t) => dl.append(el("option", { value: t })));
  }
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest(".facet-select, .facet-select-pop, #peek-drawer")) return;
    closeFacetSelects();
  });
  document.addEventListener("change", async (e) => {
    const pop = e.target.closest(".facet-select-pop");
    if (!pop) return;
    const root = document.querySelector('.facet-select[data-facet-id="' + pop.dataset.for + '"]');
    if (!root) return;
    if (root.id === "mat-set-filter") {
      const box = e.target;
      if (!box || box.type !== "checkbox") return;
      const id = box.value;
      let keys = (state.setSortKeys || []).slice();
      if (box.checked) {
        if (keys.indexOf(id) < 0) keys.push(id);
      } else keys = keys.filter((k) => k !== id);
      state.setSortKeys = keys;
      keepSetFilterPop = true;
      renderMaterials();
      keepSetFilterPop = false;
      return;
    }
    syncFacetBtn(root);
    const tr = root.closest("tr");
    if (!tr) return;
    const mat = matById(tr.dataset.id); if (!mat) return;
    const field = root.dataset.field;
    const values = checkedValues(root);
    mat[field] = values;
    await api.updateMaterial(mat.id, { [field]: values });
  });

  // Materials table: inline edit → PATCH; slot change → PATCH; Remove → DELETE; ID → drawer; pin → renderPin
  $("#materials-table tbody").addEventListener("focusout", async (e) => {
    const cell = e.target.closest("[data-field]"); const tr = e.target.closest("tr");
    if (!cell || !tr || cell.matches("select, input")) return;
    const m = matById(tr.dataset.id); if (!m) return;
    const v = cell.tagName === "TEXTAREA" ? cell.value.trim() : cell.textContent.trim(); if (m[cell.dataset.field] === v) return;
    m[cell.dataset.field] = v; await api.updateMaterial(m.id, { [cell.dataset.field]: v });
    if (cell.dataset.field === "name") { renderLinks(); renderPin(); }
  });
  $("#materials-table tbody").addEventListener("change", async (e) => {
    const fileIn = e.target.closest("input[data-sketch-file]");
    if (fileIn && fileIn.files && fileIn.files[0]) {
      try {
        if (state.hitlSession) {
          const file = fileIn.files[0];
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          await api.hitlPost(state.hitlSession, { upload: { filename: file.name, mime: file.type || "application/octet-stream", data } });
          fileIn.value = "";
          toast("Picture held until agree");
          return;
        }
        const m = await api.uploadSketch(fileIn.dataset.sketchFile, fileIn.files[0]);
        fileIn.value = "";
        const i = state.materials.findIndex((x) => x.id === m.id);
        if (i >= 0) state.materials[i] = Object.assign(state.materials[i], m);
        renderMaterials();
        if (state.drawerId === m.id) paintDrawerPic(matById(m.id));
        toast("Picture attached");
      } catch (err) {
        toast(String(err.message || err).slice(0, 180));
      }
      return;
    }
    const durIn = e.target.closest("input[data-field=duration]");
    if (durIn) {
      const tr = e.target.closest("tr"); if (!tr) return;
      const mat = matById(tr.dataset.id); if (!mat) return;
      const n = matDuration({ ...mat, duration: Number(durIn.value) });
      durIn.value = String(n);
      if (mat.duration === n) return;
      mat.duration = n;
      await api.updateMaterial(mat.id, { duration: n });
      await renderTimeline();
      return;
    }
  });
  $("#materials-table tbody").addEventListener("click", async (e) => {
    const polish = e.target.closest("[data-polish]");
    if (polish) {
      e.stopPropagation();
      const tr = polish.closest("tr"); if (!tr) return;
      const m = matById(tr.dataset.id); if (!m) return;
      if (polish.dataset.polish === "name") {
        const cell = tr.querySelector("[data-field=name]"); if (!cell) return;
        await polishInto(cell, polish, "name", m.id + " " + m.name, async (text) => {
          m.name = text;
          await api.updateMaterial(m.id, { name: text });
          renderLinks(); renderPin();
        });
        return;
      }
      const cell = tr.querySelector("[data-field=look], [data-field=notes]"); if (!cell) return;
      const field = cell.dataset.field === "notes" ? "notes" : "look";
      const kind = field === "notes" ? "explanation" : "look";
      await polishInto(cell, polish, kind, m.id + " " + m.name, async (text) => {
        m[field] = text;
        await api.updateMaterial(m.id, { [field]: text });
      });
      return;
    }
    const del = e.target.closest("[data-del-mat]");
    if (del) { const id = del.dataset.delMat; if (!confirm("Remove " + label(id) + " and every link to it?")) return; await api.deleteMaterial(id); await loadGraph(); return; }
    const open = e.target.closest("[data-open]"); if (open) { openDrawer(open.dataset.open, true, open); return; }
    const pin = e.target.closest("[data-pin]");
    if (pin) {
      const id = pin.dataset.pin;
      if (state.addPick) {
        const used = { periodId: state.addPick.periodId, mode: state.addPick.mode, actIndex: state.addPick.actIndex, draft: state.addPick.draft };
        await mutatePeriod(used.periodId, (p) => {
          const acts = periodActs(p);
          if (used.mode === "replace") {
            const i = Number(used.actIndex);
            if (!acts[i] || acts[i].id === id) return;
            const keep = acts[i];
            acts[i] = emptyAct(id, keep.start, keep.end);
            acts[i].easier = keep.easier || [];
            acts[i].harder = keep.harder || [];
            acts[i].alts = keep.alts || [];
            writeActs(p, acts);
            return;
          }
          if (acts.some((a) => a.id === id)) return;
          const last = acts[acts.length - 1];
          const start = last ? last.end : DEFAULT_PERIOD_START;
          acts.push(emptyAct(id, start, addMinutes(start, matDuration(matById(id)))));
          writeActs(p, acts);
        }, { fillObjective: true, draft: used.draft });
        toast(used.mode === "replace" ? "Changed activity" : "Added to period");
        return;
      }
      const m = matById(id); if (!m) return; await pinActivity(m.id);
    }
  });

  // Links table: note/tag edit → PATCH; Remove → DELETE
  $("#links-table tbody").addEventListener("focusout", async (e) => {
    const cell = e.target.closest("[data-field]"); const tr = e.target.closest("tr"); if (!cell || !tr) return;
    const L = state.links.find((x) => x.from === tr.dataset.from && x.kind === tr.dataset.kind && x.to === tr.dataset.to); if (!L) return;
    const v = cell.textContent.trim();
    if (v.includes(":")) { const [tag, ...rest] = v.split(":"); L.tag = tag.trim(); L.note = rest.join(":").trim(); if (L.kind === "related" && !L.tag) return toast("Related to needs a tag"); await api.updateLink(L.from, L.kind, L.to, { tag: L.tag, note: L.note }); }
    else { L.note = v; await api.updateLink(L.from, L.kind, L.to, { note: v, tag: L.tag }); }
    renderPin();
  });
  $("#links-table tbody").addEventListener("click", async (e) => {
    const polish = e.target.closest("[data-polish]");
    if (polish) {
      e.stopPropagation();
      const tr = polish.closest("tr"); if (!tr) return;
      const cell = tr.querySelector("[data-field]"); if (!cell) return;
      const L = state.links.find((x) => x.from === tr.dataset.from && x.kind === tr.dataset.kind && x.to === tr.dataset.to); if (!L) return;
      const ctx = label(L.from) + " " + L.kind + " " + label(L.to);
      await polishInto(cell, polish, "note", ctx, async (text) => {
        if (text.includes(":")) {
          const [tag, ...rest] = text.split(":");
          L.tag = (tag || "").trim();
          L.note = rest.join(":").trim();
          if (L.kind === "related" && !L.tag) return toast("Related to needs a tag");
          await api.updateLink(L.from, L.kind, L.to, { tag: L.tag, note: L.note });
        } else {
          L.note = text;
          await api.updateLink(L.from, L.kind, L.to, { note: text, tag: L.tag });
        }
        renderPin();
      });
      return;
    }
    const btn = e.target.closest("[data-del-link]"); if (!btn) return; const tr = btn.closest("tr");
    await api.deleteLink(tr.dataset.from, tr.dataset.kind, tr.dataset.to); await loadGraph();
  });
  $("#links-table").addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-peek]");
    if (!t) return;
    const tr = t.closest("tr");
    const side = tr && t === tr.cells[0] ? "left" : "right";
    showPeek(t, t.dataset.peek, side, true);
  });
  $("#links-table").addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-peek]");
    if (!t) return;
    const next = e.relatedTarget;
    const pk = $("#peek-drawer");
    if (next && (t.contains(next) || (pk && pk.contains(next)))) return;
    hidePeekSoon();
  });

  async function polishInto(target, btn, kind, context, save) {
    const draft = ("value" in target ? target.value : target.textContent).trim();
    let ctx = context;
    if (kind === "look" || kind === "name") {
      const mm = /\b(M\d+)\b/.exec(String(context || ""));
      const id = mm ? mm[1] : "";
      if (id) {
        const n = neighborsOf(id, state.links);
        const cap = 4;
        const withLook = (hops) => hops.slice(0, cap).map((h) => {
          const card = matById(h.id);
          return {
            id: h.id,
            name: card ? card.name : h.id,
            look: ((card && card.look) || "").slice(0, 240),
            hopNote: h.note || "",
          };
        });
        ctx = JSON.stringify({
          title: context || "",
          chain: {
            easier: withLook(n.regression),
            harder: withLook(n.progression),
            related: n.related.slice(0, cap).map((h) => {
              const card = matById(h.id);
              const row = { id: h.id, name: card ? card.name : h.id };
              if (h.tag) row.tag = h.tag;
              return row;
            }),
          },
        });
      }
    }
    if (kind === "explanation") {
      const ids = [];
      const re = /@M(\d+)/g;
      let mm;
      while ((mm = re.exec(draft))) {
        const id = "M" + mm[1];
        if (ids.indexOf(id) < 0) ids.push(id);
      }
      const tagged = ids.map((id) => {
        const card = matById(id);
        if (!card) return null;
        return { id: card.id, name: card.name, look: card.look || "", notes: matExplain(card) };
      }).filter(Boolean);
      ctx = JSON.stringify({ title: context || "", tagged });
    }
    if (!draft) return toast("Write something first");
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "…";
    try {
      let text = (await api.polish(kind, draft, ctx)).text;
      if ((kind === "note") && target.dataset && target.dataset.field === "tag" && draft.includes(":") && !text.includes(":")) {
        text = draft.split(":")[0].trim() + ": " + text;
      }
      if ("value" in target) target.value = text;
      else target.textContent = text;
      if (save) await save(text);
      toast("Polished");
    } catch (err) {
      toast(String(err.message || err).slice(0, 180));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
  $("#peek-name-polish")?.addEventListener("click", async () => {
    const m = matById(state.peekId);
    await polishInto($("#peek-title"), $("#peek-name-polish"), "name", m ? (m.id + " " + m.name) : "", async (text) => {
      if (!m) return;
      m.name = text;
      await api.updateMaterial(m.id, { name: text });
      renderMaterials();
      renderLinks();
      renderPin();
    });
  });
  $("#dr-name-polish")?.addEventListener("click", async () => {
    const m = matById(state.drawerId);
    await polishInto($("#dr-title"), $("#dr-name-polish"), "name", m ? (m.id + " " + m.name) : "", async (text) => {
      if (!m) return;
      m.name = text;
      await api.updateMaterial(m.id, { name: text });
      renderMaterials();
      renderLinks();
      renderPin();
    });
  });
  $("#peek-look-polish")?.addEventListener("click", async () => {
    const m = matById(state.peekId);
    await polishInto($("#peek-look"), $("#peek-look-polish"), "look", m ? (m.id + " " + m.name) : "");
  });
  $("#peek-notes-polish")?.addEventListener("click", async () => {
    const m = matById(state.peekId);
    await polishInto($("#peek-notes"), $("#peek-notes-polish"), "explanation", m ? (m.id + " " + m.name) : "");
  });
  $("#dr-look-polish")?.addEventListener("click", async () => {
    const m = matById(state.drawerId);
    await polishInto($("#dr-look"), $("#dr-look-polish"), "look", m ? (m.id + " " + m.name) : "");
  });
  $("#dr-notes-polish")?.addEventListener("click", async () => {
    const m = matById(state.drawerId);
    await polishInto($("#dr-notes"), $("#dr-notes-polish"), "explanation", m ? (m.id + " " + m.name) : "");
  });
    ["#dr-notes", "#peek-notes"].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    bindNoteMentions(el, {
      onSearch: (q) => api.search(q, 12),
      materials: () => state.materials,
      onPeek: (id, anchor) => showPeek(anchor, id, "right", true),
      onPeekLeave: hidePeekSoon,
    });
  });
  $("#filter").addEventListener("input", (e) => { state.filter = e.target.value.trim().toLowerCase(); renderMaterials(); renderLinks(); });
  let nameQSeq = 0;
  let nameQTimer = 0;
  $("#name-q").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    state.nameQ = q.toLowerCase();
    clearTimeout(nameQTimer);
    const seq = ++nameQSeq;
    if (!q) {
      state.nameQHits = null;
      renderMaterials();
      return;
    }
    nameQTimer = setTimeout(async () => {
      const res = await api.search(q, 12);
      if (seq !== nameQSeq) return;
      const keyword = res.keyword || [];
      const semantic = res.semantic || [];
      const ids = [];
      keyword.forEach((h) => { if (ids.indexOf(h.id) < 0) ids.push(h.id); });
      semantic.forEach((h) => { if (ids.indexOf(h.id) < 0) ids.push(h.id); });
      state.nameQHits = ids;
      renderMaterials();
    }, 220);
  });
  $("#materials-table tbody").addEventListener("dragstart", (e) => {
    const grip = e.target.closest("[data-he-sort-drag]");
    if (!grip || !e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", grip.dataset.heSortDrag);
    e.dataTransfer.effectAllowed = "move";
    closeHopFlyout();
    closePeek();
  });
  $("#materials-table tbody").addEventListener("dragover", (e) => {
    const path = e.target.closest(".he-path[data-he-path]");
    const cell = path && path.closest(".he-cell");
    if (!path || !cell) return;
    e.preventDefault();
    cell.querySelectorAll(".he-path.he-drop").forEach((n) => { if (n !== path) n.classList.remove("he-drop"); });
    path.classList.add("he-drop");
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  });
  $("#materials-table tbody").addEventListener("dragleave", (e) => {
    const path = e.target.closest(".he-path");
    if (path && !path.contains(e.relatedTarget)) path.classList.remove("he-drop");
  });
  $("#materials-table tbody").addEventListener("drop", (e) => {
    const path = e.target.closest(".he-path[data-he-path]");
    const tr = path && path.closest("tr");
    if (!path || !tr || !e.dataTransfer) return;
    e.preventDefault();
    path.classList.remove("he-drop");
    const from = e.dataTransfer.getData("text/plain");
    const to = path.dataset.hePath;
    if (!from || from === to) return;
    const m = matById(tr.dataset.id);
    if (!m) return;
    const listed = [...tr.querySelectorAll(".he-path[data-he-path]")].map((n) => n.dataset.hePath);
    const i = listed.indexOf(from);
    const j = listed.indexOf(to);
    if (i < 0 || j < 0) return;
    listed[i] = to;
    listed[j] = from;
    if (!state.pathOrder) state.pathOrder = {};
    state.pathOrder[m.id] = listed;
    renderMaterials();
  });
  $("#materials-table")?.addEventListener("change", (e) => {
    if (!e.target || e.target.id !== "mat-text-col") return;
    state.matText = e.target.value === "notes" ? "notes" : "look";
    renderMaterials();
    if (state.peekId) fillPeek(state.peekId, "peek");
    if (state.drawerId) fillPeek(state.drawerId, "dr");
  });
  $("#materials-table tbody").addEventListener("click", async (e) => {
    if (e.target.closest("[data-he-sort-drag]")) return;
    const drop = e.target.closest("[data-he-drop]");
    if (drop) {
      e.stopPropagation();
      const tr = drop.closest("tr");
      const set = state.sets.find((s) => s.id === drop.dataset.heDrop);
      const id = tr && tr.dataset.id;
      if (!set || !id) return;
      const y = window.scrollY;
      await api.updateSet(set.id, { members: set.members.filter((m) => m !== id) });
      await loadGraph({ skipTimeline: true });
      window.scrollTo(0, y);
      return;
    }
    const span = e.target.closest("[data-set]");
    if (span) {
      showSetMemberFly(span, span.dataset.set);
      hopFlyMoved = true;
      return;
    }
    if (e.target.closest("select, .he-x")) return;
  });
  $("#materials-table tbody").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-add-set]");
    if (!sel || !sel.value) return;
    const set = state.sets.find((s) => s.id === sel.value);
    if (!set) return;
    const id = sel.dataset.addSet;
    if (set.members.includes(id)) return;
    const y = window.scrollY;
    await api.updateSet(set.id, { members: [...set.members, id] });
    await loadGraph({ skipTimeline: true });
    window.scrollTo(0, y);
  });
  $("#materials-table tbody").addEventListener("mouseover", (e) => {
    if (e.target.closest("[data-he-sort-drag], .he-sort-drag")) return;
    const span = e.target.closest("[data-set]");
    if (!span) return;
    showSetMemberFly(span, span.dataset.set, true);
  });
  $("#materials-table tbody").addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-he-sort-drag], .he-sort-drag")) return;
    const span = e.target.closest("[data-set]");
    if (!span) return;
    const next = e.relatedTarget;
    const fly = $("#hop-flyout");
    if (next && (span.contains(next) || (fly && fly.contains(next)))) return;
    hideHopFlySoon();
  });
  $("#back-to-tl").addEventListener("click", backToTimeline);

  // Export: template downloads the JSON mirror. Server version: GET /api/export → zip of library/.
  $("#export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ materials: state.materials, links: state.links, foci: state.foci }, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "flag-library.json" }); a.click();
  });

  /* ---------------- NODE DRAWER (neighbours + notes + sketch) ---------------- */
  const drawerHome = $("#drawer") && $("#drawer").parentElement;
  function parkDrawer() {
    const dr = $("#drawer"); if (!dr || !drawerHome) return;
    clearTimeout(drawerShowT);
    if (dr.parentElement !== drawerHome) drawerHome.appendChild(dr);
    dr.classList.remove("open", "float");
    state.drawerAnchor = null;
    state.drawerId = null;
    dr.style.left = dr.style.top = dr.style.right = dr.style.width = dr.style.height = dr.style.maxWidth = dr.style.maxHeight = dr.style.bottom = "";
    closePicChooser();
    closeHopFlyout();
    closePeek();
  }
  function overlayOpen(el) {
    return !!(el && !el.hidden && (el.classList.contains("open") || el.classList.contains("float")));
  }
  function boxesOverlap(a, b, pad) {
    pad = pad || 0;
    return a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
  }
  function overlayEls() { return [$("#drawer"), $("#peek-drawer"), $("#hop-flyout")]; }
  function applyOverlayBox(el) {
    if (!el) return;
    const s = overlaySize();
    el.style.width = s.w + "px";
    el.style.height = s.h + "px";
    el.style.maxWidth = s.w + "px";
    el.style.maxHeight = s.h + "px";
  }
  function syncOpenOverlayBoxes() {
    overlayEls().forEach((el) => { if (overlayOpen(el)) applyOverlayBox(el); });
  }
  function otherOverlays(el) {
    return [$("#drawer"), $("#peek-drawer"), $("#hop-flyout")].filter((o) => o && o !== el && overlayOpen(o));
  }
  function separateOverlays(el) {
    if (!el || !overlayOpen(el)) return;
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const others = otherOverlays(el);
    const preferLeft = el.id === "peek-drawer"
      ? state.peekSide !== "right"
      : el.id === "hop-flyout" && state.hopFly && state.hopFly.side === "left";
    for (let n = 0; n < 8; n++) {
      const r = el.getBoundingClientRect();
      const hit = others.find((o) => boxesOverlap(r, o.getBoundingClientRect(), gap));
      if (!hit) return;
      const o = hit.getBoundingClientRect();
      const dw = r.width;
      const dh = r.height;
      const opts = preferLeft
        ? [[o.left - dw - gap, o.top], [o.right + gap, o.top], [o.left, o.bottom + gap], [o.left, o.top - dh - gap]]
        : [[o.right + gap, o.top], [o.left - dw - gap, o.top], [o.left, o.bottom + gap], [o.left, o.top - dh - gap]];
      let moved = false;
      for (const [rawL, rawT] of opts) {
        const L = Math.max(12, Math.min(rawL, vw - dw - 12));
        const T = Math.max(12, Math.min(rawT, vh - dh - 12));
        if (!boxesOverlap({ left: L, right: L + dw, top: T, bottom: T + dh }, o, gap)) {
          el.style.left = Math.round(L) + "px";
          el.style.top = Math.round(T) + "px";
          el.style.bottom = "auto";
          moved = true;
          break;
        }
      }
      if (!moved) {
        el.style.top = Math.round(Math.max(12, Math.min(o.bottom + gap, vh - dh - 12))) + "px";
        el.style.bottom = "auto";
      }
    }
  }
  function placePanel(el, anchor, side) {
    if (!el || !anchor || !document.contains(anchor)) return;
    if (el.id === "peek-drawer" && peekMoved) {
      applyOverlayBox(el);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = overlaySize();
    applyOverlayBox(el);
    const dw = s.w;
    const dh = s.h;
    const preferLeft = side === "left" || (side !== "right" && !!anchor.closest(".side"));
    let left = preferLeft ? r.left - dw - gap : r.right + gap;
    if (left + dw > vw - 12) left = r.left - dw - gap;
    if (left < 12) left = Math.min(r.right + gap, Math.max(12, vw - dw - 12));
    let top = r.top;
    if (top + dh > vh - 12) top = Math.max(12, vh - dh - 12);
    if (top < 12) top = 12;
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.bottom = "auto";
    separateOverlays(el);
  }
  function placeDrawer(dr, anchor) { placePanel(dr, anchor); }
  document.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-ov-resize]");
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    keepPeek();
    keepHopFly();
    const startX = e.clientX, startY = e.clientY;
    const start = overlaySize();
    const move = (ev) => {
      keepPeek();
      keepHopFly();
      const next = clampOverlay(start.w + ev.clientX - startX, start.h + ev.clientY - startY);
      state.overlayW = next.w;
      state.overlayH = next.h;
      syncOpenOverlayBoxes();
      overlayEls().forEach((el) => { if (overlayOpen(el)) separateOverlays(el); });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("ov-resizing");
      saveOverlaySize();
      overlayEls().forEach((el) => { if (overlayOpen(el)) separateOverlays(el); });
    };
    document.body.classList.add("ov-resizing");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  let peekHideT = 0;
  let peekShowT = 0;
  let drawerShowT = 0;
  let peekMoved = false;
  let peekDrag = null;
  function keepPeek() { clearTimeout(peekHideT); }
  function picZoomOpen() {
    const box = $("#pic-zoom");
    return !!(box && !box.hidden && box.classList.contains("open"));
  }
  function closePicZoom() {
    const box = $("#pic-zoom"); if (!box) return;
    box.classList.remove("open");
    box.hidden = true;
    const img = $("#pic-zoom-img");
    const vid = $("#pic-zoom-vid");
    const player = $("#pic-zoom-player");
    const seek = $("#pic-zoom-seek");
    if (img) img.removeAttribute("src");
    if (vid) { vid.pause(); vid.removeAttribute("src"); }
    if (player) player.hidden = true;
    if (seek) seek.value = "0";
  }
  function openPicZoom(src) {
    if (!src) return;
    keepPeek();
    const box = $("#pic-zoom"); const img = $("#pic-zoom-img"); const vid = $("#pic-zoom-vid");
    const player = $("#pic-zoom-player");
    const seek = $("#pic-zoom-seek");
    if (!box || !img) return;
    if (sketchIsVideo(src)) {
      img.hidden = true;
      img.removeAttribute("src");
      if (player) player.hidden = false;
      if (seek) seek.value = "0";
      if (vid) {
        vid.src = src;
        vid.currentTime = 0;
      }
    } else {
      if (vid) { vid.pause(); vid.removeAttribute("src"); }
      if (player) player.hidden = true;
      img.hidden = false;
      img.src = src;
    }
    document.body.appendChild(box);
    box.hidden = false;
    box.classList.add("open");
  }
  function zoomablePic(el) {
    if (!el || el.hidden) return "";
    if (el.tagName !== "IMG" && el.tagName !== "VIDEO") return "";
    return el.currentSrc || el.src || "";
  }
  function closePeek() {
    if (picZoomOpen()) return;
    closePicZoom();
    const pk = $("#peek-drawer"); if (!pk) return;
    keepPeek();
    clearTimeout(peekShowT);
    pk.classList.remove("open", "float", "hop-dragging");
    pk.hidden = true;
    peekMoved = false;
    peekDrag = null;
    state.peekId = null;
    state.peekAnchor = null;
    state.peekSide = null;
    pk.style.left = pk.style.top = pk.style.right = pk.style.width = pk.style.height = pk.style.maxWidth = pk.style.maxHeight = pk.style.bottom = "";
  }
  function hidePeekSoon() {
    if (document.body.classList.contains("ov-resizing")) return;
    if (picZoomOpen()) return;
    if (peekMoved || peekDrag) return;
    clearTimeout(peekShowT);
    clearTimeout(peekHideT);
    peekHideT = setTimeout(() => closePeek(), 280);
  }
  function setPeekEditable(on) {
    ["peek-save", "peek-name-polish", "peek-look-polish", "peek-notes-polish", "peek-cn-add"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.hidden = !on;
    });
    ["peek-look", "peek-notes"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.readOnly = !on;
    });
  }
  function pendingLabel(id) {
    const op = (state.pendingOps || []).find((o) => o.tempId === id && o.entity === "material" && o.action === "create");
    if (op) return op.name || id;
    const m = matById(id);
    return m ? m.id + " " + m.name : id;
  }
  function fillPendingPeek(id, pfx) {
    const ops = state.pendingOps || [];
    let op = ops.find((o) => o.tempId === id);
    if (!op && String(id).includes("|")) {
      const parts = String(id).split("|");
      op = ops.find((o) => o.entity === "link" && o.from === parts[0] && o.kind === parts[1] && o.to === parts[2]) || { entity: "link", from: parts[0], kind: parts[1], to: parts[2], note: "" };
    }
    if (!op) return false;
    if (pfx === "peek") state.peekId = id;
    setPeekEditable(false);
    const title = $("#" + pfx + "-title");
    const lookEl = $("#" + pfx + "-look");
    const notes = $("#" + pfx + "-notes");
    if (op.entity === "link") {
      if (title) title.textContent = pendingLabel(op.from) + " → " + pendingLabel(op.to);
      if (lookEl) lookEl.value = op.kind || "progression";
      if (notes) notes.value = op.note || "";
    } else {
      if (title) title.textContent = (op.tempId || id) + " · " + (op.name || "Picture");
      if (lookEl) lookEl.value = op.look || "";
      if (notes) notes.value = op.notes || op.sketch || "";
      const sketch = op.sketch ? op : ops.find((o) => o.entity === "material" && o.action === "update" && o.sketch && (o.id === id || o.id === op.tempId));
      const nameEl = $("#peek-pic-name");
      if (nameEl) nameEl.textContent = sketch && sketch.sketch ? String(sketch.sketch).split("/").pop() : "Draft";
      const empty = $("#peek-pic-empty");
      if (empty) empty.hidden = false;
    }
    const nb = $("#" + pfx + "-neighbors");
    if (nb) nb.replaceChildren();
    return true;
  }
  function fillPeek(id, prefix) {
    const pfx = prefix || "peek";
    const m = matById(id);
    if (!m) return fillPendingPeek(id, pfx);
    setPeekEditable(true);
    if (pfx === "peek") state.peekId = id;
    else state.drawerId = id;
    const title = $("#" + pfx + "-title");
    if (title) title.textContent = m.id + " · " + m.name + " · " + matDuration(m) + " min · " + (m.motorSkills.join(", ") || "—");
    paintNeighbors($("#" + pfx + "-neighbors"), id);
    const lookEl = $("#" + pfx + "-look");
    if (lookEl) lookEl.value = m.look || "";
    const notes = $("#" + pfx + "-notes");
    if (notes) notes.value = m.notes || "";
    const saveBtn = $("#" + pfx + "-save");
    if (saveBtn) {
      const iso = ($("#p-date") && $("#p-date").value) || "";
      const dt = iso ? new Date(iso + "T00:00:00") : null;
      const day = dt && !isNaN(dt.getTime()) ? dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
      saveBtn.textContent = day ? "Save · " + day : "Save";
    }
    if (pfx === "peek") paintPicEls($("#peek-img"), $("#peek-pic-empty"), $("#peek-pic-name"), m);
    else paintDrawerPic(m);
    const host = $("#" + pfx + "-class-notes");
    if (host) {
      host.replaceChildren();
      const rows = [...(m.classNotes || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(a.grade).localeCompare(String(b.grade)));
      rows.forEach((row) => {
        const d = el("details", { class: "class-note-day" });
        const dt = new Date((row.date || "") + "T00:00:00");
        const lab = (isNaN(dt.getTime()) ? row.date : dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })) + " · " + row.grade;
        d.append(el("summary", {}, lab));
        const ta = el("textarea", { "data-class-note": "1", "data-id": m.id, "data-date": row.date, "data-grade": row.grade });
        ta.value = row.text || "";
        d.append(ta);
        host.append(d);
      });
    }
    const dateEl = $("#" + pfx + "-cn-date");
    const gradeEl = $("#" + pfx + "-cn-grade");
    if (dateEl) dateEl.value = $("#p-date") && $("#p-date").value || "";
    const g = $("#p-grade") && $("#p-grade").value || "G6";
    if (gradeEl) gradeEl.value = g;
    return true;
  }
  async function persistClassNote(id, date, grade, text) {
    const m = matById(id); if (!m || !date || grade === "all" || !GRADE_TOKEN.test(grade)) return;
    const rows = [...(m.classNotes || [])];
    const i = rows.findIndex((r) => r.date === date && r.grade === grade);
    const t = String(text || "").trim();
    if (!t) { if (i >= 0) rows.splice(i, 1); }
    else if (i >= 0) rows[i] = { date, grade, text: t };
    else rows.push({ date, grade, text: t });
    m.classNotes = rows;
    const updated = await api.updateMaterial(m.id, { classNotes: rows });
    Object.assign(m, updated);
  }
  document.addEventListener("focusout", async (e) => {
    const ta = e.target && e.target.closest && e.target.closest("[data-class-note]");
    if (!ta) return;
    await persistClassNote(ta.dataset.id, ta.dataset.date, ta.dataset.grade, ta.value);
    if (!String(ta.value || "").trim()) {
      const day = ta.closest(".class-note-day");
      if (day) day.remove();
    }
  });
  function addClassNoteRow(prefix) {
    const id = prefix === "dr" ? state.drawerId : state.peekId;
    const m = matById(id); if (!m) return;
    const date = ($("#" + prefix + "-cn-date") || {}).value;
    const grade = ($("#" + prefix + "-cn-grade") || {}).value || "G6";
    if (!date) return;
    const host = $("#" + prefix + "-class-notes"); if (!host) return;
    const existing = host.querySelector('textarea[data-date="' + date + '"][data-grade="' + grade + '"]');
    if (existing) { const d = existing.closest("details"); if (d) d.open = true; existing.focus(); return; }
    const d = el("details", { class: "class-note-day" });
    d.open = true;
    const dt = new Date(date + "T00:00:00");
    const lab = (isNaN(dt.getTime()) ? date : dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })) + " · " + grade;
    d.append(el("summary", {}, lab));
    const ta = el("textarea", { "data-class-note": "1", "data-id": m.id, "data-date": date, "data-grade": grade });
    d.append(ta);
    host.prepend(d);
    ta.focus();
  }
  $("#dr-cn-add")?.addEventListener("click", () => addClassNoteRow("dr"));
  $("#peek-cn-add")?.addEventListener("click", () => addClassNoteRow("peek"));
  function showPeek(anchor, id, side, dwell) {
    keepPeek();
    keepHopFly();
    if (dwell) {
      clearTimeout(peekShowT);
      peekShowT = setTimeout(() => showPeek(anchor, id, side), HOVER_DWELL_MS);
      return;
    }
    const pk = $("#peek-drawer"); if (!pk || !anchor) return;
    const same = state.peekId === id && pk.classList.contains("open") && state.peekSide === side;
    if (!same && !fillPeek(id)) return;
    document.body.appendChild(pk);
    state.peekAnchor = anchor;
    state.peekSide = side;
    pk.hidden = false;
    pk.classList.add("float", "open");
    placePanel(pk, state.peekAnchor, state.peekSide);
    requestAnimationFrame(() => {
      placePanel(pk, state.peekAnchor, state.peekSide);
      const dr = $("#drawer");
      if (dr && dr.classList.contains("open") && dr.classList.contains("float")) separateOverlays(dr);
      const fly = $("#hop-flyout");
      if (overlayOpen(fly)) separateOverlays(pk);
    });
  }
  function openDrawer(id, asFloat, anchor, dwell) {
    if (dwell) {
      clearTimeout(drawerShowT);
      drawerShowT = setTimeout(() => openDrawer(id, asFloat, anchor), HOVER_DWELL_MS);
      return;
    }
    const m = matById(id); if (!m) return;
    if (!fillPeek(id, "dr")) return;
    const dr = $("#drawer");
    document.body.appendChild(dr);
    if (anchor) state.drawerAnchor = anchor;
    dr.classList.add("float", "open");
    requestAnimationFrame(() => {
      if (state.drawerAnchor) placeDrawer(dr, state.drawerAnchor);
      else {
        const s = overlaySize();
        dr.style.width = s.w + "px";
        dr.style.height = s.h + "px";
        dr.style.maxWidth = s.w + "px";
        dr.style.maxHeight = s.h + "px";
        dr.style.left = "24px";
        dr.style.top = "auto";
        dr.style.bottom = "24px";
      }
      const pk = $("#peek-drawer");
      if (overlayOpen(pk)) separateOverlays(pk);
      const fly = $("#hop-flyout");
      if (overlayOpen(fly)) separateOverlays(fly);
    });
  }
  $("#dr-neighbors").addEventListener("click", (e) => { const t = e.target.closest("[data-open]"); if (t) openDrawer(t.dataset.open, $("#drawer").classList.contains("float"), t); });
  $("#dr-neighbors").addEventListener("mouseover", (e) => {
    if (!state.drawerId) return;
    lastPtr.x = e.clientX;
    lastPtr.y = e.clientY;
    const node = e.target.closest("#dr-neighbors .id[data-open]");
    if (node) {
      const box = node.closest("[data-nb]");
      const k = box && box.dataset.nb;
      const side = k === "progression" ? "right" : "left";
      closeHopFlyout();
      showPeek(node, node.dataset.open, side, true);
      return;
    }
    const lab = e.target.closest("#dr-neighbors [data-nb] > b");
    if (!lab) return;
    const box = lab.closest("[data-nb]");
    if (!box) return;
    const k = box.dataset.nb;
    if (k !== "regression" && k !== "progression" && k !== "related") return;
    const side = k === "progression" ? "right" : "left";
    const only = k === "regression" ? ["easier"] : k === "progression" ? ["harder"] : ["alts"];
    closePeek();
    showHopFlyout($("#drawer"), {
      p: null, act: emptyAct(state.drawerId), actIndex: 0,
      side, only, tickable: false
    }, true);
  });
  $("#dr-neighbors").addEventListener("mouseleave", hideDockedHopSoon);
  const peekDrawer = $("#peek-drawer");
  if (peekDrawer) {
    peekDrawer.addEventListener("mouseenter", () => { keepPeek(); keepHopFly(); });
    peekDrawer.addEventListener("mouseleave", (e) => {
      if (picZoomOpen() || (e.relatedTarget && $("#pic-zoom")?.contains(e.relatedTarget))) { keepPeek(); return; }
      if (e.relatedTarget && $("#hop-flyout")?.contains(e.relatedTarget)) { keepPeek(); return; }
      hidePeekSoon();
    });
    peekDrawer.addEventListener("click", (e) => {
      const t = e.target.closest("[data-open]");
      if (t) openDrawer(t.dataset.open, true, t);
    });
    const peekTop = $("#peek-top") || peekDrawer;
    peekTop.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, textarea, select, [data-ov-resize], a")) return;
      keepPeek();
      keepHopFly();
      const r = peekDrawer.getBoundingClientRect();
      peekDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, pointer: e.pointerId };
      peekDrawer.classList.add("hop-dragging");
      try { peekDrawer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });
    peekDrawer.addEventListener("pointermove", (e) => {
      if (!peekDrag || e.pointerId !== peekDrag.pointer) return;
      keepPeek();
      keepHopFly();
      const w = peekDrawer.offsetWidth;
      const h = peekDrawer.offsetHeight;
      let left = e.clientX - peekDrag.dx;
      let top = e.clientY - peekDrag.dy;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      peekDrawer.style.left = Math.round(left) + "px";
      peekDrawer.style.top = Math.round(top) + "px";
      peekMoved = true;
    });
    peekDrawer.addEventListener("pointerup", (e) => {
      if (!peekDrag || e.pointerId !== peekDrag.pointer) return;
      peekDrag = null;
      peekDrawer.classList.remove("hop-dragging");
    });
    peekDrawer.addEventListener("pointercancel", (e) => {
      if (!peekDrag || e.pointerId !== peekDrag.pointer) return;
      peekDrag = null;
      peekDrawer.classList.remove("hop-dragging");
    });
  }
  document.addEventListener("click", (e) => {
    const z = $("#pic-zoom");
    if (picZoomOpen() && z && z.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      const player = $("#pic-zoom-player");
      const vid = $("#pic-zoom-vid");
      if (e.target.closest("#pic-zoom-seek")) return;
      if (vid && player && !player.hidden && (e.target === vid || vid.contains(e.target))) {
        if (vid.paused) vid.play();
        else vid.pause();
        return;
      }
      if (e.target.closest("#pic-zoom-player")) return;
      closePicZoom();
      return;
    }
    if (e.target.closest("input[type=file], label.file-btn")) return;
    const media = e.target.closest("#peek-img, #dr-img, video.pic-media, #materials-table .thumb, .tl-doc img, .tl-doc video, .tl-act img, .tl-act video, .tl-today-pic, .kg-pic");
    if (!media) return;
    const src = zoomablePic(media);
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    openPicZoom(src);
  }, true);
  {
    const vid = $("#pic-zoom-vid");
    const seek = $("#pic-zoom-seek");
    if (vid && seek) {
      let scrub = false;
      const setBar = () => {
        if (scrub || !vid.duration) return;
        seek.value = String(Math.round((vid.currentTime / vid.duration) * 1000));
      };
      vid.addEventListener("timeupdate", setBar);
      vid.addEventListener("loadedmetadata", setBar);
      seek.addEventListener("pointerdown", () => { scrub = true; });
      seek.addEventListener("input", () => {
        if (!vid.duration) return;
        vid.currentTime = (Number(seek.value) / 1000) * vid.duration;
      });
      const endScrub = () => { scrub = false; setBar(); };
      seek.addEventListener("pointerup", endScrub);
      seek.addEventListener("pointercancel", endScrub);
      seek.addEventListener("change", endScrub);
    }
  }
  $("#pic-zoom")?.addEventListener("mouseenter", keepPeek);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#pic-zoom")?.classList.contains("open")) {
      e.preventDefault();
      closePicZoom();
    }
  });
  $("#peek-back")?.addEventListener("click", (e) => { e.stopPropagation(); closePeek(); });
  $("#hop-fly-back")?.addEventListener("click", (e) => { e.stopPropagation(); closeHopFlyout(); });
  $("#peek-close").addEventListener("click", closePeek);
  $("#peek-save").addEventListener("click", async () => {
    const id = state.peekId; const m = matById(id); if (!m) return;
    if ($("#peek-look")) m.look = $("#peek-look").value;
    if ($("#peek-notes")) m.notes = $("#peek-notes").value;
    await api.updateMaterial(m.id, { look: m.look, notes: m.notes });
    toast("Saved");
    if (state.drawerId === m.id) {
      if ($("#dr-look")) $("#dr-look").value = m.look;
      if ($("#dr-notes")) $("#dr-notes").value = m.notes;
    }
    renderMaterials();
  });
  document.addEventListener("mousedown", (e) => {
    const pk = $("#peek-drawer");
    if (!pk || !pk.classList.contains("open")) return;
    if (pk.contains(e.target)) return;
    if (e.target.closest(".tl-hops .chip, #hop-flyout, #drawer, .mat-combo, .mat-combo-pop, #links-table [data-peek], #pic-zoom")) return;
    closePeek();
  });
  $("#dr-close").addEventListener("click", parkDrawer);
  document.addEventListener("mousedown", (e) => {
    const dr = $("#drawer");
    if (!dr || !dr.classList.contains("open")) return;
    if (dr.contains(e.target)) return;
    if (e.target.closest("[data-open], [data-tl-tick], [data-tl-pin], [data-peek], [data-hop], [data-sketch-file], .pic-attach, .file-btn, #pic-chooser, #dr-pic-replace, #hop-flyout, #peek-drawer")) return;
    parkDrawer();
  });
  document.addEventListener("mousedown", (e) => {
    const fly = $("#hop-flyout");
    if (!overlayOpen(fly)) return;
    if (fly.contains(e.target)) return;
    if (e.target.closest("[data-set], #peek-drawer, #drawer")) return;
    closeHopFlyout();
  });
  $("#dr-save").addEventListener("click", async () => {
    const m = matById(state.drawerId); if (!m) return;
    if ($("#dr-look")) m.look = $("#dr-look").value;
    if ($("#dr-notes")) m.notes = $("#dr-notes").value;
    await api.updateMaterial(m.id, { look: m.look, notes: m.notes });
    toast("Saved");
    if (state.peekId === m.id) {
      if ($("#peek-look")) $("#peek-look").value = m.look;
      if ($("#peek-notes")) $("#peek-notes").value = m.notes;
    }
    renderMaterials();
    openDrawer(m.id, $("#drawer").classList.contains("float"), state.drawerAnchor);
  });
  async function afterSketch(m) {
    const i = state.materials.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      Object.assign(state.materials[i], m);
      if (!m.sketch) state.materials[i].sketch = "";
    }
    renderMaterials();
    if (state.drawerId === m.id) paintDrawerPic(matById(m.id));
    if (state.peekId === m.id) fillPeek(m.id, "peek");
    closePicChooser();
    toast(m.sketch ? "Picture saved" : "Picture removed");
  }
  $("#dr-pic-replace").addEventListener("click", (e) => { e.stopPropagation(); openPicChooser(e.currentTarget); });
  $("#pic-chooser-close").addEventListener("click", closePicChooser);
  $("#pic-chooser-grid").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pick-sketch]");
    if (!btn || !state.drawerId) return;
    await afterSketch(await api.pickSketch(state.drawerId, btn.dataset.pickSketch));
  });
  document.addEventListener("mousedown", (e) => {
    const box = $("#pic-chooser");
    if (!box || !box.classList.contains("open")) return;
    if (box.contains(e.target) || e.target.closest("#dr-pic-replace")) return;
    closePicChooser();
  });
  $("#dr-pic-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f || !state.drawerId) return;
    try {
      await afterSketch(await api.uploadSketch(state.drawerId, f));
    } catch (err) {
      toast(String(err.message || err).slice(0, 180));
    }
  });
  $("#dr-pic-clear").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.drawerId) return;
    try {
      await afterSketch(await api.clearSketch(state.drawerId));
    } catch (err) {
      toast(String(err.message || err).slice(0, 180));
    }
  });

  /** Hover a timeline hop chip, pin-panel hop, or hop-popover row → float the node drawer beside that element. */
  document.querySelector(".shell").addEventListener("mouseover", (e) => {
    if (e.target.closest("#drawer, #peek-drawer, #hop-flyout")) return;
    if (e.target.closest("#timeline .tl-act")) return;
    const t = e.target.closest("[data-tl-pin], [data-tl-tick], [data-hop], [data-peek]");
    if (!t || !t.closest("#timeline, .side")) return;
    const id = t.dataset.tlPin || t.dataset.tlTick || t.dataset.hop || t.dataset.peek;
    if (!id) return;
    if (id !== state.drawerId) openDrawer(id, true, t, true);
    else {
      const dr = $("#drawer");
      dr.classList.add("open", "float");
      if (t !== state.drawerAnchor) { state.drawerAnchor = t; placeDrawer(dr, t); }
    }
  });
  document.querySelector(".shell").addEventListener("mouseout", (e) => {
    if (e.target.closest("#drawer, #peek-drawer, #hop-flyout")) return;
    if (e.target.closest("#timeline .tl-act")) return;
    const t = e.target.closest("[data-tl-pin], [data-tl-tick], [data-hop], [data-peek]");
    if (!t || !t.closest("#timeline, .side")) return;
    const next = e.relatedTarget;
    const dr = $("#drawer");
    if (next && (t.contains(next) || (dr && dr.contains(next)))) return;
    clearTimeout(drawerShowT);
  });
  window.addEventListener("scroll", () => {
    const dr = $("#drawer");
    if (dr && dr.classList.contains("float")) placeDrawer(dr, state.drawerAnchor);
    const fly = $("#hop-flyout");
    if (fly && fly.classList.contains("open") && state.hopFly && state.hopFly.anchor && document.contains(state.hopFly.anchor)) {
      placeHopFlyout(state.hopFly.anchor, state.hopFly.side);
    }
    const pk = $("#peek-drawer");
    if (pk && pk.classList.contains("open") && state.peekAnchor) placePanel(pk, state.peekAnchor, state.peekSide);
  }, true);
  window.addEventListener("resize", () => {
    const c = overlaySize();
    state.overlayW = c.w;
    state.overlayH = c.h;
    syncOpenOverlayBoxes();
    const dr = $("#drawer");
    if (dr && dr.classList.contains("float")) placeDrawer(dr, state.drawerAnchor);
    const fly = $("#hop-flyout");
    if (fly && fly.classList.contains("open") && state.hopFly && state.hopFly.anchor && document.contains(state.hopFly.anchor)) {
      placeHopFlyout(state.hopFly.anchor, state.hopFly.side);
    }
    const pk = $("#peek-drawer");
    if (pk && pk.classList.contains("open") && state.peekAnchor) placePanel(pk, state.peekAnchor, state.peekSide);
  });

  /* ==========================================================================
     RENDER — PANEL 3: PERIOD PIN + HOPS
     ========================================================================== */
  /** currentPeriodId() → "YYYY-MM-DD-G6" from the date + grade pickers; this is the periods/<id>.md file name. UI only. */
  function currentPeriodId() { return $("#p-date").value + "-" + $("#p-grade").value; }

  async function loadPeriod() {
    const key = currentPeriodId(); $("#p-key").textContent = key;
    try { localStorage.setItem(GRADE_KEY, $("#p-grade").value); } catch (e) {}
    state.period = ensureTimes((await api.getPeriod(key)) || { id: key, date: $("#p-date").value, grade: $("#p-grade").value, reflection: { flags: [], text: "" } });
    renderPin(); renderReflection(); renderReads(); await renderTimeline();
  }

  /** pinActivity(id) — append after last activity on the current period. PUT /api/periods/:id */
  async function pinActivity(id) {
    if (!id) return;
    const pid = (state.period && state.period.id) || currentPeriodId();
    let msg = "";
    await mutatePeriod(pid, (p) => {
      const acts = periodActs(p);
      if (acts.some((a) => a.id === id)) { msg = "Already on this period"; return; }
      const last = acts[acts.length - 1];
      const start = last ? last.end : DEFAULT_PERIOD_START;
      const end = addMinutes(start, matDuration(matById(id)));
      acts.push(emptyAct(id, start, end));
      writeActs(p, acts);
      msg = last ? "Added after " + last.id : "Pinned " + id;
    }, { fillObjective: true });
    if (msg) toast(msg);
  }

  /* ==========================================================================
     RENDER — PANEL 5: TIMELINE (this variant only)
     ========================================================================== */

  /** hopKind(prevId, curId) → "start" | "empty" | "repeat" | "harder" | "easier" | "sideways" | "jump"
   *  Pure. Uses neighborsOf() so the classification always agrees with the library's links.
   *  "start"  = first column (nothing before it)      "empty" = one side has nothing pinned
   *  "jump"   = both pinned, different, and no link of any kind between them → the teacher may want to add one. */
  function hopKind(prevId, curId) {
    if (prevId === undefined) return "start";
    if (!prevId || !curId) return "empty";
    if (prevId === curId) return "repeat";
    const n = neighborsOf(prevId);
    if (n.progression.some((x) => x.id === curId)) return "harder";
    if (n.regression.some((x) => x.id === curId)) return "easier";
    if (n.related.some((x) => x.id === curId)) return "sideways";
    return "jump";
  }
  const STEP_GLYPH = { start: "", empty: "·", repeat: "=", harder: "→", easier: "←", sideways: "~", jump: "✕" };
  const STEP_TITLE = { start: "first period", empty: "nothing pinned on one side", repeat: "same node as last period", harder: "progression (one hop harder)", easier: "regression (one hop easier)", sideways: "related / tag", jump: "no link between these two nodes — add one in the library if the step was intended" };

  function placeDock(id, into) {
    const dock = $("#" + id);
    if (!dock) return;
    if (into) { dock.hidden = false; into.appendChild(dock); }
    else {
      const home = $("#dock-home");
      if (home) home.appendChild(dock);
      dock.hidden = true;
    }
  }
  function placeSuggestDock(into) { placeDock("tl-suggest-dock", into); }
  function placeReflDock(into) { placeDock("tl-refl-dock", into); }
  function placeObjDock(into) { placeDock("tl-obj-dock", into); }
  function fillObjDock(p) {
    const ta = $("#tl-obj-text");
    if (!ta) return;
    const saved = p ? String(p.objective || "") : "";
    ta.value = saved;
    ta.defaultValue = saved;
    ta.readOnly = false;
  }
  function fillSavedFoot(foot, r) {
    const fl = el("div", { class: "fl" });
    (r.flags || []).forEach((f) => fl.append(el("span", { class: /hard|fast/.test(f) ? "hard" : "easy" }, f)));
    if (!(r.flags || []).length && !r.text) fl.append(el("span", { class: "mute" }, "no reflection"));
    foot.append(fl);
    if (r.text) foot.append(el("div", { class: "tx", title: r.text }, r.text));
  }
  function paintActClock(p, act, actIndex) {
    const row = el("div", { class: "when" });
    row.append(el("input", { type: "time", "data-tl-clock": "start", "data-tl-period": p.id, "data-tl-act": String(actIndex), value: act.start, title: "Start" }));
    row.append(document.createTextNode("–"));
    row.append(el("input", { type: "time", "data-tl-clock": "end", "data-tl-period": p.id, "data-tl-act": String(actIndex), value: act.end, title: "End" }));
    row.append(document.createTextNode(" · "));
    row.append(el("input", { type: "number", min: "1", max: "99", step: "1", class: "when-mins", "data-tl-clock": "mins", "data-tl-period": p.id, "data-tl-act": String(actIndex), value: String(Math.max(1, Math.min(99, minutesBetween(act.start, act.end)))), title: "Minutes (1–99)" }));
    row.append(document.createTextNode(" min"));
    return row;
  }

  function periodStepPrevId(prev) {
    if (prev === undefined) return undefined;
    const acts = prev ? periodActs(prev) : [];
    return acts.length ? acts[acts.length - 1].id : null;
  }

  function paintPeriodCell(p, prev, stats) {
    const acts = periodActs(p);
    const cell = el("div", { class: "tl-cell" + (acts.length ? " has-mat" : "") });
    cell.dataset.period = p.id;
    cell.dataset.date = p.date;
    if (acts[0]) cell.dataset.mat = acts[0].id;
    const kind = hopKind(periodStepPrevId(prev), acts.length ? acts[0].id : null);
    if (stats && kind in stats) stats[kind]++;
    cell.append(el("span", { class: "tl-step " + kind, title: STEP_TITLE[kind] }, STEP_GLYPH[kind]));
    const body = el("div", { class: "tl-cell-body" });
    const stack = el("div", { class: "tl-acts" });
    if (!acts.length) stack.append(el("div", { class: "nm none" }, "—"));
    else acts.forEach((act, ai) => stack.append(paintActivity(p, act, ai, prev, true)));
    body.append(stack);
    body.append(addActivityRow(p));
    cell.append(body);
    return cell;
  }

  /** renderTimeline() — PANEL 5. Reads api.listPeriods(grade of #p-grade), draws one column per period
   *  plus a dashed ghost column for the next date. Click a date → pickers move → loadPeriod().  UI only. */
  const pinTlPane = () => {
    const timeline = document.getElementById("timeline");
    const head = document.querySelector("#timeline .tl-head");
    const scroller = document.querySelector(".tl-scroll");
    if (!timeline || !head || !scroller) return scroller;
    if ($("#calendar") && !$("#calendar").hidden) return scroller;
    if (document.body.classList.contains("view-table") || document.body.classList.contains("view-hyperedges")) return scroller;
    timeline.scrollIntoView({ block: "start" });
    const hb = head.getBoundingClientRect().bottom;
    const fit = Math.max(240, Math.floor(window.innerHeight - hb - 8));
    const h = state.tlScrollH ? Math.max(240, state.tlScrollH) : fit;
    scroller.style.height = h + "px";
    scroller.style.minHeight = h + "px";
    scroller.style.maxHeight = h + "px";
    return scroller;
  };
  const scrollTlToTarget = (scroller, target) => {
    if (!target) return;
    const pane = pinTlPane() || scroller;
    if (!pane) return;
    const align = () => {
      pane.scrollTop = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    };
    align();
    requestAnimationFrame(align);
  };
  async function renderTimeline() {
    const grade = $("#p-grade").value; $("#tl-grade").textContent = grade;
    const grid = $("#tl-grid");
    try { await renderTimelineInto(grid, grade); }
    catch (err) {
      // UI: never leave the scroller blank — a render bug should be visible, not silent.
      grid.replaceChildren(el("div", { class: "tl-empty" }, "Timeline could not render: " + (err && err.message || err)));
      console.error("renderTimeline", err);
    }
  }
  async function renderTimelineInto(grid, grade) {
    placeSuggestDock(null);
    placeReflDock(null);
    placeObjDock(null);
    const periods = await api.listPeriods(grade);
    const legend = document.querySelector(".tl-legend");
    if (legend) legend.hidden = state.tlMode === "display";
    if (state.tlMode === "display") {
      grid.classList.add("tl-display");
      grid.replaceChildren();
      $("#tl-stats").replaceChildren();
      placeReflDock(null);
      renderReflection();
      const todayIso = isoLocal(new Date());
      const nearest = nearestClassDate(periods, todayIso);
      const displayPeriods = periods.slice();
      if (!displayPeriods.some((p) => p.date === todayIso)) {
        displayPeriods.push(ensureTimes({ id: todayIso + "-" + grade, date: todayIso, grade, reflection: { flags: [], text: "" } }));
        displayPeriods.sort((a, b) => a.date.localeCompare(b.date));
      }
      if (!displayPeriods.length) {
        grid.append(el("div", { class: "tl-empty" }, "No saved periods for " + grade + " yet."));
        return;
      }
      const fmt = (iso) => { const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
      const hopCard = (hop) => {
        const nm = matById(hop.id);
        const card = el("div", { class: "tl-hop-card" });
        card.append(el("div", { class: "nm" }, nm ? nm.name : hop.id));
        const expl = nm && matExplain(nm);
        if (expl) card.append(el("div", { class: "tl-hop-explain" }, expl));
        const srcs = nm ? sketchSrc(nm, true) : [];
        srcs.forEach((src) => card.append(sketchMedia(src, "", (nm && nm.name) || hop.id)));
        if (hop.note) card.append(el("div", { class: "tl-hop-note-line" }, hop.note));
        return card;
      };
      const hopCol = (title, hops, side) => {
        if (!hops.length) return null;
        const col = el("div", { class: "tl-hop-col " + side });
        col.append(el("b", {}, title));
        hops.forEach((h) => col.append(hopCard(h)));
        return col;
      };
      const doc = el("div", { class: "tl-doc" });
      displayPeriods.forEach((p) => {
        ensureTimes(p);
        const page = el("div", { class: "tl-doc-page" });
        page.dataset.date = p.date;
        if (p.date === todayIso) page.classList.add("today");
        if (nearest && p.date === nearest && p.date !== todayIso) page.classList.add("nearest");
        const head = el("div", { class: "tl-doc-head" });
        const titles = el("div", {});
        titles.append(el("h3", {}, fmt(p.date)));
        titles.append(el("div", { class: "mute" }, p.id + " · " + p.grade + " · 40 min"));
        if (p.objective) titles.append(el("p", { class: "tl-doc-obj" }, p.objective));
        head.append(titles);
        page.append(head);
        page.append(el("p", { class: "tl-doc-legend" }, "Easier ← Today → Harder"));
        const acts = periodActs(p);
        const block = el("div", { class: "tl-doc-slot" });
        if (!acts.length) {
          block.append(el("div", { class: "nm none" }, "—"));
          page.append(block);
        } else {
          const hopsFrom = (ids, neighbors) => {
            const byId = new Map((neighbors || []).map((h) => [h.id, h]));
            return (ids || []).map((id) => byId.get(id) || { id });
          };
          const spineArrow = (actId, hops, group) => {
            const arrow = el("div", { class: "tl-spine-arrow" });
            const nums = [...new Set((hops || []).map((h) => hopLeap(findHopLink(actId, h.id, group) || h).toFixed(1)))];
            if (nums.length) arrow.append(el("span", { class: "tl-spine-leap" }, nums.join(" / ")));
            arrow.append(el("span", { class: "tl-spine-glyph" }, "→"));
            return arrow;
          };
          acts.forEach((act) => {
            const m = matById(act.id);
            const n = neighborsOf(act.id);
            const easier = hopsFrom(act.easier, n.regression);
            const harder = hopsFrom(act.harder, n.progression);
            const spineClass = easier.length && harder.length ? "both" : easier.length ? "left-only" : harder.length ? "right-only" : "today-only";
            const spine = el("div", { class: "tl-diff-spine " + spineClass });
            if (easier.length) {
              spine.append(hopCol("Easier", easier, "easier"));
              spine.append(spineArrow(act.id, easier, "easier"));
            }
            const today = el("div", { class: "tl-today" });
            today.append(el("div", { class: "mute" }, act.start + "–" + act.end));
            const nmRow = el("div", { class: "tl-act-head" });
            nmRow.append(el("div", { class: "nm" }, m ? m.name : act.id));
            if (m) nmRow.append(el("span", { class: "tl-act-dur-u" }, matDuration(m) + " min"));
            today.append(nmRow);
            const body = el("div", { class: "tl-today-body" });
            const expl = m && matExplain(m);
            if (expl) body.append(el("div", { class: "tl-today-explain" }, expl));
            const srcs = m ? sketchSrc(m, true) : [];
            if (srcs.length) {
              const pics = el("div", { class: "tl-today-pics" });
              srcs.forEach((src) => pics.append(sketchMedia(src, "tl-today-pic", m.name)));
              body.append(pics);
            }
            today.append(body);
            const cn = m && (m.classNotes || []).find((x) => x.date === p.date && x.grade === p.grade);
            if (cn && cn.text) {
              const note = el("div", { class: "tl-today-note" });
              note.append(el("b", {}, "Class note"));
              note.append(el("div", {}, cn.text));
              today.append(note);
            }
            spine.append(today);
            if (harder.length) {
              spine.append(spineArrow(act.id, harder, "harder"));
              spine.append(hopCol("Harder", harder, "harder"));
            }
            block.append(spine);
          });
          page.append(block);
        }
        doc.append(page);
      });
      grid.append(doc);
      const want = todayIso || (state.period && state.period.date) || ($("#p-date") && $("#p-date").value) || "";
      const pageNow = grid.querySelector(".tl-doc-page.today") || (want ? grid.querySelector(".tl-doc-page[data-date=\"" + want + "\"]") : null) || grid.querySelector(".tl-doc-page.nearest");
      const scroller = document.querySelector(".tl-scroll");
      if (scroller) scroller.scrollLeft = 0;
      if (pageNow && scroller) scrollTlToTarget(scroller, pageNow);
      return;
    }
    grid.classList.remove("tl-display");
    grid.replaceChildren();
    const stats = { periods: periods.length, harder: 0, easier: 0, repeat: 0, sideways: 0, jump: 0 };
    const todayIso = isoLocal(new Date());
    const nearest = nearestClassDate(periods, todayIso);
    const cols = periods.slice();
    if (!cols.some((p) => p.date === todayIso)) {
      cols.push(ensureTimes({ id: todayIso + "-" + grade, date: todayIso, grade, reflection: { flags: [], text: "" } }));
      cols.sort((a, b) => a.date.localeCompare(b.date));
    }
    if (!cols.length) {
      grid.append(el("div", { class: "tl-empty" }, "No saved periods for " + grade + " yet. Pin an activity or save a reflection and it appears here."));
      $("#tl-stats").replaceChildren();
      placeReflDock(null);
      renderReflection();
      return;
    }
    const fmt = (iso) => { const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
    const last = periods[periods.length - 1];
    const s = state.suggestion;
    const from = (state.period && state.period.date) || (last && last.date) || todayIso;
    const blankDate = firstBlankDate(periods, from);
    const aiDate = s ? blankDate : null;
    if (s) state.suggestionDate = blankDate;
    const appendAiCol = (prev) => {
      const picks = (s.picks || []).slice();
      const aiP = {
        id: aiDate + "-" + grade,
        date: aiDate,
        grade,
        activities: picks.map((pick) => emptyAct(pick.id, pick.start, pick.end)),
        reflection: { flags: [], text: s.summary || "" }
      };
      const col = el("div", { class: "tl-col ai" });
      const head = el("div", { class: "tl-date", "data-goto": aiP.date, title: "AI suggestion on the first blank date — click to open, then Accept to save" });
      head.append(el("span", { class: "tl-ai", title: "Suggested by the model" }, "✦"));
      head.append(el("b", {}, "AI · " + fmt(aiP.date)));
      head.append(el("small", {}, aiP.id));
      placeSuggestDock(head);
      col.append(head);
      const cell = el("div", { class: "tl-cell" + (picks.length ? " has-mat" : "") });
      const kind = hopKind(periodStepPrevId(prev), picks.length ? picks[0].id : null);
      cell.append(el("span", { class: "tl-step " + kind, title: STEP_TITLE[kind] }, STEP_GLYPH[kind]));
      const body = el("div", { class: "tl-cell-body" });
      const stack = el("div", { class: "tl-acts" });
      if (!picks.length) stack.append(el("div", { class: "nm none" }, "—"));
      else picks.forEach((pick, ai) => {
        const act = emptyAct(pick.id, pick.start, pick.end);
        stack.append(paintActivity(aiP, act, ai, prev, false));
      });
      body.append(stack);
      body.append(addActivityRow(aiP));
      cell.append(body);
      col.append(cell);
      const foot = el("div", { class: "tl-foot" });
      const fl = el("div", { class: "fl" });
      fl.append(el("span", { class: "easy" }, "first blank date"));
      foot.append(fl);
      if (aiP.reflection.text) foot.append(el("div", { class: "tx", title: aiP.reflection.text }, aiP.reflection.text));
      foot.prepend(el("div", { class: "tl-foot-split", "data-tl-foot-split": "1", draggable: "false", role: "separator", tabindex: "0", title: "Drag down to shrink After class", "aria-orientation": "horizontal", "aria-label": "Resize After class" }));
      col.append(foot);
      grid.append(col);
    };
    if (s && aiDate && (!periods.length || aiDate < periods[0].date)) appendAiCol(null);
    cols.forEach((p, i) => {
      const prev = periods.filter((x) => x.date < p.date).pop() || (i ? cols[i - 1] : null);
      if (s && p.date === aiDate) { appendAiCol(prev); return; }
      const saved = periods.some((x) => x.date === p.date);
      const col = el("div", { class: "tl-col" + (state.period && p.id === state.period.id ? " now" : "") + ((!s && p.date === blankDate) || !saved ? " blank" : "") + (!saved ? " ghost" : "") + (nearest && p.date === nearest && p.date !== todayIso ? " nearest" : "") });
      const head = el("div", { class: "tl-date", "data-goto": p.date, title: "open this period in the pin panel" });
      head.append(el("b", {}, fmt(p.date)), el("small", {}, p.id));
      if (!s && p.date === blankDate) placeSuggestDock(head);
      if (state.period && p.id === state.period.id) { placeObjDock(head); fillObjDock(state.period); }
      else if (p.objective) head.append(el("div", { class: "tl-obj-ro" }, p.objective));
      col.append(head);
      col.append(paintPeriodCell(p, prev, stats));
      const foot = el("div", { class: "tl-foot" });
      const r = p.reflection || { flags: [], text: "" };
      if (state.period && p.id === state.period.id) placeReflDock(foot);
      else fillSavedFoot(foot, r);
      foot.prepend(el("div", { class: "tl-foot-split", "data-tl-foot-split": "1", draggable: "false", role: "separator", tabindex: "0", title: "Drag down to shrink After class", "aria-orientation": "horizontal", "aria-label": "Resize After class" }));
      col.append(foot); grid.append(col);
      if (s && aiDate && p.date < aiDate && (!periods[i + 1] || periods[i + 1].date > aiDate)) appendAiCol(p);
    });
    const blankExists = cols.some((p) => p.date === blankDate);
    if (!s && !blankExists) {
      const blankP = ensureTimes({ id: blankDate + "-" + grade, date: blankDate, grade, reflection: { flags: [], text: "" } });
      const col = el("div", { class: "tl-col blank ghost" + (state.period && state.period.id === blankP.id ? " now" : "") });
      const head = el("div", { class: "tl-date", "data-goto": blankDate, title: "first blank date — add activities or suggest next" });
      head.append(el("b", {}, "+ " + fmt(blankDate)));
      head.append(el("small", {}, blankP.id));
      placeSuggestDock(head);
      if (state.period && state.period.id === blankP.id) { placeObjDock(head); fillObjDock(state.period); }
      col.append(head);
      col.append(paintPeriodCell(blankP, last, null));
      const foot = el("div", { class: "tl-foot" });
      if (state.period && state.period.id === blankP.id) placeReflDock(foot);
      else {
        const fl = el("div", { class: "fl" });
        fl.append(el("span", { class: "easy" }, "blank — add activities"));
        foot.append(fl);
      }
      foot.prepend(el("div", { class: "tl-foot-split", "data-tl-foot-split": "1", draggable: "false", role: "separator", tabindex: "0", title: "Drag down to shrink After class", "aria-orientation": "horizontal", "aria-label": "Resize After class" }));
      col.append(foot); grid.append(col);
    } else if (!s && !grid.querySelector("#tl-suggest-dock")) placeSuggestDock(null);
    if (!grid.querySelector("#tl-refl-dock")) placeReflDock(null);
    renderReflection();
    fillObjDock(state.period);
    const statsEl = $("#tl-stats"); statsEl.replaceChildren();
    statsEl.append(el("span", {}, stats.periods + " periods"));
    [["harder", "→"], ["easier", "←"], ["repeat", "="], ["sideways", "~"], ["jump", "✕"]].forEach(([k, g]) => { if (stats[k]) statsEl.append(el("span", { title: STEP_TITLE[k] }, g + " " + stats[k] + " " + k)); });
    applyTlLaneHeights();
    // Stay on the period the teacher opened. Do not prefer AI / blank (those sit later and look like a jump to the last day).
    const now = grid.querySelector(".tl-col.now .tl-date") || grid.querySelector(".tl-col.ai .tl-date") || grid.querySelector(".tl-col.blank .tl-date");
    const scroller = pinTlPane() || document.querySelector(".tl-scroll");
    if (now && scroller) {
      const col = now.closest(".tl-col") || now;
      const cr = col.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      scroller.scrollLeft += (cr.left + cr.width / 2) - (sr.left + sr.width / 2);
      scroller.scrollTop = 0;
    }
  }

  /** timelineHoverGroups(id) → { easier, harder, alts }
   *  easier  = regression neighbours only
   *  harder  = progression neighbours only
   *  alts    = related hops, then GATNE suggestions (not a same-slot dump)
   *  Drawn inline on each timeline activity by paintHopColumns(). Same graph as hopChoices. No API. */
  function timelineHoverGroups(id) {
    if (!id) return { easier: [], harder: [], alts: [] };
    return graphHopColumns(id, state.links, state.materials, graphView && graphView.getPositions(), state.sets);
  }

  function hopColumns(id) {
    return timelineHoverGroups(id);
  }

  const HOP_GROUPS = [["easier", "Easier"], ["harder", "Harder"], ["alts", "Related"]];

  function paintPicked(act, p, actIndex, only) {
    const rows = !only;
    const wrap = el("div", { class: rows ? "tl-picked tl-picked-rows" : "tl-picked" });
    const canUntick = !!(p && p.id);
    const want = only && only.length ? only : HOP_GROUPS.map((x) => x[0]);
    HOP_GROUPS.forEach(([g, title]) => {
      if (want.indexOf(g) < 0) return;
      const row = rows ? el("div", { class: "tl-picked-row " + g }) : wrap;
      if (rows) row.append(el("span", { class: "lab" }, title));
      const ids = act[g] || [];
      if (rows && !ids.length) row.append(el("span", { class: "mute" }, "none"));
      ids.forEach((id) => {
        const m = matById(id);
        const hop = (g === "easier" || g === "harder") ? findHopLink(act.id, id, g) : null;
        const leapLab = (g === "easier" || g === "harder") ? hopLeap(hop).toFixed(1) + " · " : "";
        const chip = el("span", { class: "picked-wrap " + g });
        chip.append(el("span", { class: "picked", "data-peek": id, title: leapLab + title }, leapLab + (m ? m.name : id)));
        if (canUntick) {
          chip.append(el("button", {
            class: "picked-x",
            type: "button",
            title: "Remove this " + title.toLowerCase() + " pick",
            "data-tl-tick": id,
            "data-tl-group": g,
            "data-tl-period": p.id,
            "data-tl-act": String(actIndex)
          }, "×"));
        }
        row.append(chip);
      });
      if (rows) wrap.append(row);
    });
    return wrap;
  }

  let hopFlyHideT = 0;
  let hopFlyShowT = 0;
  let lastPtr = { x: 0, y: 0 };
  let hopDockHold = null;
  let hopFlyMoved = false;
  let hopFlyDrag = null;
  function keepHopFly() { clearTimeout(hopFlyHideT); }
  function closeHopFlyout(clear) {
    const fly = $("#hop-flyout"); if (!fly) return;
    clearTimeout(hopFlyShowT);
    fly.classList.remove("open", "spread", "one", "set-members", "hop-dragging");
    fly.hidden = true;
    hopDockHold = null;
    hopFlyMoved = false;
    hopFlyDrag = null;
    if (clear !== false) state.hopFly = null;
    const dr = $("#drawer");
    if (overlayOpen(dr) && dr.classList.contains("float") && state.drawerAnchor) placeDrawer(dr, state.drawerAnchor);
  }
  function hideHopFlySoon() {
    if (document.body.classList.contains("ov-resizing")) return;
    if (hopDockHold || hopFlyMoved || hopFlyDrag) return;
    clearTimeout(hopFlyShowT);
    if (overlayOpen($("#peek-drawer"))) { keepHopFly(); return; }
    clearTimeout(hopFlyHideT);
    hopFlyHideT = setTimeout(() => closeHopFlyout(), 220);
  }
  function pointerOverHopDock(x, y) {
    const hit = (el, always) => {
      if (!el) return false;
      if (!always && !overlayOpen(el)) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
    };
    return hit($("#hop-flyout")) || hit($("#drawer")) || hit($("#peek-drawer")) || hit($("#kg-side"), true);
  }
  function hideDockedHopSoon(e) {
    if (hopDockHold || hopFlyMoved || hopFlyDrag) return;
    const next = e && e.relatedTarget;
    const fly = $("#hop-flyout");
    const dr = $("#drawer");
    const kg = $("#kg-side");
    const pk = $("#peek-drawer");
    if (next && ((fly && fly.contains(next)) || (dr && dr.contains(next)) || (pk && pk.contains(next)) || (kg && kg.contains(next)))) { keepHopFly(); keepPeek(); return; }
    hideHopFlySoon();
    hidePeekSoon();
  }
  function placeHopFlyout(anchor, side) {
    const fly = $("#hop-flyout"); if (!fly || !anchor) return;
    if (hopFlyMoved) {
      applyOverlayBox(fly);
      return;
    }
    const s = overlaySize();
    applyOverlayBox(fly);
    const dr = $("#drawer");
    const kg = $("#kg-side");
    const besideSide = kg && (side === "left" || side === "right") && (anchor === kg || kg.contains(anchor));
    if (besideSide) {
      const r = kg.getBoundingClientRect();
      let left = side === "left" ? r.left - s.w - 10 : r.right + 10;
      if (left < 12) left = 12;
      if (left + s.w > window.innerWidth - 12) left = Math.max(12, window.innerWidth - s.w - 12);
      let top = r.top;
      if (top + s.h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - s.h - 12);
      if (top < 12) top = 12;
      fly.style.left = Math.round(left) + "px";
      fly.style.top = Math.round(top) + "px";
      hopDockHold = { x: lastPtr.x, y: lastPtr.y };
      return;
    }
    const besideMain = overlayOpen(dr) && (side === "left" || side === "right") && (anchor === dr || (anchor && dr.contains(anchor)));
    if (besideMain) {
      applyOverlayBox(dr);
      const r = dr.getBoundingClientRect();
      const docked = dockBeside({
        mainLeft: r.left,
        mainWidth: s.w,
        flyWidth: s.w,
        viewport: window.innerWidth,
        side
      });
      let top = r.top;
      if (top + s.h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - s.h - 12);
      if (top < 12) top = 12;
      dr.style.left = Math.round(docked.mainLeft) + "px";
      dr.style.top = Math.round(top) + "px";
      dr.style.bottom = "auto";
      fly.style.left = Math.round(docked.flyLeft) + "px";
      fly.style.top = Math.round(top) + "px";
      hopDockHold = { x: lastPtr.x, y: lastPtr.y };
      return;
    }
    const r = anchor.getBoundingClientRect();
    const fw = s.w;
    const fh = s.h;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const alignX = Math.min(Math.max(12, r.left), Math.max(12, vw - fw - 12));
    let left;
    let top;
    if (side !== "left" && r.right + 8 + fw <= vw - 12) {
      left = r.right + 8;
      top = r.top;
    } else if (r.bottom + 8 + fh <= vh - 12) {
      left = alignX;
      top = r.bottom + 8;
    } else if (r.top - 8 - fh >= 12) {
      left = alignX;
      top = r.top - fh - 8;
    } else if (side !== "right" && r.left - 8 - fw >= 12) {
      left = r.left - fw - 8;
      top = r.top;
    } else {
      left = alignX;
      top = Math.max(12, r.top - fh - 8);
    }
    if (left < 12) left = 12;
    if (left + fw > vw - 12) left = Math.max(12, vw - fw - 12);
    if (top < 12) top = 12;
    if (top + fh > vh - 12) top = Math.max(12, vh - fh - 12);
    fly.style.left = Math.round(left) + "px";
    fly.style.top = Math.round(top) + "px";
    if (!fly.classList.contains("set-members")) separateOverlays(fly);
  }
  function hoverMemberIds(setId) {
    const ids = effectiveMembers(state.sets, setId);
    if (ids.length) return ids;
    const s = state.sets.find((x) => x.id === setId);
    if (!s) return [];
    const vocab = s.name === MOTOR_ROOT_NAME ? MOTOR_SKILLS : s.name === COMPONENT_ROOT_NAME ? SKILL_RELATED_COMPONENTS : null;
    if (!vocab) return (s.members || []).slice();
    const out = [];
    for (const leaf of state.sets) {
      if (!vocab.includes(leaf.name)) continue;
      for (const id of leaf.members || []) if (!out.includes(id)) out.push(id);
    }
    return out;
  }
  function showSetMemberFly(anchor, setId, dwell) {
    keepHopFly();
    if (dwell) {
      clearTimeout(hopFlyShowT);
      hopFlyShowT = setTimeout(() => showSetMemberFly(anchor, setId), HOVER_DWELL_MS);
      return;
    }
    const fly = $("#hop-flyout"); if (!fly || !anchor || !setId) return;
    state.hopFly = { side: "right", anchor, act: { id: setId } };
    fly.classList.remove("spread", "set-members");
    fly.classList.add("one", "open", "set-members");
    fly.hidden = false;
    hopFlyMoved = false;
    const body = $("#hop-flyout-body") || fly;
    body.replaceChildren();
    body.append(el("div", { class: "mute" }, pathLabel(state.sets, setId) || setId));
    const ids = hoverMemberIds(setId);
    if (!ids.length) body.append(el("div", { class: "mute" }, "No activities in this set"));
    else {
      const lib = el("div", { class: "tl-hop-lib" });
      ids.forEach((id) => lib.append(el("button", { type: "button", class: "chip", "data-open": id }, label(id))));
      body.append(lib);
    }
    requestAnimationFrame(() => placeHopFlyout(anchor, "right"));
  }
  function showHopFlyout(anchor, spec, dwell) {
    keepHopFly();
    if (dwell) {
      clearTimeout(hopFlyShowT);
      hopFlyShowT = setTimeout(() => showHopFlyout(anchor, spec), HOVER_DWELL_MS);
      return;
    }
    const fly = $("#hop-flyout"); if (!fly || !anchor || !spec || !spec.act) return;
    spec.side = spec.side || "spread";
    spec.only = spec.only || HOP_GROUPS.map((x) => x[0]);
    spec.tickable = spec.tickable !== false && !!(spec.p && spec.p.id);
    spec.anchor = anchor;
    const sameOpen = overlayOpen(fly) && state.hopFly && state.hopFly.act && spec.act
      && state.hopFly.act.id === spec.act.id
      && String(state.hopFly.only) === String(spec.only)
      && state.hopFly.side === spec.side;
    state.hopFly = spec;
    if (sameOpen) {
      if (!hopFlyMoved) requestAnimationFrame(() => placeHopFlyout(anchor, spec.side));
      return;
    }
    fly.classList.remove("spread", "one", "set-members");
    fly.classList.add(spec.only.length > 1 ? "spread" : "one", "open");
    fly.hidden = false;
    document.body.appendChild(fly);
    placeHopFlyout(anchor, spec.side);
    const body = $("#hop-flyout-body") || fly;
    const libGroup = spec.only.length === 1 ? spec.only[0] : "alts";
    body.replaceChildren();
    const qEl = el("input", { class: "tl-hop-q", type: "search", placeholder: "Search library…" });
    qEl.addEventListener("click", (e) => e.stopPropagation());
    qEl.addEventListener("keydown", (e) => e.stopPropagation());
    qEl.addEventListener("focus", keepHopFly);
    body.append(qEl);
    const libSlot = el("div", { class: "tl-hop-lib" });
    libSlot.hidden = true;
    body.append(libSlot);
    body.append(paintHopColumns(spec.p, spec.act, spec.actIndex, spec.only, spec.tickable, false));
    let libSeq = 0;
    let libTimer = 0;
    const runLibSearch = async (q) => {
      keepHopFly();
      const needle = (q || "").trim();
      const seq = ++libSeq;
      if (!needle) {
        libSlot.hidden = true;
        libSlot.replaceChildren();
        return;
      }
      const res = await api.search(needle, 12);
      if (seq !== libSeq) return;
      const drop = (hits) => (hits || []).filter((h) => h.id !== spec.act.id);
      paintLibraryHits(libSlot, spec.p, spec.act, spec.actIndex, libGroup, spec.tickable, drop(res.keyword), drop(res.semantic));
    };
    qEl.addEventListener("input", () => {
      keepHopFly();
      clearTimeout(libTimer);
      libTimer = setTimeout(() => runLibSearch(qEl.value), 220);
    });
    requestAnimationFrame(() => placeHopFlyout(anchor, spec.side));
  }
  function restoreHopFlyout() {
    const spec = state.hopFly;
    if (!spec || !spec.p || !spec.p.id) return;
    if (!spec.only || spec.only.length > 1) return;
    const node = document.querySelector('.tl-cell[data-period="' + spec.p.id + '"] .tl-act[data-act="' + spec.actIndex + '"]');
    if (!node) return;
    const p = (state.period && state.period.id === spec.p.id) ? state.period : spec.p;
    const act = periodActs(p)[spec.actIndex];
    if (!act) return;
    showHopFlyout(node, { p, act, actIndex: spec.actIndex, side: spec.side, only: spec.only, tickable: true });
  }

  function paintActivity(p, act, actIndex, prev, canRemove) {
    const m = matById(act.id);
    const box = el("div", { class: "tl-act" });
    box.dataset.act = String(actIndex);
    box.setAttribute("draggable", "true");
    box.append(paintActClock(p, act, actIndex));
    const head = el("div", { class: "tl-act-head" });
    head.append(el("div", { class: "nm" + (m ? "" : " none"), title: m ? m.name : act.id, "data-peek": act.id }, m ? m.name : "—"));
    if (m) head.append(el("span", { class: "tl-act-dur-u", title: "Estimate from the library" }, matDuration(m) + " min"));
    head.append(el("button", {
      class: "btn tl-act-change",
      type: "button",
      title: "Change this activity from the library",
      "data-tl-change-open": "1",
      "data-tl-period": p.id,
      "data-tl-act": String(actIndex),
      "data-tl-date": p.date || "",
      "data-tl-grade": p.grade || ""
    }, "Change"));
    if (canRemove) {
      const rm = el("button", { class: "btn tl-act-x", type: "button", title: "Remove this activity", "data-tl-remove": "1", "data-tl-period": p.id, "data-tl-act": String(actIndex) }, "×");
      head.append(rm);
    }
    box.append(head);
    const expl = m && matExplain(m);
    if (expl) box.append(el("div", { class: "tl-act-explain" }, expl));
    const srcs = m ? sketchSrc(m, true) : [];
    if (srcs.length) {
      const pics = el("div", { class: "tl-act-pics" });
      srcs.forEach((src) => pics.append(sketchMedia(src, "", m.name || "")));
      box.append(pics);
    }
    box.append(paintPicked(act, p, actIndex));
    const diff = el("details", { class: "tl-diff" });
    diff.append(el("summary", {}, "Differentiation"));
    diff.append(paintHopColumns(p, act, actIndex, HOP_GROUPS.map((x) => x[0]), true));
    box.append(diff);
    if (m && p && p.date && p.grade) {
      const note = el("div", { class: "tl-class-note" });
      note.append(el("div", { class: "lab" }, "Note"));
      const row = (m.classNotes || []).find((n) => n.date === p.date && n.grade === p.grade);
      const ta = el("textarea", { "data-class-note": "1", "data-id": m.id, "data-date": p.date, "data-grade": p.grade, placeholder: "Class note for this date" });
      ta.value = row ? row.text : "";
      note.append(ta);
      box.append(note);
    }
    box.append(el("div", { class: "tl-act-split", "data-tl-act-split": "1", draggable: "false", title: "Drag to resize this activity" }));
    return box;
  }

  function addActivityRow(p) {
    const row = el("div", { class: "tl-add-row" });
    const btn = el("button", {
      class: "btn",
      type: "button",
      "data-tl-add-open": "1",
      "data-tl-period": p.id,
      "data-tl-date": p.date || "",
      "data-tl-grade": p.grade || ""
    }, "+ add activity");
    row.append(btn);
    const setBtn = el("button", {
      class: "btn",
      type: "button",
      "data-tl-add-set": "1",
      "data-tl-period": p.id,
      "data-tl-date": p.date || "",
      "data-tl-grade": p.grade || ""
    }, "+ add activity set");
    row.append(setBtn);
    return row;
  }

  function hopChip(x, cls, title, ticks, linkedIds, canTick, p, actIndex, linkGroup) {
    const m = matById(x.id);
    const group = linkGroup || cls;
    const on = ticks.indexOf(x.id) >= 0;
    const linked = linkedIds.has(x.id);
    const name = m ? m.name : x.id;
    const chain = group === "easier" || group === "harder";
    const currentId = (state.hopFly && state.hopFly.act && state.hopFly.act.id)
      || (p && periodActs(p)[actIndex] && periodActs(p)[actIndex].id)
      || state.drawerId;
    const hop = chain && linked ? findHopLink(currentId, x.id, group) : null;
    const leapLab = chain && linked ? hopLeap(hop || x).toFixed(1) + " · " : "";
    const label = leapLab + (x.note === "suggested" && x.rank ? x.rank + ". " + name : name);
    const attrs = {
      class: "chip " + cls + (on ? " on" : "") + (x.note === "suggested" ? " suggested" : ""),
      type: "button",
      "aria-pressed": on ? "true" : "false",
      title: leapLab + (on ? "Ticked · " : "") + (x.note === "suggested" ? "Suggested · closer first" : ((x.tag ? x.tag + " · " : "") + (x.note || title)))
    };
    if (canTick) {
      attrs["data-tl-tick"] = x.id;
      attrs["data-tl-group"] = group;
      attrs["data-tl-period"] = p.id;
      attrs["data-tl-act"] = String(actIndex);
    } else if (linked) attrs["data-open"] = x.id;
    else {
      attrs["data-link-hit"] = x.id;
      attrs["data-link-group"] = group;
    }
    const btn = el("button", attrs, label);
    if (canTick) return btn;
    const row = el("div", { class: "chip-row" });
    row.append(btn);
    if (linked) {
      row.append(el("button", {
        class: "chip-x",
        type: "button",
        title: "Remove this connection",
        "data-unlink": x.id,
        "data-unlink-group": group
      }, "×"));
    }
    return row;
  }

  async function commitHopLink(group, hitId, text) {
    const spec = state.hopFly;
    const currentId = (spec && spec.act && spec.act.id) || state.drawerId;
    const L = group === "alts"
      ? hopLinkFor(currentId, group, hitId, text)
      : hopLinkFor(currentId, group, hitId, "", text);
    if (!L) { toast("Related to needs a note"); return; }
    const r = await api.createLink(L);
    if (!r) return toast("That link already exists");
    await loadGraph();
    toast("Linked " + label(L.from) + " → " + label(L.to));
    if (spec && overlayOpen($("#drawer"))) {
      showHopFlyout($("#drawer"), {
        p: null, act: emptyAct(currentId), actIndex: 0,
        side: spec.side, only: spec.only, tickable: false
      });
    }
  }

  function openHopNote(afterEl, group, hitId) {
    const body = $("#hop-flyout-body");
    if (!body || !afterEl) return;
    body.querySelectorAll(".tl-hop-note").forEach((n) => n.remove());
    const required = group === "alts";
    const pop = el("div", { class: "tl-hop-note" });
    pop.append(el("div", { class: "mute" }, required ? "Write the note (required)" : "Write the note (optional)"));
    const row = el("div", { class: "tl-hop-note-row" });
    const inp = el("input", { type: "text", placeholder: required ? "Note (required)" : "Note (optional)" });
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); go.click(); }
    });
    inp.addEventListener("focus", keepHopFly);
    const go = el("button", { class: "btn solid", type: "button" }, "Link");
    go.addEventListener("click", async (e) => {
      e.stopPropagation();
      keepHopFly();
      const text = inp.value.trim();
      if (required && !text) { toast("Related to needs a note"); return; }
      await commitHopLink(group, hitId, text);
    });
    row.append(inp, go);
    pop.append(row);
    afterEl.after(pop);
    inp.focus();
  }

  function findHopLink(currentId, otherId, group) {
    if (!currentId || !otherId || currentId === otherId) return null;
    for (const L of state.links) {
      const a = L.from === currentId && L.to === otherId;
      const b = L.from === otherId && L.to === currentId;
      if (!a && !b) continue;
      if (group === "alts" && L.kind === "related") return L;
      if (group === "easier") {
        if (L.kind === "regression" && L.to === currentId && L.from === otherId) return L;
        if (L.kind === "progression" && L.to === currentId && L.from === otherId) return L;
      }
      if (group === "harder") {
        if (L.kind === "progression" && L.from === currentId && L.to === otherId) return L;
        if (L.kind === "regression" && L.from === currentId && L.to === otherId) return L;
      }
    }
    return null;
  }

  function linkedIdsForGroup(actId, cls) {
    const n = neighborsOf(actId);
    return new Set((cls === "easier" ? n.regression : cls === "harder" ? n.progression : n.related || []).map((x) => x.id));
  }

  function paintLibraryHits(slotEl, p, act, actIndex, group, tickable, keyword, semantic) {
    const ticks = (act && act[group]) || [];
    const linkedIds = linkedIdsForGroup(act.id, group);
    const canTick = !!(tickable && p && p.id);
    const paintGroup = (title, hits, emptyText) => {
      const g = el("div", { class: "tl-hop-lib-g" });
      g.append(el("div", { class: "tl-hop-lib-lab" }, title));
      if (!hits.length) g.append(el("div", { class: "empty" }, emptyText));
      else {
        const chips = el("div", { class: "chips" });
        hits.forEach((h) => chips.append(hopChip({ id: h.id, note: title }, "lib", title, ticks, linkedIds, canTick, p, actIndex, group)));
        g.append(chips);
      }
      return g;
    };
    slotEl.hidden = false;
    slotEl.replaceChildren(
      paintGroup("Match by keyword", keyword || [], "No name/cue/notes/set match"),
      paintGroup("Match by semantic", semantic || [], "No semantic matches")
    );
  }

  function paintHopColumns(p, act, actIndex, only, tickable, pickedInGrp) {
    const g = hopColumns(act.id);
    const wrap = el("div", { class: "tl-hops" });
    const want = only || HOP_GROUPS.map((x) => x[0]);
    const canTick = !!(tickable && p && p.id);
    HOP_GROUPS.forEach(([cls, title]) => {
      const rows = g[cls] || [];
      const ticked = act[cls];
      if (want.indexOf(cls) < 0) return;
      const ticks = ticked || [];
      const linkedIds = linkedIdsForGroup(act.id, cls);
      const box = el("div", { class: "grp " + cls });
      const head = el("div", { class: "grp-head" });
      head.append(el("p", {}, title));
      const qEl = el("input", { class: "tl-hop-col-q", type: "search", placeholder: "Search", "aria-label": "Search " + title });
      head.append(qEl);
        qEl.addEventListener("input", () => {
          const needle = qEl.value.trim().toLowerCase();
          box.querySelectorAll(".chip").forEach((chip) => {
            const hay = (chip.textContent || "").toLowerCase();
            const hide = !!(needle && hay.indexOf(needle) < 0);
            chip.hidden = hide;
            const row = chip.closest(".chip-row");
            if (row) row.hidden = hide;
          });
        });
      qEl.addEventListener("click", (e) => e.stopPropagation());
      qEl.addEventListener("keydown", (e) => e.stopPropagation());
      box.append(head);
      if (pickedInGrp) box.append(paintPicked(act, p, actIndex, [cls]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      ticks.forEach((id) => { if (!byId.has(id)) byId.set(id, { id, note: "ticked" }); });
      const tickedRows = ticks.map((id) => byId.get(id)).filter(Boolean);
      const rest = rows.filter((r) => ticks.indexOf(r.id) < 0);
      const list = pickedInGrp ? rest : tickedRows.concat(rest);
      if (!list.length) box.append(el("div", { class: "empty" }, cls === "alts" ? "none suggested" : "none linked"));
      else {
        const chips = el("div", { class: "chips" });
        if (list.length > 3) chips.classList.add("scroll");
        let marked = false;
        list.forEach((x) => {
          if (x.note === "suggested" && !marked) {
            marked = true;
            chips.append(el("div", { class: "mute kg-suggested-break" }, "-- below are suggested --"));
          }
          chips.append(hopChip(x, cls, title, ticks, linkedIds, canTick, p, actIndex));
        });
        box.append(chips);
      }
      wrap.append(box);
    });
    return wrap;
  }

  async function applyTlTick(tick) {
    const group = tick.dataset.tlGroup;
    const hid = tick.dataset.tlTick;
    const ai = Number(tick.dataset.tlAct);
    await mutatePeriod(tick.dataset.tlPeriod, (p) => {
      const acts = periodActs(p);
      const act = acts[ai]; if (!act) return;
      const arr = act[group] || [];
      const i = arr.indexOf(hid);
      if (i >= 0) arr.splice(i, 1); else arr.push(hid);
      act[group] = arr;
      writeActs(p, acts);
    });
  }

  async function maybeFillObjective(p) {
    if (!p || String(p.objective || "").trim()) return;
    const acts = periodActs(p);
    if (!acts.length) return;
    const seen = new Set();
    const mats = [];
    acts.forEach((a) => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      const m = matById(a.id);
      if (m) mats.push({ id: m.id, name: m.name, look: m.look, notes: m.notes || "", duration: matDuration(m) });
    });
    try {
      const { text } = await api.polish("objective", "", JSON.stringify({
        period: {
          id: p.id,
          date: p.date,
          grade: p.grade,
          activities: periodActs(p)
        },
        materials: mats
      }));
      if (!text) return;
      p.objective = text;
      await api.savePeriod(p);
      if (state.period && state.period.id === p.id) state.period = p;
    } catch (_err) { /* teacher can Summarize */ }
  }
  async function mutatePeriod(id, fn, opts) {
    let p = (state.period && state.period.id === id) ? state.period : await api.getPeriod(id);
    if (!p) {
      const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z][A-Za-z0-9]{0,7})$/.exec(id);
      if (!m || m[2] === "all") return;
      p = ensureTimes({ id, date: m[1], grade: m[2], reflection: { flags: [], text: "" } });
    }
    fn(p);
    const scroller = document.querySelector(".tl-scroll");
    const sl = scroller ? scroller.scrollLeft : 0;
    await api.savePeriod(p);
    if (opts && opts.fillObjective) await maybeFillObjective(p);
    if (state.period && state.period.id === p.id) { state.period = p; renderPin(); }
    await renderTimeline();
    restoreHopFlyout();
    const sc2 = document.querySelector(".tl-scroll");
    if (sc2) sc2.scrollLeft = sl;
  }

  $("#tl-grid").addEventListener("click", async (e) => {
    const addOpen = e.target.closest("[data-tl-add-open]");
    if (addOpen) {
      e.stopPropagation();
      openMaterialPicker({ id: addOpen.dataset.tlPeriod, date: addOpen.dataset.tlDate, grade: addOpen.dataset.tlGrade });
      return;
    }
    const addSet = e.target.closest("[data-tl-add-set]");
    if (addSet) {
      e.stopPropagation();
      openSetSheet(
        { id: addSet.dataset.tlPeriod, date: addSet.dataset.tlDate, grade: addSet.dataset.tlGrade },
        state.addSet && state.addSet.setId
      );
      return;
    }
    const changeOpen = e.target.closest("[data-tl-change-open]");
    if (changeOpen) {
      e.stopPropagation();
      openMaterialPicker(
        { id: changeOpen.dataset.tlPeriod, date: changeOpen.dataset.tlDate, grade: changeOpen.dataset.tlGrade },
        { mode: "replace", actIndex: Number(changeOpen.dataset.tlAct) }
      );
      return;
    }
    const tick = e.target.closest("[data-tl-tick]");
    if (tick) {
      e.stopPropagation();
      await applyTlTick(tick);
      return;
    }
    const rm = e.target.closest("[data-tl-remove]");
    if (rm) {
      e.stopPropagation();
      const ai = Number(rm.dataset.tlAct);
      await mutatePeriod(rm.dataset.tlPeriod, (p) => {
        const acts = periodActs(p);
        acts.splice(ai, 1);
        writeActs(p, acts);
      }, { fillObjective: true });
      return;
    }
    const peek = e.target.closest("[data-peek]");
    if (peek) { openDrawer(peek.dataset.peek, true, peek); return; }
    if (e.target.closest("[data-tl-clock]")) { e.stopPropagation(); return; }
    if (e.target.closest("#tl-obj-dock, #tl-suggest-dock, #suggest-menu")) return;
    if ($("#tl-grid").classList.contains("tl-display")) {
      const hopCol = e.target.closest(".tl-hop-col");
      document.querySelectorAll("#tl-grid .tl-hop-col.tl-wide").forEach((n) => {
        if (n !== hopCol) n.classList.remove("tl-wide");
      });
      if (hopCol) hopCol.classList.add("tl-wide");
      return;
    }
    const h = e.target.closest("[data-goto]"); if (!h) return;
    $("#p-date").value = h.dataset.goto; loadPeriod();
  });

  function hideSetPop() {
    const pop = $("#set-add-pop");
    if (!pop) return;
    pop.hidden = true;
    pop.classList.remove("open");
    state.setSheet = null;
  }

  function placeSetPop() {
    const el = $("#set-add-pop");
    if (!el) return;
    el.hidden = false;
    el.classList.add("open");
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 240;
    el.style.left = Math.round(Math.max(8, (window.innerWidth - w) / 2)) + "px";
    el.style.top = Math.round(Math.max(8, (window.innerHeight - h) / 2)) + "px";
  }

  function openSetSheet(p, setId) {
    state.setSheet = { periodId: p.id, date: p.date, grade: p.grade, setId: setId || null, draft: p.draft || "" };
    paintSetSheet();
    placeSetPop();
  }

  function paintSetSheet() {
    const spec = state.setSheet;
    const title = $("#set-add-title");
    const pick = $("#set-add-pick");
    const rows = $("#set-add-rows");
    const foot = $("#set-add-foot");
    const ok = $("#set-add-ok");
    if (!spec || !rows) return;
    const set = spec.setId ? state.sets.find((s) => s.id === spec.setId) : null;
    if (title) title.textContent = set ? (set.name || set.id) + " → period" : "Choose a set";
    if (pick) {
      pick.replaceChildren();
      if (!set) {
        state.sets.forEach((s) => {
          const b = el("button", { type: "button", class: "kg-set-chip" + (spec.setId === s.id ? " on" : "") }, s.name || s.id);
          b.addEventListener("click", () => { spec.setId = s.id; paintSetSheet(); placeSetPop(); });
          pick.append(b);
        });
        if (!state.sets.length) pick.append(el("span", { class: "mute" }, "No activity sets yet. Search activities on the graph to make one."));
      }
    }
    rows.replaceChildren();
    if (!set) {
      if (foot) foot.textContent = "";
      if (ok) ok.disabled = true;
      return;
    }
    if (ok) ok.disabled = false;
    const p = (state.period && state.period.id === spec.periodId) ? state.period : { id: spec.periodId, date: spec.date, grade: spec.grade };
    const already = periodActs(p).map((a) => a.id);
    set.members.forEach((id) => {
      const m = matById(id);
      const here = already.indexOf(id) >= 0;
      const lab = el("label", { class: "set-add-row" + (here ? " already" : "") });
      const cb = el("input", { type: "checkbox", value: id });
      cb.checked = true;
      if (here) { cb.disabled = true; }
      cb.addEventListener("change", () => syncSetSheetFoot(set, spec, already));
      const text = el("span", {}, (m ? m.id + " " + m.name : id) + " · " + matDuration(m) + " min" + (here ? " · already here" : ""));
      lab.append(cb, text);
      rows.append(lab);
    });
    if (ok) ok.textContent = "Add to period";
    syncSetSheetFoot(set, spec, already);
  }

  function syncSetSheetFoot(set, spec, already) {
    const foot = $("#set-add-foot");
    const ok = $("#set-add-ok");
    if (!foot) return;
    const excluded = [];
    $("#set-add-rows")?.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      if (!cb.checked && !cb.disabled) excluded.push(cb.value);
    });
    const add = membersForLane(set.members, excluded, already);
    const mins = add.reduce((n, id) => n + matDuration(matById(id)), 0);
    foot.textContent = add.length + " items · " + mins + " min";
    if (ok) ok.textContent = "Add " + add.length + " to period";
  }

  $("#set-add-cancel")?.addEventListener("click", hideSetPop);
  $("#set-add-ok")?.addEventListener("click", async () => {
    const spec = state.setSheet;
    if (!spec || !spec.setId) return;
    const set = state.sets.find((s) => s.id === spec.setId);
    if (!set) return;
    const excluded = [];
    $("#set-add-rows")?.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      if (!cb.checked && !cb.disabled) excluded.push(cb.value);
    });
    await mutatePeriod(spec.periodId, (p) => {
      const acts = periodActs(p);
      const already = acts.map((a) => a.id);
      let track = acts[acts.length - 1];
      membersForLane(set.members, excluded, already).forEach((id) => {
        const start = track ? track.end : DEFAULT_PERIOD_START;
        const act = emptyAct(id, start, addMinutes(start, matDuration(matById(id))));
        acts.push(act);
        track = act;
      });
      writeActs(p, acts);
    }, { fillObjective: true, draft: spec.draft });
    state.addSet = null;
    hideSetPop();
    toast("Added to period");
  });

  $("#tl-panel")?.addEventListener("pointerdown", (e) => {
    const actSplit = e.target.closest("[data-tl-act-split]");
    if (actSplit) {
      const act = actSplit.closest(".tl-act");
      const cell = act && act.closest(".tl-cell");
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = act.getBoundingClientRect().height;
      const key = (cell && cell.dataset.period ? cell.dataset.period : "") + ":" + String(act.dataset.act || "");
      const move = (ev) => {
        const next = Math.max(88, Math.round(startH + ev.clientY - startY));
        if (!state.tlActH) state.tlActH = {};
        state.tlActH[key] = next;
        act.style.height = next + "px";
        act.style.minHeight = next + "px";
        act.style.maxHeight = next + "px";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.body.classList.remove("tl-resizing");
        saveTlLanes();
      };
      document.body.classList.add("tl-resizing");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      return;
    }
    const footSplit = e.target.closest("[data-tl-foot-split]");
    if (footSplit) {
      e.preventDefault();
      e.stopPropagation();
      const footEl = footSplit.closest(".tl-foot");
      const col = footSplit.closest(".tl-col");
      const date = col && col.querySelector(".tl-date");
      const startY = e.clientY;
      const startFoot = Math.round((footEl && footEl.getBoundingClientRect().height) || (state.tlH && state.tlH.foot) || 210);
      const colH = col ? col.getBoundingClientRect().height : startFoot + TL_LANE_MIN + 58;
      const dateH = date ? date.getBoundingClientRect().height : 58;
      const maxFoot = Math.max(76, Math.round(colH - dateH - TL_LANE_MIN));
      const move = (ev) => {
        const nextFoot = Math.max(76, Math.min(maxFoot, startFoot - Math.round(ev.clientY - startY)));
        if (!state.tlH) state.tlH = { stack: TL_LANE_DEFAULT, foot: nextFoot };
        else state.tlH.foot = nextFoot;
        applyTlLaneHeights();
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.body.classList.remove("tl-resizing");
        saveTlLanes();
      };
      document.body.classList.add("tl-resizing");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      return;
    }
    const handle = e.target.closest("[data-tl-scroll-split]");
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const scroller = document.querySelector(".tl-scroll");
    if (!scroller) return;
    const startY = e.clientY;
    const startH = scroller.getBoundingClientRect().height;
    const move = (ev) => {
      const next = Math.max(240, Math.round(startH + ev.clientY - startY));
      state.tlScrollH = next;
      scroller.style.height = next + "px";
      scroller.style.minHeight = next + "px";
      scroller.style.maxHeight = next + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("tl-resizing");
      saveTlLanes();
    };
    document.body.classList.add("tl-resizing");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  const tlGrid = $("#tl-grid");
  tlGrid.addEventListener("dragstart", (e) => {
    const act = e.target.closest(".tl-act");
    const cell = e.target.closest(".tl-cell");
    const col = e.target.closest(".tl-col");
    if (!act || !cell || !col || col.classList.contains("ai")) { e.preventDefault(); return; }
    if (e.target.closest("button, input, .chip, .tl-hop-col-q, [data-tl-act-split], [data-tl-foot-split]")) { e.preventDefault(); return; }
    state.drag = { periodId: cell.dataset.period, actIndex: Number(act.dataset.act) };
    act.classList.add("dragging");
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", act.dataset.act || ""); }
  });
  tlGrid.addEventListener("dragend", () => {
    tlGrid.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    tlGrid.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
    state.drag = null;
  });
  tlGrid.addEventListener("dragover", (e) => {
    const col = e.target.closest(".tl-col");
    if (!col || col.classList.contains("ai") || !state.drag) return;
    const cell = e.target.closest(".tl-cell") || col.querySelector(".tl-cell");
    const overAct = e.target.closest(".tl-act");
    if (!cell) return;
    e.preventDefault();
    tlGrid.querySelectorAll(".drop-target").forEach((n) => { if (n !== overAct && n !== col && n !== cell) n.classList.remove("drop-target"); });
    if (overAct) overAct.classList.add("drop-target");
    else col.classList.add("drop-target");
  });
  tlGrid.addEventListener("drop", async (e) => {
    const col = e.target.closest(".tl-col");
    const cell = (col && (e.target.closest(".tl-cell") || col.querySelector(".tl-cell")));
    const overAct = e.target.closest(".tl-act");
    tlGrid.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (!cell || !col || col.classList.contains("ai") || !state.drag) return;
    e.preventDefault();
    const from = state.drag;
    const toPeriod = cell.dataset.period;
    const overIndex = overAct ? Number(overAct.dataset.act) : null;
    state.drag = null;
    await moveActivity(from, { periodId: toPeriod, overIndex });
  });

  async function moveActivity(from, to) {
    if (!from || !to || !from.periodId || !to.periodId) return;
    if (from.periodId === to.periodId) {
      if (to.overIndex == null || to.overIndex === from.actIndex) return;
      await mutatePeriod(from.periodId, (p) => {
        const src = periodActs(p);
        const i = from.actIndex;
        const j = to.overIndex;
        if (!src[i] || !src[j]) return;
        const origin = (src[0] && src[0].start) || DEFAULT_PERIOD_START;
        const tmp = src[i];
        src[i] = src[j];
        src[j] = tmp;
        writeActs(p, restackActs(src, origin));
      });
      return;
    }
    let srcP = (state.period && state.period.id === from.periodId) ? state.period : await api.getPeriod(from.periodId);
    let destP = (state.period && state.period.id === to.periodId) ? state.period : await api.getPeriod(to.periodId);
    if (!srcP) {
      const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z][A-Za-z0-9]{0,7})$/.exec(from.periodId);
      if (!m || m[2] === "all") return;
      srcP = ensureTimes({ id: from.periodId, date: m[1], grade: m[2], reflection: { flags: [], text: "" } });
    }
    if (!destP) {
      const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z][A-Za-z0-9]{0,7})$/.exec(to.periodId);
      if (!m || m[2] === "all") return;
      destP = ensureTimes({ id: to.periodId, date: m[1], grade: m[2], reflection: { flags: [], text: "" } });
    }
    const srcActs = periodActs(srcP);
    const item = srcActs[from.actIndex];
    if (!item) return;
    const destActs = periodActs(destP);
    const srcOrigin = (srcActs[0] && srcActs[0].start) || DEFAULT_PERIOD_START;
    const destOrigin = (destActs[0] && destActs[0].start) || DEFAULT_PERIOD_START;
    if (destActs.some((a) => a.id === item.id)) { toast("Already on that period"); return; }
    srcActs.splice(from.actIndex, 1);
    if (to.overIndex != null && to.overIndex >= 0 && to.overIndex <= destActs.length) destActs.splice(to.overIndex, 0, item);
    else destActs.push(item);
    writeActs(srcP, restackActs(srcActs, srcOrigin));
    writeActs(destP, restackActs(destActs, destOrigin));
    const scroller = document.querySelector(".tl-scroll");
    const sl = scroller ? scroller.scrollLeft : 0;
    await api.savePeriod(srcP);
    await api.savePeriod(destP);
    if (state.period && (state.period.id === srcP.id || state.period.id === destP.id)) {
      state.period = state.period.id === destP.id ? destP : srcP;
      renderPin();
    }
    await renderTimeline();
    const sc2 = document.querySelector(".tl-scroll");
    if (sc2) sc2.scrollLeft = sl;
  }
  function hopChipPeek(e) {
    const chip = e.target.closest(".chip, #hop-flyout [data-open]");
    if (!chip || !chip.closest(".tl-hops, .tl-hop-lib, #hop-flyout")) return;
    const id = chip.dataset.tlTick || chip.dataset.open || chip.dataset.linkHit;
    if (!id) return;
    const fly = $("#hop-flyout");
    if (overlayOpen(fly) && fly.contains(chip)) {
      if (state.hopFly && state.hopFly.anchor) placeHopFlyout(state.hopFly.anchor, state.hopFly.side);
      const r = fly.getBoundingClientRect();
      const need = overlaySize().w + 12;
      const side = (window.innerWidth - r.right) >= need || r.left < need ? "right" : "left";
      showPeek(fly, id, side, true);
      return;
    }
    const grp = chip.closest(".grp") || chip;
    showPeek(grp, id, grp.classList.contains("easier") ? "left" : "right", true);
  }
  $("#tl-grid").addEventListener("mouseover", hopChipPeek);
  $("#tl-grid").addEventListener("mouseout", (e) => {
    const chip = e.target.closest(".chip, #hop-flyout [data-open]");
    if (!chip || !chip.closest(".tl-hops, .tl-hop-lib, #hop-flyout")) return;
    const next = e.relatedTarget;
    const pk = $("#peek-drawer");
    if (next && (chip.contains(next) || (pk && pk.contains(next)) || ($("#hop-flyout") && $("#hop-flyout").contains(next)))) return;
    hidePeekSoon();
  });
  const hopFly = $("#hop-flyout");
  if (hopFly) {
    hopFly.addEventListener("mouseenter", keepHopFly);
    hopFly.addEventListener("mouseleave", hideDockedHopSoon);
    hopFly.addEventListener("mouseover", hopChipPeek);
    hopFly.addEventListener("click", async (e) => {
      const tick = e.target.closest("[data-tl-tick]");
      if (tick) { e.stopPropagation(); await applyTlTick(tick); return; }
      const unlink = e.target.closest("[data-unlink]");
      if (unlink) {
        e.stopPropagation();
        keepHopFly();
        const spec = state.hopFly;
        const currentId = (spec && spec.act && spec.act.id) || state.drawerId;
        const L = findHopLink(currentId, unlink.dataset.unlink, unlink.dataset.unlinkGroup);
        if (!L) return toast("No connection to remove");
        await api.deleteLink(L.from, L.kind, L.to);
        await loadGraph();
        toast("Removed " + label(L.from) + " → " + label(L.to));
        if (spec && overlayOpen($("#drawer"))) {
          showHopFlyout($("#drawer"), {
            p: null, act: emptyAct(currentId), actIndex: 0,
            side: spec.side, only: spec.only, tickable: false
          });
        }
        return;
      }
      const hit = e.target.closest("[data-link-hit]");
      if (hit) {
        e.stopPropagation();
        keepHopFly();
        const row = hit.closest(".chip-row") || hit;
        openHopNote(row, hit.dataset.linkGroup, hit.dataset.linkHit);
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) openDrawer(open.dataset.open, true, open);
    });
    const flyTop = $("#hop-fly-top") || hopFly;
    flyTop.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, textarea, select, [data-ov-resize]")) return;
      keepHopFly();
      const r = hopFly.getBoundingClientRect();
      hopFlyDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, pointer: e.pointerId };
      hopFly.classList.add("hop-dragging");
      try { hopFly.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });
    hopFly.addEventListener("pointermove", (e) => {
      if (!hopFlyDrag || e.pointerId !== hopFlyDrag.pointer) return;
      keepHopFly();
      const w = hopFly.offsetWidth;
      const h = hopFly.offsetHeight;
      let left = e.clientX - hopFlyDrag.dx;
      let top = e.clientY - hopFlyDrag.dy;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      hopFly.style.left = Math.round(left) + "px";
      hopFly.style.top = Math.round(top) + "px";
      hopFlyMoved = true;
    });
    hopFly.addEventListener("pointerup", (e) => {
      if (!hopFlyDrag || e.pointerId !== hopFlyDrag.pointer) return;
      hopFlyDrag = null;
      hopFly.classList.remove("hop-dragging");
    });
    hopFly.addEventListener("pointercancel", (e) => {
      if (!hopFlyDrag || e.pointerId !== hopFlyDrag.pointer) return;
      hopFlyDrag = null;
      hopFly.classList.remove("hop-dragging");
    });
  }
  const mainDrawer = $("#drawer");
  if (mainDrawer) {
    mainDrawer.addEventListener("mouseenter", () => { if (overlayOpen($("#hop-flyout"))) keepHopFly(); });
    mainDrawer.addEventListener("mouseleave", hideDockedHopSoon);
  }
  document.addEventListener("mousemove", (e) => {
    lastPtr.x = e.clientX;
    lastPtr.y = e.clientY;
    if (hopFlyMoved || hopFlyDrag) { keepHopFly(); return; }
    if (!hopDockHold) return;
    const dx = e.clientX - hopDockHold.x;
    const dy = e.clientY - hopDockHold.y;
    if (Math.hypot(dx, dy) < 16) { keepHopFly(); return; }
    hopDockHold = null;
    if (pointerOverHopDock(e.clientX, e.clientY)) keepHopFly();
    else hideHopFlySoon();
  });
  async function applyTlClock(inp) {
    const bound = inp.dataset.tlClock;
    const ai = Number(inp.dataset.tlAct);
    await mutatePeriod(inp.dataset.tlPeriod, (p) => {
      const acts = periodActs(p);
      const act = acts[ai];
      if (!act) return;
      if (bound === "start") {
        const dur = Math.max(1, minutesBetween(act.start, act.end));
        act.start = inp.value;
        act.end = addMinutes(act.start, dur);
      } else if (bound === "end") {
        act.end = inp.value;
      } else {
        act.end = addMinutes(act.start, Math.max(1, Math.min(99, Math.round(Number(inp.value) || 1))));
      }
      writeActs(p, acts);
    });
  }
  $("#tl-grid").addEventListener("change", async (e) => {
    const clock = e.target.closest("[data-tl-clock]");
    if (clock) { await applyTlClock(clock); return; }
    const add = e.target.closest("[data-tl-add]");
    if (!add || !add.value) return;
    const id = add.value;
    add.value = "";
    await mutatePeriod(add.dataset.tlPeriod, (p) => {
      const acts = periodActs(p);
      if (acts.some((a) => a.id === id)) return;
      const last = acts[acts.length - 1];
      const start = last ? last.end : DEFAULT_PERIOD_START;
      acts.push(emptyAct(id, start, addMinutes(start, matDuration(matById(id)))));
      writeActs(p, acts);
    }, { fillObjective: true });
  });

  function renderPin() {}
  function setScheduleTab(tab) {
    const monthOn = tab === "month";
    $("#tab-timeline").classList.toggle("on", !monthOn);
    $("#tab-month").classList.toggle("on", monthOn);
    $("#tab-timeline").setAttribute("aria-selected", String(!monthOn));
    $("#tab-month").setAttribute("aria-selected", String(monthOn));
    $("#tl-panel").hidden = monthOn;
    $("#calendar").hidden = !monthOn;
  }
  function syncTlModeBtn() {
    const btn = $("#tl-mode"); if (!btn) return;
    const display = state.tlMode === "display";
    btn.setAttribute("aria-pressed", String(display));
    btn.title = display ? "Edit plan" : "Display plan";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = display
      ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  }
  syncTlModeBtn();
  const calendarView = createCalendarView({
    root: $("#calendar"),
    editable: false,
    getGrade: () => $("#p-grade").value,
    load: () => api.getCalendar(),
    save: async (data) => {
      const cur = await api.getCalendar();
      return api.saveCalendar({ ...data, classDays: data.classDays || cur.classDays });
    },
    onOpenDate: (iso) => {
      $("#p-date").value = iso;
      setScheduleTab("timeline");
      loadPeriod();
    },
    loadLessons: async () => {
      const periods = await api.listPeriods($("#p-grade").value);
      const map = {};
      periods.forEach((p) => {
        const chips = lessonChipsFromSlotIds(
          periodActs(p).map((a) => a.id),
          (id) => { const m = matById(id); return m ? m.name : id; }
        );
        if (chips.length) map[p.date] = chips;
      });
      return map;
    }
  });
  const settingsCalendarView = createCalendarView({
    root: $("#settings-calendar"),
    getGrade: () => ($("#he-grade") && $("#he-grade").value) || $("#p-grade").value,
    load: () => api.getCalendar(),
    save: async (data) => {
      const cur = await api.getCalendar();
      const saved = await api.saveCalendar({ ...data, classDays: data.classDays || cur.classDays });
      calendarView.refresh();
      return saved;
    },
    onOpenDate: (iso) => {
      $("#p-date").value = iso;
      setView("graph");
      setScheduleTab("timeline");
      loadPeriod();
    },
    loadLessons: async () => {
      const g = ($("#he-grade") && $("#he-grade").value) || $("#p-grade").value;
      const periods = await api.listPeriods(g);
      const map = {};
      periods.forEach((p) => {
        const chips = lessonChipsFromSlotIds(
          periodActs(p).map((a) => a.id),
          (id) => { const m = matById(id); return m ? m.name : id; }
        );
        if (chips.length) map[p.date] = chips;
      });
      return map;
    }
  });
  const ARRANGE_DAYS = [
    { n: 1, l: "Mon" }, { n: 2, l: "Tue" }, { n: 3, l: "Wed" }, { n: 4, l: "Thu" },
    { n: 5, l: "Fri" }, { n: 6, l: "Sat" }, { n: 7, l: "Sun" },
  ];
  function fillGradeSelects(cal, keep) {
    const days = (cal && cal.classDays) || { G6: [], G7: [] };
    const grades = Object.keys(days).filter((k) => k !== "all" && GRADE_TOKEN.test(k)).sort();
    const list = grades.length ? grades : ["G6", "G7"];
    const cur = keep || ($("#p-grade") && $("#p-grade").value) || list[0];
    const next = list.indexOf(cur) >= 0 ? cur : list[0];
    ["p-grade", "he-grade", "dr-cn-grade", "peek-cn-grade"].forEach((id) => {
      const sel = $("#" + id);
      if (!sel) return;
      sel.replaceChildren();
      list.forEach((g) => sel.append(el("option", {}, g)));
      sel.value = next;
    });
    return next;
  }
  async function renderArrangement() {
    const host = $("#settings-arrange-body");
    if (!host) return;
    let cal;
    try { cal = await api.getCalendar(); }
    catch (_err) { cal = { classDays: { G6: [], G7: [] } }; }
    fillGradeSelects(cal);
    const days = cal.classDays || { G6: [], G7: [] };
    const grades = Object.keys(days).filter((k) => k !== "all" && GRADE_TOKEN.test(k)).sort();
    const list = grades.length ? grades : ["G6", "G7"];
    host.replaceChildren();
    list.forEach((grade) => {
      const row = el("div", { class: "tl-arrange-grade" });
      row.append(el("b", {}, grade));
      ARRANGE_DAYS.forEach((d) => {
        const lab = el("label", {});
        const cb = el("input", { type: "checkbox" });
        cb.checked = (days[grade] || []).indexOf(d.n) >= 0;
        cb.addEventListener("change", async () => {
          const next = { ...(cal.classDays || {}) };
          const week = (next[grade] || []).slice();
          const i = week.indexOf(d.n);
          if (cb.checked && i < 0) week.push(d.n);
          if (!cb.checked && i >= 0) week.splice(i, 1);
          next[grade] = week.sort((a, b) => a - b);
          cal = await api.saveCalendar({ ...cal, classDays: next });
          toast("Saved arrangement");
          settingsCalendarView.refresh();
          calendarView.refresh();
        });
        lab.append(cb, document.createTextNode(" " + d.l));
        row.append(lab);
      });
      const x = el("button", { type: "button", class: "he-x", title: "Remove grade" }, "×");
      x.addEventListener("click", async () => {
        const keys = Object.keys(cal.classDays || {}).filter((k) => k !== "all" && GRADE_TOKEN.test(k));
        if (keys.length <= 1) { toast("Keep at least one grade"); return; }
        if (!confirm("Remove " + grade + "? Lesson files for that grade stay on disk.")) return;
        const next = { ...(cal.classDays || {}) };
        delete next[grade];
        cal = await api.saveCalendar({ ...cal, classDays: next });
        fillGradeSelects(cal);
        await renderArrangement();
        settingsCalendarView.refresh();
        calendarView.refresh();
        await loadPeriod();
        toast("Removed " + grade);
      });
      row.append(x);
      host.append(row);
    });
  }
  async function addGrade() {
    const input = $("#he-new-grade");
    const name = ((input && input.value) || "").trim();
    if (!name || name === "all" || !GRADE_TOKEN.test(name)) { toast("Use a short id like G8"); return; }
    let cal;
    try { cal = await api.getCalendar(); }
    catch (_err) { cal = { classDays: { G6: [], G7: [] } }; }
    const next = { ...(cal.classDays || { G6: [], G7: [] }) };
    if (next[name]) { toast("That grade is already listed"); return; }
    next[name] = [];
    cal = await api.saveCalendar({ ...cal, classDays: next });
    if (input) input.value = "";
    fillGradeSelects(cal, name);
    await renderArrangement();
    settingsCalendarView.refresh();
    calendarView.refresh();
    toast("Added " + name);
  }
  renderArrangement();
  $("#he-add-grade")?.addEventListener("click", () => addGrade());
  $("#he-new-grade")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addGrade(); }
  });
  $("#he-grade")?.addEventListener("change", async () => {
    const g = $("#he-grade").value;
    if ($("#p-grade")) $("#p-grade").value = g;
    await loadPeriod();
    settingsCalendarView.refresh();
    calendarView.refresh();
  });
  $("#tab-timeline").addEventListener("click", () => {
    $("#p-date").value = isoLocal(new Date());
    setScheduleTab("timeline");
    loadPeriod();
  });
  $("#tl-mode")?.addEventListener("click", async () => {
    if ($("#calendar") && !$("#calendar").hidden) setScheduleTab("timeline");
    state.tlMode = state.tlMode === "display" ? "edit" : "display";
    try { localStorage.setItem(TL_MODE_KEY, state.tlMode); } catch (e) {}
    syncTlModeBtn();
    await renderTimeline();
  });
  $("#tab-month").addEventListener("click", async () => {
    setScheduleTab("month");
    calendarView.setMonthFromIso($("#p-date").value || isoLocal(new Date()));
    await calendarView.refresh();
  });
  $("#p-date").addEventListener("change", loadPeriod);
  $("#p-grade").addEventListener("change", async () => {
    if ($("#he-grade") && $("#p-grade").value) $("#he-grade").value = $("#p-grade").value;
    await loadPeriod();
    if (!$("#calendar").hidden) await calendarView.refresh();
    if (document.body.classList.contains("view-hyperedges")) await settingsCalendarView.refresh();
  });

  /* ==========================================================================
     RENDER — PANEL 4: REFLECTION + SUGGESTION
     ========================================================================== */
  function renderReflection() {
    const p = state.period || {};
    const r = p.reflection || { flags: [], text: "" };
    let flags = r.flags || [];
    FLAG_PAIRS.forEach(([a, b]) => {
      if (flags.includes(a) && flags.includes(b)) {
        const keep = flags.lastIndexOf(a) > flags.lastIndexOf(b) ? a : b;
        flags = flags.filter((f) => f !== a && f !== b).concat(keep);
      }
    });
    const when = $("#refl-when");
    if (when) when.textContent = p.date ? fmtDate(p.date) + " · " + (p.grade || "") : "";
    document.querySelectorAll("#flags [data-flag]").forEach((b) => b.classList.toggle("on", flags.includes(b.dataset.flag)));
    const text = $("#refl-text"); if (text) text.value = r.text || "";
    const goal = $("#next-goal"); if (goal) goal.value = p.nextGoal || "";
    const saved = $("#refl-saved"); if (saved) saved.textContent = r.savedAt ? "saved " + new Date(r.savedAt).toLocaleString() : "";
  }
  $("#flags").addEventListener("click", (e) => {
    const b = e.target.closest("[data-flag]"); if (!b) return;
    const turningOn = !b.classList.contains("on");
    b.classList.toggle("on");
    if (!turningOn) return;
    const pair = FLAG_PAIRS.find((x) => x.includes(b.dataset.flag));
    if (!pair) return;
    const other = pair.find((f) => f !== b.dataset.flag);
    document.querySelectorAll("#flags [data-flag]").forEach((x) => { if (x.dataset.flag === other) x.classList.remove("on"); });
  });
  $("#refl-save").addEventListener("click", async () => {
    if (!state.period) return;
    state.period.reflection = { flags: [...document.querySelectorAll("#flags .on")].map((b) => b.dataset.flag), text: $("#refl-text").value.trim(), savedAt: new Date().toISOString() };
    state.period.nextGoal = ($("#next-goal") && $("#next-goal").value.trim()) || "";
    await api.savePeriod(state.period);
    renderReflection();
    renderReads();
    await renderTimeline();
    toast("Reflection saved");
  });

  $("#tl-obj-text")?.addEventListener("click", (e) => e.stopPropagation());
  let objSummarizing = false;
  $("#tl-obj-text")?.addEventListener("focusout", async (e) => {
    const next = ($("#tl-obj-text") && $("#tl-obj-text").value.trim()) || "";
    if (objSummarizing) return;
    if (e.relatedTarget && (e.relatedTarget.id === "tl-obj-sum" || e.relatedTarget.closest("#tl-obj-sum"))) return;
    if (!state.period) return;
    if (!next) return;
    if ((state.period.objective || "") === next) return;
    state.period.objective = next;
    await api.savePeriod(state.period);
  });
  $("#tl-obj-sum")?.addEventListener("pointerdown", () => { objSummarizing = true; });
  $("#tl-obj-sum")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    objSummarizing = true;
    if (!state.period) { objSummarizing = false; return; }
    const btn = $("#tl-obj-sum");
    const st = $("#tl-obj-status");
    const acts = periodActs(state.period);
    const draft = ($("#tl-obj-text") && $("#tl-obj-text").value) || "";
    if (!acts.length && !draft.trim()) { objSummarizing = false; return toast("Write an aim or pin an activity first"); }
    btn.disabled = true;
    if (st) st.textContent = "…";
    try {
      const p = state.period;
      const seen = new Set();
      const mats = [];
      acts.forEach((a) => {
        if (seen.has(a.id)) return;
        seen.add(a.id);
        const m = matById(a.id);
        if (m) mats.push({ id: m.id, name: m.name, look: m.look, notes: m.notes || "", duration: matDuration(m) });
      });
      const { text } = await api.polish("objective", draft, JSON.stringify({
        period: { id: p.id, date: p.date, grade: p.grade, activities: periodActs(p) },
        materials: mats
      }));
      if (!text) throw new Error("empty summary");
      p.objective = text;
      const saved = await api.savePeriod(p);
      state.period = saved && saved.id === p.id ? { ...p, ...saved, objective: saved.objective || text } : { ...p, objective: text };
      fillObjDock(state.period);
      const ta = $("#tl-obj-text");
      if (ta) {
        ta.value = state.period.objective || text;
        ta.readOnly = false;
        ta.focus();
      }
      if (st) st.textContent = "saved";
      toast("Objective saved");
    } catch (err) {
      if (st) st.textContent = String(err.message || err).slice(0, 120);
    } finally {
      objSummarizing = false;
      btn.disabled = false;
    }
  });

  function suggestButtonLabel(date) {
    return date ? "Suggest next · " + fmtDate(date) : "Suggest next";
  }
  async function refreshSuggestLabel() {
    const btn = $("#suggest");
    if (!btn || btn.disabled) return;
    const grade = $("#p-grade").value;
    const from = (state.period && state.period.date) || $("#p-date").value;
    const periods = await api.listPeriods(grade);
    const date = firstBlankDate(periods, from);
    if (!state.suggestion) state.suggestionDate = date;
    btn.textContent = suggestButtonLabel(state.suggestionDate || date);
    btn.title = "First blank date: " + (state.suggestionDate || date) + "-" + grade + ". Reads foci, graph, this pin, and the reflection.";
  }
  function renderReads() {
    refreshSuggestLabel();
  }

  $("#suggest").addEventListener("click", async () => {
    await runSuggest("last");
  });
  $("#suggest-last")?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runSuggest("last");
  });
  $("#suggest-goal")?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runSuggest("goal");
  });
  async function runSuggest(mode) {
    if (!state.period) return toast("Open a period first");
    const menu = $("#suggest-menu");
    if (menu) menu.open = false;
    let goal = "";
    if (mode === "goal") {
      goal = (($("#next-goal") && $("#next-goal").value) || state.period.nextGoal || "").trim();
      if (!goal) {
        const ng = $("#next-goal");
        if (ng) ng.focus();
        toast("Type next lesson's goal first");
        return;
      }
    }
    const btn = $("#suggest"); btn.disabled = true; btn.textContent = "sending…";
    const st = $("#suggest-status"); st.classList.remove("err"); st.textContent = "";
    try {
      if (!state.hitlSession) throw new Error("open this page from the Cursor session link");
      await api.hitlPost(state.hitlSession, { text: mode === "goal" ? goal : "Suggest the next lesson from the last period.", agree: false });
      st.textContent = "Sent to Cursor";
    } catch (err) {
      st.classList.add("err");
      st.textContent = "Suggestion failed: " + err.message;
    } finally { btn.disabled = false; btn.textContent = suggestButtonLabel(state.suggestionDate); }
  }

  function renderSuggestion() {
    const s = state.suggestion;
    const st = $("#suggest-status");
    st.classList.remove("err");
    const btn = $("#suggest");
    if (btn && !btn.disabled) btn.textContent = suggestButtonLabel(state.suggestionDate);
    st.textContent = s ? (state.suggestionDate ? "On " + fmtDate(state.suggestionDate) + " →" : "On the timeline →") : "";
    $("#s-accept").hidden = !s;
    $("#s-edit").hidden = !s;
    renderTimeline();
  }

  /** accept → write the three ids into the first blank FLAG date after this period (empty pins, or a new file after the last class). PUT /api/periods/:id */
  $("#s-accept").addEventListener("click", async () => {
    const s = state.suggestion; if (!s) return;
    const grade = $("#p-grade").value;
    const periods = await api.listPeriods(grade);
    const date = state.suggestionDate || firstBlankDate(periods, $("#p-date").value);
    const id = date + "-" + grade;
    const existing = periods.find((p) => p.date === date) || (await api.getPeriod(id));
    const next = {
      id, date, grade,
      activities: (s.picks || []).map((pick) => emptyAct(pick.id, pick.start, pick.end)),
      reflection: (existing && existing.reflection) || { flags: [], text: "" },
      plan: existing && existing.plan
    };
    await api.savePeriod(next); state.suggestion = null; state.suggestionDate = null; $("#p-date").value = date; await loadPeriod(); toast("Accepted into " + next.id);
  });
  /** edit → pin picks onto the current period so the teacher can edit before saving */
  $("#s-edit").addEventListener("click", async () => {
    const s = state.suggestion; if (!s) return;
    state.period.activities = (s.picks || []).map((pick) => emptyAct(pick.id, pick.start, pick.end));
    await api.savePeriod(state.period); renderPin(); renderReads(); await renderTimeline(); toast("Suggestion placed on this period — edit freely");
  });
  /** hop → focus a harder hop chip on the current period */
  $("#s-hop").addEventListener("click", () => {
    const hop = document.querySelector("#tl-grid .tl-col.now .tl-cell .chip.harder");
    if (hop) { hop.focus(); hop.scrollIntoView({ block: "center" }); } else toast("Pin an activity first");
  });

  /* ==========================================================================
     BOOT
     ========================================================================== */
  async function loadGraph(opts) {
    state.materials = await api.listMaterials();
    state.links = await api.listLinks();
    try { state.sets = await api.listSets(); } catch (e) { state.sets = []; }
    renderMaterials();
    renderLinks();
    fillRelatedTagList();
    graphView.update(state.materials, state.links, state.sets, state.pendingOps || []);
    renderHyperedges();
    if (state.period && !(opts && opts.skipTimeline)) { renderPin(); renderReads(); await renderTimeline(); }
    const dr = $("#drawer");
    if (dr && dr.classList.contains("open") && state.drawerId && matById(state.drawerId)) {
      openDrawer(state.drawerId, true, state.drawerAnchor);
    }
  }
  graphView = createGraphView({
    sketchSrc,
    toast,
    onCreateLink: async (L) => {
      const r = await api.createLink(L);
      if (!r) { toast("That link already exists"); return; }
      await loadGraph();
      toast("Linked " + label(L.from) + " → " + label(L.to));
    },
    onDeleteLink: async (from, kind, to) => {
      await api.deleteLink(from, kind, to);
      await loadGraph();
    },
    onSearch: (q) => api.search(q, 12),
    onPolish: (kind, text, context) => api.polish(kind, text, context),
    onCreateSet: async (input) => {
      try {
        const s = await api.createSet(input);
        await loadGraph();
        toast("Activity set " + (s.name || s.id));
        return s;
      } catch (err) {
        toast("Could not save activity set — " + (err instanceof Error ? err.message : String(err)));
        throw err;
      }
    },
    onUpdateSet: async (id, patch) => {
      await api.updateSet(id, patch);
      await loadGraph();
    },
    onDeleteSet: async (id) => {
      await api.deleteSet(id);
      if (state.addSet && state.addSet.setId === id) state.addSet = null;
      await loadGraph();
      toast("Activity set removed");
    },
    onAddSetToTimeline: (id) => {
      state.addSet = { setId: id };
      const tl = $("#timeline");
      if (tl) tl.scrollIntoView({ block: "start" });
      toast("Click + add activity set on the timeline");
    },
    onPeekNode: (id, anchor) => {
      openDrawer(id, true, anchor);
    },
    onHoverPeek: (id, anchor) => {
      const pending = (state.pendingOps || []).some((o) => o.tempId === id);
      showPeek(anchor, id, "right", !pending);
    },
    onHoverPeekLeave: hidePeekSoon,
    onEdgeHover: (anchor, edge) => {
      const L = edge && edge.links && edge.links[0];
      if (!L) return;
      const op = (state.pendingOps || []).find((o) => o.entity === "link" && o.from === L.from && o.to === L.to && o.kind === L.kind);
      const id = op && op.tempId ? op.tempId : L.from + "|" + L.kind + "|" + L.to;
      showPeek(anchor, id, "right");
    },
    onEdgeLeave: hidePeekSoon,
    onUpdateMaterial: async (id, patch) => {
      await api.updateMaterial(id, patch);
      const m = matById(id);
      if (m && patch && typeof patch.look === "string") m.look = patch.look;
      if (m && patch && typeof patch.notes === "string") m.notes = patch.notes;
      toast(patch && typeof patch.notes === "string" && typeof patch.look !== "string" ? "Explanation saved" : "Look saved");
    },
    onHopHover: (anchor, info) => {
      const k = info.kind;
      const side = k === "progression" ? "right" : "left";
      const only = k === "regression" ? ["easier"] : k === "progression" ? ["harder"] : ["alts"];
      closePeek();
      showHopFlyout(anchor, {
        p: null, act: emptyAct(info.id), actIndex: 0,
        side, only, tickable: false
      }, true);
    },
    onHopLeave: hideDockedHopSoon,
  });

  function heSetTag(s, drag) {
    const tag = el("span", { class: "kg-facet-chip", "data-set": s.id });
    tag.append(s.name || s.id);
    tag.append(el("button", { type: "button", class: "he-x", "data-he-del-set": s.id, title: "Delete activity set" }, "×"));
    if (drag) {
      tag.draggable = true;
      tag.setAttribute("data-he-drag", s.id);
    }
    return tag;
  }
  function renderHyperedges() {
    const q = (($("#he-search") && $("#he-search").value) || "").trim().toLowerCase();
    const match = (s) => !q || (s.name || "").toLowerCase().includes(q) || (s.id || "").toLowerCase().includes(q);
    const ind = $("#he-independent");
    if (ind) {
      const items = roots(state.sets || [], "independent").filter(match);
      ind.replaceChildren();
      if (!items.length) ind.append(el("span", { class: "mute" }, roots(state.sets || [], "independent").length ? "No matches" : "None"));
      else items.forEach((s) => ind.append(heSetTag(s, true)));
    }
    const first = $("#he-first");
    if (first) {
      first.replaceChildren();
      const skills = roots(state.sets || [], "first");
      let n = 0;
      skills.forEach((skill) => {
        const kids = childrenOf(state.sets || [], skill.id);
        const skillHit = match(skill);
        const shownKids = kids.filter((k) => skillHit || match(k));
        if (!skillHit && !shownKids.length) return;
        n += 1;
        const group = el("div", { class: "he-skill", "data-he-drop-parent": skill.id });
        const head = el("div", { class: "he-skill-head" });
        const title = el("div", { class: "he-skill-title", "data-set": skill.id }, skill.name || skill.id);
        const x = el("button", { type: "button", class: "he-x", "data-he-del-skill": skill.id, title: "Delete skill" }, "×");
        head.append(title, x);
        const list = el("div", { class: "he-list" });
        if (!shownKids.length) list.append(el("span", { class: "mute" }, kids.length ? "No matches" : "No activity sets"));
        else shownKids.forEach((s) => list.append(heSetTag(s, true)));
        group.append(head, list);
        first.append(group);
      });
      if (!n) first.append(el("span", { class: "mute" }, skills.length ? "No matches" : "None"));
    }
  }
  async function createFirstLevel() {
    const input = $("#he-new-name");
    const name = ((input && input.value) || "").trim();
    if (!name) { toast("Name the skill"); return; }
    try {
      const s = await api.createSet({ name, members: [], parent: null });
      if (input) input.value = "";
      await loadGraph();
      toast("Skill " + (s.name || s.id));
    } catch (err) {
      toast("Could not save skill — " + (err instanceof Error ? err.message : String(err)));
    }
  }
  function setView(v) {
    if (v === "chat") v = "graph";
    state.view = v === "table" || v === "hyperedges" ? v : "graph";
    document.body.classList.toggle("view-graph", state.view === "graph");
    document.body.classList.toggle("view-table", state.view === "table");
    document.body.classList.toggle("view-hyperedges", state.view === "hyperedges");
    document.querySelectorAll("#view-toggle [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (e) {}
    if (state.view === "graph") requestAnimationFrame(() => graphView.restoreCamera());
    if (state.view === "hyperedges") {
      renderHyperedges();
      renderArrangement();
      settingsCalendarView.refresh();
    }
  }
  const viewToggle = $("#view-toggle");
  if (viewToggle) {
    viewToggle.addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]");
      if (b) setView(b.dataset.view);
    });
  }
  const heSearch = $("#he-search");
  if (heSearch) heSearch.addEventListener("input", () => renderHyperedges());
  const hePage = $("#hyperedges");
  if (hePage) {
    hePage.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-he-del-skill], [data-he-del-set]");
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        const id = del.dataset.heDelSkill || del.dataset.heDelSet;
        const set = (state.sets || []).find((s) => s.id === id);
        if (!set) return;
        const skillDel = !!del.dataset.heDelSkill;
        const msg = skillDel
          ? "Delete skill " + (set.name || set.id) + "? Activity sets under it become independent."
          : "Delete activity set " + (set.name || set.id) + "?";
        if (!confirm(msg)) return;
        try {
          await api.deleteSet(set.id);
          await loadGraph();
          toast(skillDel ? "Skill removed" : "Activity set removed");
        } catch (err) {
          toast("Could not delete — " + (err instanceof Error ? err.message : String(err)));
        }
        return;
      }
      const span = e.target.closest("[data-set]");
      if (!span) return;
      showSetMemberFly(span, span.dataset.set);
      requestAnimationFrame(() => { hopFlyMoved = true; keepHopFly(); });
    });
    hePage.addEventListener("dragstart", (e) => {
      if (e.target.closest("[data-he-del-skill], [data-he-del-set]")) {
        e.preventDefault();
        return;
      }
      const tag = e.target.closest("[data-he-drag]");
      if (!tag || !e.dataTransfer) return;
      e.dataTransfer.setData("text/plain", tag.dataset.heDrag);
      e.dataTransfer.effectAllowed = "move";
      closeHopFlyout();
      closePeek();
    });
    hePage.addEventListener("dragend", () => {
      hePage.querySelectorAll(".he-drop").forEach((n) => n.classList.remove("he-drop"));
    });
    hePage.addEventListener("dragover", (e) => {
      const zone = e.target.closest("[data-he-drop-parent]");
      if (!zone) return;
      e.preventDefault();
      hePage.querySelectorAll(".he-drop").forEach((n) => { if (n !== zone) n.classList.remove("he-drop"); });
      zone.classList.add("he-drop");
    });
    hePage.addEventListener("drop", async (e) => {
      const zone = e.target.closest("[data-he-drop-parent]");
      hePage.querySelectorAll(".he-drop").forEach((n) => n.classList.remove("he-drop"));
      if (!zone || !e.dataTransfer) return;
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      const raw = zone.dataset.heDropParent;
      const parent = !raw || raw === "independent" ? null : raw;
      const cur = (state.sets || []).find((s) => s.id === id);
      if (!cur || id === parent) return;
      const curParent = cur.parent || null;
      if (curParent === parent) return;
      if (wouldCycle(state.sets || [], id, parent)) { toast("That parent would cycle"); return; }
      try {
        await api.updateSet(id, { parent });
        await loadGraph();
        toast((cur.name || id) + (parent ? " → " + ((state.sets.find((s) => s.id === parent) || {}).name || parent) : " → independent"));
      } catch (err) {
        toast("Could not move — " + (err instanceof Error ? err.message : String(err)));
      }
    });
  }
  const heCreate = $("#he-create");
  if (heCreate) heCreate.addEventListener("click", () => createFirstLevel());
  const heNewName = $("#he-new-name");
  if (heNewName) {
    heNewName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createFirstLevel();
      }
    });
  }
  function pendingCards() {
    const ops = state.pendingOps || [];
    const creates = ops.filter((o) => o.entity === "material" && o.action === "create");
    const createIds = new Set(creates.map((o) => o.tempId));
    const pictures = ops.filter((o) => o.entity === "material" && o.action === "update" && o.sketch && !createIds.has(o.id));
    const links = ops.filter((o) => o.entity === "link" && o.action === "create");
    return { creates, pictures, links };
  }
  function markPendingHot(id, on) {
    document.querySelectorAll("#kg-svg .kg-node").forEach((g) => {
      const t = g.querySelector("text.kg-id");
      if (t && t.textContent === id) g.classList.toggle("kg-hot", on);
    });
    document.querySelectorAll("#kg-svg .kg-edge").forEach((line) => {
      const ends = line.getAttribute("data-ends") || "";
      if (ends.split("|").includes(id)) line.classList.toggle("kg-hot", on);
    });
  }
  function renderPending() {
    const host = $("#kg-pending");
    const stage = document.querySelector(".kg-stage");
    if (!host) return;
    const open = !!state.hitlSession;
    host.hidden = !open;
    if (stage) stage.classList.toggle("has-pending", open);
    if (!open) return;
    const { creates, pictures, links } = pendingCards();
    const sel = state.pendingSel || (state.pendingSel = new Set());
    host.replaceChildren();
    const scroll = el("div", { class: "kg-pending-scroll" });
    const section = (title, rows, kind) => {
      scroll.append(el("div", { class: "kg-pending-h" }, title));
      if (!rows.length) scroll.append(el("p", { class: "mute" }, "None"));
      rows.forEach((op) => {
        const discarded = op.status === "discarded";
        const card = el("div", { class: "kg-pending-card" + (discarded ? " discarded" : ""), "data-pending": op.tempId });
        const acts = el("div", { class: "kg-pending-acts" });
        const glyph = (d) => {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("viewBox", "0 0 16 16");
          svg.setAttribute("aria-hidden", "true");
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "currentColor");
          path.setAttribute("stroke-width", "1.7");
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");
          svg.append(path);
          return svg;
        };
        if (discarded) {
          const undo = el("button", { type: "button", class: "btn", "data-act": "undo", title: "Undo" });
          undo.append(glyph("M8 3.6 5 6.6 8 9.6 M5.2 6.6H10a3 3 0 1 1 0 6H8"));
          acts.append(undo);
        } else {
          const tick = el("button", { type: "button", class: "btn" + (sel.has(op.tempId) ? " solid" : ""), "data-act": "tick", title: "Select" });
          tick.append(glyph("M3.2 8.2 6.4 11.4 12.8 4.4"));
          acts.append(tick);
          const drop = el("button", { type: "button", class: "btn", "data-act": "x", title: "Discard draft" });
          drop.append(glyph("M4 4 12 12 M12 4 4 12"));
          acts.append(drop);
        }
        const body = el("div", {});
        const name = kind === "link"
          ? pendingLabel(op.from) + " → " + pendingLabel(op.to)
          : (op.name || (op.sketch ? String(op.sketch).split("/").pop() : op.tempId));
        body.append(el("div", { class: "kg-pending-name" }, name));
        body.append(el("div", { class: "kg-pending-meta" }, kind === "link" ? (op.kind || "progression") : (op.tempId + (op.look ? " · " + op.look : ""))));
        card.append(acts, body);
        card.addEventListener("mouseenter", () => {
          card.classList.add("hot");
          markPendingHot(kind === "link" ? op.from : (op.action === "update" ? op.id : op.tempId), true);
          showPeek(card, op.tempId, "left", true);
        });
        card.addEventListener("mouseleave", () => {
          card.classList.remove("hot");
          markPendingHot(kind === "link" ? op.from : (op.action === "update" ? op.id : op.tempId), false);
          hidePeekSoon();
        });
        scroll.append(card);
      });
    };
    section("Add material", creates.concat(pictures), "material");
    section("Add connections", links, "link");
    const foot = el("div", { class: "kg-pending-foot" });
    const ticks = el("div", { class: "kg-pending-ticks" });
    const matBox = el("input", { type: "checkbox", "data-kind": "material" });
    const linkBox = el("input", { type: "checkbox", "data-kind": "link" });
    const liveMats = creates.concat(pictures).filter((o) => o.status !== "discarded");
    const liveLinks = links.filter((o) => o.status !== "discarded");
    matBox.checked = liveMats.length > 0 && liveMats.every((o) => sel.has(o.tempId));
    linkBox.checked = liveLinks.length > 0 && liveLinks.every((o) => sel.has(o.tempId));
    const matLab = el("label", {}, "Materials");
    matLab.prepend(matBox);
    const linkLab = el("label", {}, "Connections");
    linkLab.prepend(linkBox);
    ticks.append(matLab, linkLab);
    foot.append(ticks, el("button", { type: "button", class: "btn solid", id: "kg-pending-approve" }, "Approve"));
    host.append(scroll, foot);
  }
  async function approvePending() {
    const sel = state.pendingSel || new Set();
    const ops = (state.pendingOps || []).filter((o) => o.status !== "discarded" && sel.has(o.tempId));
    const chosenMats = new Set(ops.filter((o) => o.entity === "material" && o.action === "create").map((o) => o.tempId));
    const real = new Set((state.materials || []).map((m) => m.id));
    for (const o of ops) {
      if (o.entity !== "link") continue;
      for (const end of [o.from, o.to]) {
        const pendingMat = (state.pendingOps || []).find((x) => x.tempId === end && x.entity === "material" && x.action === "create" && x.status !== "discarded");
        if (pendingMat && !chosenMats.has(end)) {
          toast("Approve " + (pendingMat.name || end) + " with this connection");
          return;
        }
        if (!pendingMat && !real.has(end)) {
          toast("Unknown " + end);
          return;
        }
      }
    }
    const extra = (state.pendingOps || []).filter((o) => o.status !== "discarded" && o.entity === "material" && o.action === "update" && o.sketch && chosenMats.has(o.id) && !sel.has(o.tempId));
    const all = ops.concat(extra);
    if (!all.length) {
      if ((state.pendingOps || []).some((o) => o.status !== "discarded")) {
        toast("Tick a card, or Materials / Connections");
        return;
      }
      await api.hitlPost(state.hitlSession, { agree: true });
      toast("Agreed");
      return;
    }
    const payload = all.map((o) => {
      const copy = Object.assign({}, o);
      delete copy.status;
      delete copy.cascade;
      return copy;
    });
    const res = await api.applyKgOps(payload);
    if (res && res.errors && res.errors.length) {
      toast(String(res.errors[0]).slice(0, 180));
      return;
    }
    await api.hitlPost(state.hitlSession, { approved: { ids: all.map((o) => o.tempId), idMap: (res && res.ids) || {} }, agree: true });
    state.pendingSel = new Set();
    await loadGraph();
    const row = await api.hitlGet(state.hitlSession);
    const left = (row.draft && row.draft.ops) || [];
    if (!left.length) {
      leaveReview();
      toast("Approved");
      return;
    }
    state.pendingOps = left;
    graphView.update(state.materials, state.links, state.sets, left);
    renderPending();
    toast("Approved");
  }
  document.addEventListener("click", async (e) => {
    const approve = e.target.closest("#kg-pending-approve");
    if (approve) {
      e.preventDefault();
      try { await approvePending(); } catch (err) { toast(String(err.message || err).slice(0, 180)); }
      return;
    }
    const act = e.target.closest("#kg-pending [data-act]");
    if (!act) return;
    const card = act.closest("[data-pending]");
    if (!card) return;
    const id = card.dataset.pending;
    if (act.dataset.act === "tick") {
      if (state.pendingSel.has(id)) state.pendingSel.delete(id);
      else state.pendingSel.add(id);
      renderPending();
      return;
    }
    const status = act.dataset.act === "x" ? "discarded" : "pending";
    try {
      await api.hitlPost(state.hitlSession, { op_status: { id, status } });
      const row = await api.hitlGet(state.hitlSession);
      state.pendingOps = (row.draft && row.draft.ops) || [];
      if (status === "discarded") state.pendingSel.delete(id);
      graphView.update(state.materials, state.links, state.sets, state.pendingOps);
      renderPending();
    } catch (err) {
      toast(String(err.message || err).slice(0, 180));
    }
  });
  document.addEventListener("change", (e) => {
    const box = e.target.closest("#kg-pending input[data-kind]");
    if (!box) return;
    const kind = box.dataset.kind;
    const { creates, pictures, links } = pendingCards();
    const rows = kind === "link" ? links : creates.concat(pictures);
    rows.filter((o) => o.status !== "discarded").forEach((o) => {
      if (box.checked) state.pendingSel.add(o.tempId);
      else state.pendingSel.delete(o.tempId);
    });
    renderPending();
  });
  let hitlTimer = 0;
  function leaveReview() {
    if (hitlTimer) window.clearInterval(hitlTimer);
    hitlTimer = 0;
    state.hitlSession = "";
    state.pendingOps = [];
    state.pendingSel = new Set();
    const url = new URL(location.href);
    url.searchParams.delete("session");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    graphView.update(state.materials, state.links, state.sets, []);
    renderPending();
  }
  function startHitl(sessionId) {
    if (hitlTimer) window.clearInterval(hitlTimer);
    state.hitlSession = sessionId;
    if (!state.pendingSel) state.pendingSel = new Set();
    let last = "";
    hitlTimer = window.setInterval(async () => {
      try {
        const row = await api.hitlGet(sessionId);
        if (state.hitlSession !== sessionId) return;
        const ops = (row.draft && row.draft.ops) || [];
        const key = JSON.stringify(ops);
        if (key !== last) {
          last = key;
          state.pendingOps = ops;
          graphView.update(state.materials, state.links, state.sets, ops);
          renderPending();
        }
      } catch (e) { /* session server may still be starting */ }
    }, 1000);
    renderPending();
  }

  async function boot() {
    fillAddFacets();
    try {
      const cal = await api.getCalendar();
      const g = localStorage.getItem(GRADE_KEY);
      fillGradeSelects(cal, g && g !== "all" && GRADE_TOKEN.test(g) ? g : undefined);
    } catch (e) {
      fillGradeSelects({ classDays: { G6: [], G7: [] } });
    }
    $("#p-date").value = isoLocal(new Date());
    state.foci = await api.getFoci(); renderFoci();
    try { state.canva = (await api.listSketches()).canva; } catch (e) { state.canva = []; }
    await loadGraph(); await loadPeriod();
    try {
      const savedView = localStorage.getItem(VIEW_KEY);
      if (savedView) setView(savedView);
    } catch (e) {}
    calendarView.setMonthFromIso($("#p-date").value);
    try { await calendarView.refresh(); } catch (e) { console.error("calendar", e); }
    try { await settingsCalendarView.refresh(); } catch (e) { console.error("settings-calendar", e); }
    const params = new URLSearchParams(location.search);
    state.hitlSession = params.get("session") || "";
    if (state.hitlSession) startHitl(state.hitlSession);
    const peek = params.get("peek");
    if (peek) showPeek($("#kg-svg") || document.body, peek, "right");
    try {
      const h = await fetch("/api/health").then((r) => r.json());
      $("#status").textContent = h.store ? "server: " + h.store : "server";
    } catch (e) {
      $("#status").textContent = "server unreachable";
    }
  }
  boot();
