import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateEmbeddings, searchMaterials } from "./embed.ts";
import { applyKgOps, polish, REFLECT_PROMPT, reflect, runDateSlots, suggest } from "./llm.ts";
import * as store from "./store.ts";
import type { HttpError } from "./store.ts";
import type { Link, LinkKind, Period, Suggestion } from "../web/types.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const WEB = path.join(ROOT, "web");
const SKETCHES = path.join(ROOT, "library", "media_library", "flag football");
const PORT = Number(process.env.PORT || 8787);

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function text(res: ServerResponse, status: number, msg: string) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(msg);
}

function parseMultipartFile(buf: Buffer, contentType: string): { filename: string; data: Buffer; type: string } {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!bm) throw store.httpError(400, "multipart boundary missing");
  const bound = Buffer.from("--" + (bm[1] || bm[2]).trim());
  let start = buf.indexOf(bound);
  if (start < 0) throw store.httpError(400, "file is required");
  start += bound.length;
  if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
  const sep = Buffer.from("\r\n\r\n");
  const hs = buf.indexOf(sep, start);
  if (hs < 0) throw store.httpError(400, "multipart headers");
  const headers = buf.subarray(start, hs).toString("utf8");
  const fn = /filename\*?=(?:UTF-8''|"?)([^\";\r\n]+)/i.exec(headers);
  if (!fn) throw store.httpError(400, "file is required");
  const filename = decodeURIComponent(fn[1].replace(/"/g, "").trim());
  const typeM = /content-type:\s*([^\r\n]+)/i.exec(headers);
  const type = (typeM ? typeM[1] : "").trim();
  const dataStart = hs + 4;
  const closer = Buffer.concat([Buffer.from("\r\n"), bound]);
  let dataEnd = buf.indexOf(closer, dataStart);
  if (dataEnd < 0) dataEnd = buf.indexOf(bound, dataStart);
  if (dataEnd < 0) throw store.httpError(400, "multipart body");
  return { filename, data: buf.subarray(dataStart, dataEnd), type };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(req)).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function mime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".map": "application/json",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream"
  );
}

function serveFile(res: ServerResponse, file: string, req?: IncomingMessage) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    text(res, 404, "not found");
    return;
  }
  const st = statSync(file);
  const type = mime(file);
  const range = req && req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.writeHead(416, { "content-range": "bytes */" + st.size, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2] || 0));
    let end = m[1] !== undefined && m[2] ? Number(m[2]) : st.size - 1;
    if (!m[1] && m[2]) {
      start = Math.max(0, st.size - Number(m[2]));
      end = st.size - 1;
    }
    if (start > end || start >= st.size || Number.isNaN(start) || Number.isNaN(end)) {
      res.writeHead(416, { "content-range": "bytes */" + st.size, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      "content-type": type,
      "content-length": String(end - start + 1),
      "content-range": "bytes " + start + "-" + end + "/" + st.size,
      "accept-ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(st.size),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}

function handleStatic(url: URL, req: IncomingMessage, res: ServerResponse): boolean {
  let decoded = url.pathname;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    /* keep pathname */
  }
  const mediaPrefixes = [
    "/assets/library/media_library/flag football/",
    "/assets/library/media_library/",
    "/assets/media_library/flag football/",
    "/assets/media_library/",
    "/assets/canva-sketches/",
    "/assets/library/sketches/",
  ];
  if (mediaPrefixes.some((pfx) => decoded.startsWith(pfx))) {
    const name = path.basename(decoded);
    serveFile(res, path.join(SKETCHES, name), req);
    return true;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(res, path.join(WEB, "index.html"), req);
    return true;
  }
  if (url.pathname === "/app.js" || url.pathname === "/app.js.map") {
    serveFile(res, path.join(WEB, path.basename(url.pathname)), req);
    return true;
  }
  return false;
}

async function handleApi(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";
  const p = url.pathname;

  if (method === "GET" && p === "/api/health") {
    send(res, 200, { ok: true, store: "library/" });
    return true;
  }
  if (method === "GET" && p === "/api/materials") {
    send(res, 200, store.listMaterials(ROOT));
    return true;
  }
  if (method === "POST" && p === "/api/materials") {
    const body = (await readJson(req)) as Parameters<typeof store.createMaterial>[1];
    const created = store.createMaterial(ROOT, body);
    invalidateEmbeddings(ROOT, created.id);
    send(res, 201, created);
    return true;
  }
  let m = /^\/api\/materials\/(M\d+)$/.exec(p);
  if (m && method === "PATCH") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const updated = store.updateMaterial(ROOT, m[1], body);
    invalidateEmbeddings(ROOT, m[1]);
    send(res, 200, updated);
    return true;
  }
  if (m && method === "DELETE") {
    const deleted = store.deleteMaterial(ROOT, m[1]);
    invalidateEmbeddings(ROOT, m[1]);
    send(res, 200, deleted);
    return true;
  }
  m = /^\/api\/materials\/(M\d+)\/sketch$/.exec(p);
  if (m && method === "POST") {
    const buf = await readBody(req);
    const file = parseMultipartFile(buf, req.headers["content-type"] || "");
    send(res, 200, store.attachSketch(ROOT, m[1], file.data, file.filename, file.type));
    return true;
  }
  if (m && method === "PATCH") {
    const body = (await readJson(req)) as { sketch?: string };
    if (!body.sketch) send(res, 200, store.clearSketch(ROOT, m[1]));
    else send(res, 200, store.setSketchRel(ROOT, m[1], body.sketch));
    return true;
  }
  if (m && method === "DELETE") {
    send(res, 200, store.clearSketch(ROOT, m[1]));
    return true;
  }
  if (method === "GET" && p === "/api/sketches") {
    const canva = existsSync(SKETCHES)
      ? readdirSync(SKETCHES)
          .filter((n) => /\.(png|jpe?g|webp|gif|mp4|m4v|webm|mov)$/i.test(n))
          .sort()
          .map((n) => path.join(SKETCHES, n))
      : [];
    send(res, 200, { canva });
    return true;
  }
  if (method === "GET" && p === "/api/search") {
    const q = url.searchParams.get("q") || "";
    const k = Number(url.searchParams.get("k") || "8");
    send(res, 200, await searchMaterials(ROOT, q, k));
    return true;
  }
  if (method === "GET" && p === "/api/links") {
    send(res, 200, store.listLinks(ROOT));
    return true;
  }
  if (method === "POST" && p === "/api/links") {
    const body = (await readJson(req)) as Link;
    send(res, 201, store.createLink(ROOT, body));
    return true;
  }
  m = /^\/api\/links\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
  if (m && method === "PATCH") {
    const body = (await readJson(req)) as { note?: string; tag?: string; leap?: number; nudgeCount?: number };
    send(res, 200, store.updateLink(ROOT, decodeURIComponent(m[1]), m[2] as LinkKind, decodeURIComponent(m[3]), body));
    return true;
  }
  if (m && method === "DELETE") {
    send(res, 200, store.deleteLink(ROOT, decodeURIComponent(m[1]), m[2] as LinkKind, decodeURIComponent(m[3])));
    return true;
  }
  if (p === "/api/foci" && method === "GET") {
    send(res, 200, store.getFoci(ROOT));
    return true;
  }
  if (p === "/api/foci" && method === "PUT") {
    send(res, 200, store.saveFoci(ROOT, (await readJson(req)) as Parameters<typeof store.saveFoci>[1]));
    return true;
  }
  if (p === "/api/calendar" && method === "GET") {
    send(res, 200, store.getCalendar(ROOT));
    return true;
  }
  if (p === "/api/calendar" && method === "PUT") {
    send(res, 200, store.saveCalendar(ROOT, (await readJson(req)) as Parameters<typeof store.saveCalendar>[1]));
    return true;
  }
  if (p === "/api/sets" && method === "GET") {
    send(res, 200, store.listSets(ROOT));
    return true;
  }
  if (p === "/api/sets" && method === "POST") {
    const body = (await readJson(req)) as Parameters<typeof store.createSet>[1];
    send(res, 201, store.createSet(ROOT, body));
    return true;
  }
  m = /^\/api\/sets\/(S\d+)$/.exec(p);
  if (m && method === "PATCH") {
    const body = (await readJson(req)) as { name?: string; note?: string; members?: string[]; parent?: string | null };
    send(res, 200, store.updateSet(ROOT, m[1], body));
    return true;
  }
  if (m && method === "DELETE") {
    send(res, 200, store.deleteSet(ROOT, m[1]));
    return true;
  }
  if (p === "/api/periods" && method === "GET") {
    const grade = url.searchParams.get("grade") || "";
    send(res, 200, store.listPeriods(ROOT, grade));
    return true;
  }
  m = /^\/api\/periods\/([^/]+)$/.exec(p);
  if (m && method === "GET") {
    send(res, 200, store.getPeriod(ROOT, decodeURIComponent(m[1])));
    return true;
  }
  if (m && method === "PUT") {
    const body = (await readJson(req)) as Period;
    send(res, 200, store.savePeriod(ROOT, decodeURIComponent(m[1]), body));
    return true;
  }
  if (p === "/api/suggest" && method === "POST") {
    const body = (await readJson(req)) as {
      periodId?: string;
      mode?: string;
      goal?: string;
      demand?: string;
      paste?: string;
      history?: { role: "user" | "assistant"; content: string }[];
      lookupCache?: Suggestion["lookupCache"];
      taskState?: Suggestion["taskState"];
    };
    if (body.mode !== "chat" && !body.periodId) {
      text(res, 400, "periodId is required");
      return true;
    }
    const stream = body.mode === "chat" && /ndjson/i.test(String(req.headers.accept || ""));
    if (stream) {
      const ac = new AbortController();
      const drop = () => ac.abort();
      req.on("aborted", drop);
      req.on("close", drop);
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      try {
        const suggestion = await suggest(ROOT, body.periodId || "", {
          mode: body.mode,
          goal: body.goal,
          demand: body.demand,
          paste: body.paste,
          history: body.history,
          lookupCache: body.lookupCache,
          taskState: body.taskState,
          signal: ac.signal,
          onStatus(ev) {
            if (ac.signal.aborted || res.writableEnded) return;
            const row: { status: string; skill?: string; tool?: string } = { status: ev.status };
            if (ev.skill) row.skill = ev.skill;
            if (ev.tool) row.tool = ev.tool;
            res.write(JSON.stringify(row) + "\n");
          },
        });
        if (!ac.signal.aborted && !res.writableEnded) {
          res.write(JSON.stringify({ suggestion }) + "\n");
        }
      } catch (err) {
        if (ac.signal.aborted) {
          if (!res.writableEnded) res.end();
          return true;
        }
        const e = err as HttpError;
        if (!res.writableEnded) {
          res.write(JSON.stringify({ error: e.message || String(err), status: e.status || 500 }) + "\n");
        }
      } finally {
        req.off("aborted", drop);
        req.off("close", drop);
      }
      if (!res.writableEnded) res.end();
      return true;
    }
    const suggestion = await suggest(ROOT, body.periodId || "", {
      mode: body.mode,
      goal: body.goal,
      demand: body.demand,
      paste: body.paste,
      history: body.history,
      lookupCache: body.lookupCache,
      taskState: body.taskState,
    });
    send(res, 200, suggestion);
    return true;
  }
  if (p === "/api/kg-ops" && method === "POST") {
    const body = (await readJson(req)) as { ops?: Parameters<typeof applyKgOps>[1] };
    send(res, 200, applyKgOps(ROOT, body.ops || []));
    return true;
  }
  if (p === "/api/chat-session" && method === "POST") {
    const buf = await readBody(req);
    const file = parseMultipartFile(buf, req.headers["content-type"] || "");
    const saved = store.writeChatSessionFile(ROOT, file.data, file.filename, file.type);
    send(res, 200, { path: saved.name, name: saved.name });
    return true;
  }
  if (p === "/api/chat-session/log" && method === "GET") {
    send(res, 200, store.readChatLog(ROOT));
    return true;
  }
  if (p === "/api/chat-session/log" && method === "PUT") {
    const body = (await readJson(req)) as store.ChatLogPut;
    send(res, 200, store.writeChatLog(ROOT, body || {}));
    return true;
  }
  if (p === "/api/polish" && method === "POST") {
    const body = (await readJson(req)) as { kind?: string; text?: string; context?: string };
    send(res, 200, await polish(body));
    return true;
  }
  if (p === "/api/reflect" && method === "POST") {
    const body = (await readJson(req)) as { periodId?: string; output?: unknown };
    if (!body.periodId) {
      text(res, 400, "periodId is required");
      return true;
    }
    send(res, 200, await reflect(ROOT, body.periodId, body.output));
    return true;
  }
  if (p === "/api/reflect-prompt" && method === "GET") {
    send(res, 200, { text: REFLECT_PROMPT });
    return true;
  }
  if (p === "/api/history" && method === "GET") {
    send(res, 200, store.listHistory(ROOT));
    return true;
  }
  if (p === "/api/history/restore" && method === "POST") {
    const body = (await readJson(req)) as { id?: string };
    if (!body.id) {
      text(res, 400, "id is required");
      return true;
    }
    const restored = store.restoreHistory(ROOT, body.id);
    for (const id of restored.ids) invalidateEmbeddings(ROOT, id);
    send(res, 200, restored.entry);
    return true;
  }
  if (p === "/api/history/batch" && method === "POST") {
    const body = (await readJson(req)) as { action?: string };
    if (body.action === "close") {
      send(res, 200, store.endBatch(ROOT) || { ok: true });
      return true;
    }
    send(res, 200, store.beginBatch(ROOT));
    return true;
  }
  if (p === "/api/date-slots" && method === "POST") {
    const body = (await readJson(req)) as { grade?: string; count?: number; after?: string };
    const grade = String(body.grade || "").trim();
    const cal = store.getCalendar(ROOT);
    const periods = grade ? store.listPeriods(ROOT, grade) : [];
    send(res, 200, runDateSlots(
      { grade, count: body.count, after: body.after },
      {
        classDays: cal.classDays || {},
        entries: cal.entries || [],
        periods,
        grade,
        after: String(body.after || ""),
        count: Number(body.count) || 1,
      },
    ));
    return true;
  }
  const hitl = /^\/api\/hitl\/([^/]+)$/.exec(p);
  if (hitl && (method === "GET" || method === "POST")) {
    const upstream = await fetch("http://127.0.0.1:8789/hitl/" + hitl[1], {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? (await readBody(req)).toString("utf8") : undefined,
    });
    const raw = await upstream.text();
    send(res, upstream.status, raw || "{}", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    return true;
  }
  return false;
}

store.ensureLibrary(ROOT);
store.persistCompleteSketchPaths(ROOT);
store.persistMissingDurations(ROOT);
store.migrateSimilarBodyToRelated(ROOT);
store.stampLibraryAgentNotes(ROOT);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (!url.pathname.startsWith("/api/")) {
      if (handleStatic(url, req, res)) return;
      text(res, 404, "not found");
      return;
    }
    if (await handleApi(req, url, res)) return;
    text(res, 404, "not found");
  } catch (err) {
    const e = err as HttpError;
    const status = e.status || 500;
    text(res, status, e.message || String(err));
  }
});

server.listen(PORT, () => {
  console.log("lesson library http://localhost:" + PORT);
});
