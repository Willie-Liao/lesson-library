import type { CalendarData, Foci, Link, LinkKind, Material, MaterialSet, PatchOp, Period, SearchResult, Suggestion } from "./types";

export async function http<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(method + " " + path + " → " + r.status + " " + t);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}

export const api = {
  async listMaterials() {
    return http<Material[]>("GET", "/api/materials");
  },
  async createMaterial(m: Partial<Material>) {
    return http<Material>("POST", "/api/materials", m);
  },
  async updateMaterial(id: string, patch: Partial<Material>) {
    return http<Material>("PATCH", `/api/materials/${id}`, patch);
  },
  async uploadSketch(id: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/materials/${id}/sketch`, { method: "POST", body: fd });
    if (!r.ok) throw new Error("POST /api/materials/" + id + "/sketch → " + r.status + " " + (await r.text()));
    return (await r.json()) as Material;
  },
  async pickSketch(id: string, sketch: string) {
    return http<Material>("PATCH", `/api/materials/${id}/sketch`, { sketch });
  },
  async clearSketch(id: string) {
    return http<Material>("DELETE", `/api/materials/${id}/sketch`);
  },
  async listSketches() {
    return http<{ canva: string[] }>("GET", "/api/sketches");
  },
  async deleteMaterial(id: string) {
    return http<{ ok: true; removedLinks: number }>("DELETE", `/api/materials/${id}`);
  },
  async search(q: string, k = 8) {
    const qs = new URLSearchParams({ q, k: String(k) });
    return http<SearchResult>("GET", "/api/search?" + qs.toString());
  },
  async listLinks() {
    return http<Link[]>("GET", "/api/links");
  },
  async createLink(L: Link) {
    try {
      return await http<Link>("POST", "/api/links", L);
    } catch (err) {
      if (String((err as Error).message).includes(" → 409 ")) return null;
      throw err;
    }
  },
  async updateLink(from: string, kind: LinkKind, to: string, patch: { note?: string; tag?: string; leap?: number; nudgeCount?: number }) {
    return http<Link>("PATCH", `/api/links/${from}/${kind}/${to}`, patch);
  },
  async deleteLink(from: string, kind: LinkKind, to: string) {
    return http<{ ok: true }>("DELETE", `/api/links/${from}/${kind}/${to}`);
  },
  async getFoci() {
    return http<Foci>("GET", "/api/foci");
  },
  async saveFoci(f: Foci) {
    return http<Foci>("PUT", "/api/foci", f);
  },
  async getCalendar() {
    return http<CalendarData>("GET", "/api/calendar");
  },
  async saveCalendar(data: CalendarData) {
    return http<CalendarData>("PUT", "/api/calendar", data);
  },
  async listSets() {
    return http<MaterialSet[]>("GET", "/api/sets");
  },
  async createSet(input: { name?: string; note?: string; members?: string[]; parent?: string | null }) {
    return http<MaterialSet>("POST", "/api/sets", input);
  },
  async updateSet(id: string, patch: { name?: string; note?: string; members?: string[]; parent?: string | null }) {
    return http<MaterialSet>("PATCH", `/api/sets/${id}`, patch);
  },
  async deleteSet(id: string) {
    return http<{ ok: true }>("DELETE", `/api/sets/${id}`);
  },
  async getPeriod(id: string) {
    return http<Period | null>("GET", `/api/periods/${id}`);
  },
  async savePeriod(p: Period) {
    return http<Period>("PUT", `/api/periods/${p.id}`, p);
  },
  async listPeriods(grade: string) {
    return http<Period[]>("GET", `/api/periods?grade=${grade}`);
  },
  async applyKgOps(ops: PatchOp[]) {
    return http<{ applied: number; errors: string[]; ids: Record<string, string>; created: { nodes: number; links: number } }>("POST", "/api/kg-ops", { ops });
  },
  async uploadChatSession(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/chat-session", { method: "POST", body: fd });
    if (!r.ok) throw new Error("POST /api/chat-session → " + r.status + " " + (await r.text()));
    return (await r.json()) as { path: string };
  },
  async getChatLog() {
    return http<{
      writtenAt: number;
      currentId: string;
      sessions: {
        id: string;
        title: string;
        writtenAt: number;
        steps: { at: number; history: { role: string; content: string }[]; ops: unknown[]; chatSketch?: string }[];
      }[];
      steps: { at: number; history: { role: string; content: string }[]; ops: unknown[]; chatSketch?: string }[];
    }>("GET", "/api/chat-session/log");
  },
  async saveChatLog(body: {
    history?: { role: string; content: string }[];
    ops?: unknown[];
    chatSketch?: string;
    sessionId?: string;
    title?: string;
    currentId?: string;
    sessions?: {
      id: string;
      title: string;
      writtenAt: number;
      steps: { at: number; history: { role: string; content: string }[]; ops: unknown[]; chatSketch?: string }[];
    }[];
  }) {
    return http<{
      writtenAt: number;
      currentId: string;
      sessions: unknown[];
      steps: unknown[];
    }>("PUT", "/api/chat-session/log", body);
  },
  async polish(kind: "look" | "name" | "note" | "explanation" | "objective", text: string, context?: string) {
    return http<{ text: string }>("POST", "/api/polish", { kind, text, context });
  },
  async listHistory() {
    return http<{ id: string; at: string; label: string }[]>("GET", "/api/history");
  },
  async restoreHistory(id: string) {
    return http<{ id: string; at: string; label: string }>("POST", "/api/history/restore", { id });
  },
  async hitlGet(id: string) {
    return http<{ session_id: string; phase: string; draft: Record<string, string> | null; submission: Record<string, string> | null }>("GET", "/api/hitl/" + id);
  },
  async hitlPost(id: string, body: Record<string, unknown>) {
    return http<{ session_id: string; phase: string; draft: Record<string, string> | null }>("POST", "/api/hitl/" + id, body);
  },
};
