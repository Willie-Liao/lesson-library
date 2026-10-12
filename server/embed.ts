import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Material, MaterialSet, SearchHit, SearchResult } from "../web/types.ts";
import { pathLabel } from "../web/set-tree.ts";
import { listMaterials, listSets } from "./store.ts";

type CacheFile = {
  model: string;
  items: Record<string, { hash: string; vector: number[] }>;
};

function env(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function cachePath(base: string) {
  return path.join(base, "library", "_embeddings.json");
}

export function materialText(m: Material, sets: MaterialSet[] = []): string {
  const setBits = sets
    .filter((s) => s.members.includes(m.id))
    .flatMap((s) => [pathLabel(sets, s.id), s.note || ""]);
  return [m.name, m.look, m.notes || "", ...(m.classNotes || []).map((n) => n.text || ""), ...setBits]
    .filter((s) => String(s).trim())
    .join(". ");
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function loadCache(base: string): CacheFile {
  const p = cachePath(base);
  if (!existsSync(p)) return { model: env("EMBED_MODEL", "all-MiniLM-L6-v2"), items: {} };
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
    return { model: data.model || env("EMBED_MODEL", "all-MiniLM-L6-v2"), items: data.items || {} };
  } catch {
    return { model: env("EMBED_MODEL", "all-MiniLM-L6-v2"), items: {} };
  }
}

function saveCache(base: string, cache: CacheFile) {
  writeFileSync(cachePath(base), JSON.stringify(cache));
}

let cacheMem: CacheFile | null = null;

export function invalidateEmbeddings(base: string, id?: string) {
  const cache = cacheMem || loadCache(base);
  if (id) delete cache.items[id];
  else cache.items = {};
  cacheMem = cache;
  saveCache(base, cache);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const url = env("EMBED_URL", "http://127.0.0.1:8788").replace(/\/$/, "");
  try {
    const r = await fetch(url + "/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { vectors?: number[][] };
    if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) return null;
    return data.vectors;
  } catch {
    return null;
  }
}

function emptySearch(): SearchResult {
  return { hits: [], mode: "text", keyword: [], semantic: [] };
}

function textSearch(q: string, materials: Material[], sets: MaterialSet[], k: number): SearchHit[] {
  const needle = q.trim().toLowerCase();
  const hits: SearchHit[] = [];
  if (!needle) return hits;
  for (const m of materials) {
    const blob = (m.id + " " + materialText(m, sets)).toLowerCase();
    if (!blob.includes(needle)) continue;
    const setHit = sets.some((s) => s.members.includes(m.id) && (pathLabel(sets, s.id) + " " + (s.note || "")).toLowerCase().includes(needle));
    let score = 0.5;
    if (m.name.toLowerCase().includes(needle)) score = 1;
    else if (m.look.toLowerCase().includes(needle)) score = 0.8;
    else if (setHit) score = 0.7;
    hits.push({ id: m.id, score, name: m.name });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

export async function searchMaterials(base: string, q: string, k = 8): Promise<SearchResult> {
  const materials = listMaterials(base);
  const sets = listSets(base);
  const query = (q || "").trim();
  if (!query) return emptySearch();
  const limit = Math.max(1, Math.min(40, Number(k) || 8));
  const keyword = textSearch(query, materials, sets, limit);

  const cache = cacheMem || loadCache(base);
  cacheMem = cache;
  const missing: { id: string; text: string }[] = [];
  for (const m of materials) {
    const text = materialText(m, sets);
    const hash = sha1(text);
    const cur = cache.items[m.id];
    if (!cur || cur.hash !== hash || !cur.vector?.length) missing.push({ id: m.id, text });
  }

  const qVecs = await embedTexts([query, ...missing.map((x) => x.text)]);
  if (!qVecs) return { hits: keyword, mode: "text", keyword, semantic: [] };

  const qVec = qVecs[0];
  missing.forEach((item, i) => {
    cache.items[item.id] = { hash: sha1(item.text), vector: qVecs[i + 1] };
  });
  if (missing.length) saveCache(base, cache);

  const semantic: SearchHit[] = [];
  for (const m of materials) {
    const vec = cache.items[m.id]?.vector;
    if (!vec) continue;
    semantic.push({ id: m.id, score: cosine(qVec, vec), name: m.name });
  }
  semantic.sort((a, b) => b.score - a.score);
  const top = semantic.slice(0, limit);
  return { hits: top, mode: "embed", keyword, semantic: top };
}

function l2(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

function dist2(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    s += d * d;
  }
  return s;
}

/** Lloyd k-means. Feature = [duration/40, ...L2(vector)]. Cluster 0 = shortest mean duration. */
export function clusterByTimeAndContent(
  items: { id: string; duration?: number }[],
  vectors: Record<string, number[]> = {},
  k = 3,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!items.length) return out;
  const kk = Math.max(1, Math.min(k, items.length));
  const padded = items.map((m) => {
    const dur = Math.min(40, Math.max(1, Number(m.duration) || 20)) / 40;
    return [dur, ...l2(vectors[m.id] || [])];
  });
  const dim = Math.max(...padded.map((r) => r.length), 1);
  const X = padded.map((row) => {
    const v = Array.from({ length: dim }, () => 0);
    row.forEach((n, i) => {
      v[i] = n;
    });
    return v;
  });
  const byDur = items.map((_, i) => i).sort((a, b) => (Number(items[a]!.duration) || 20) - (Number(items[b]!.duration) || 20));
  const seeds = Array.from({ length: kk }, (_, c) => {
    const idx = byDur[Math.min(byDur.length - 1, Math.floor(((c + 0.5) * byDur.length) / kk))]!;
    return X[idx]!.slice();
  });
  let assign = Array.from({ length: items.length }, () => 0);
  for (let iter = 0; iter < 40; iter++) {
    const next = X.map((x) => {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = dist2(x, seeds[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    });
    if (next.every((v, i) => v === assign[i])) break;
    assign = next;
    for (let c = 0; c < kk; c++) {
      const members = X.filter((_, i) => assign[i] === c);
      if (!members.length) continue;
      const mean = Array.from({ length: dim }, () => 0);
      for (const row of members) {
        for (let j = 0; j < dim; j++) mean[j] += row[j] || 0;
      }
      seeds[c] = mean.map((n) => n / members.length);
    }
  }
  const meanDur = Array.from({ length: kk }, () => 0);
  const count = Array.from({ length: kk }, () => 0);
  assign.forEach((c, i) => {
    meanDur[c] += Number(items[i]!.duration) || 20;
    count[c] += 1;
  });
  const order = Array.from({ length: kk }, (_, c) => c).sort(
    (a, b) => meanDur[a] / (count[a] || 1) - meanDur[b] / (count[b] || 1),
  );
  const remap = new Map(order.map((old, neu) => [old, neu]));
  items.forEach((m, i) => out.set(m.id, remap.get(assign[i]!) ?? 0));
  return out;
}
