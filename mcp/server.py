"""Lesson library tools for Cursor. This process does not call a model."""

from __future__ import annotations

import json
import os
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from mcp.types import ElicitRequest, ElicitRequestURLParams, InputRequiredResult
from fastmcp import FastMCP
from fastmcp.server.providers.skills import SkillsDirectoryProvider
from fastmcp.server.sessions import SessionProvider

ROOT = Path(__file__).resolve().parents[1]
LIBRARY = os.environ.get("LESSON_LIBRARY_URL", "http://127.0.0.1:8787").rstrip("/")
PAGE = LIBRARY

HITL: dict[str, dict[str, Any]] = {}

mcp = FastMCP(
    "Lesson library",
    instructions=(
        "Read the matching skill:// resource before a loop: "
        "explore-the-progression, then create-materials, before a new card; "
        "play-loop-lesson-recommend to search existing cards from a reflection; "
        "write-lesson-in-schedule only after create-materials, then date_slots, then search. "
        "Call search_materials before create_material. "
        "create_material, create_link, and attach_sketch only stage a draft on the open session. "
        "They never write the library. Call read_hitl first and give the teacher the page URL. "
        "Do not say a material or connection was saved until read_hitl shows last_approve for those ids. "
        "Wait for the teacher to approve on that page, or for their next message, then call read_hitl again. "
        "Do not commit a scattered series of writes outside a batch. "
        "After the page phase is agreed, call begin_batch, the write tools, then end_batch. "
        "A write tool called with no open batch is its own round. "
        "A write before the page has agreed does not change the library. "
        "Open the page URL this server returns and leave that page open. "
        "When the answer names a material, drill, or skill, include a link "
        "http://127.0.0.1:8787/?peek=M91 for each material id that get_material or "
        "search_materials returned. Add &session= when a HITL session is open. "
        "A skill answer lists member ids from list_sets and links those materials. "
        "Do not invent an M id."
    ),
)

mcp.add_provider(SkillsDirectoryProvider(roots=ROOT / "prompts", reload=True))
mcp.add_provider(SessionProvider())


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _call(method: str, path: str, payload: Any = None, raw: bytes | None = None, content_type: str | None = None) -> Any:
    data = raw if raw is not None else (None if payload is None else json.dumps(payload).encode())
    headers = {}
    if data is not None and content_type:
        headers["content-type"] = content_type
    elif data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(LIBRARY + path, data=data, headers=headers, method=method)
    try:
        with _OPENER.open(req, timeout=60) as res:
            body = res.read().decode()
            if not body:
                return None
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return body
    except urllib.error.HTTPError as err:
        detail = err.read().decode()
        raise RuntimeError(method + " " + path + " → " + str(err.code) + " " + detail) from err


def _blocked(session_id: str = "") -> str | None:
    if session_id:
        row = HITL.get(session_id)
        if row and row.get("phase") != "agreed":
            return "page has not agreed; no library write"
        return None
    for row in HITL.values():
        if row.get("phase") != "agreed":
            return "page has not agreed; no library write"
    return None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


_SKETCH_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".m4v", ".webm", ".mov"}


def _ops(row: dict[str, Any]) -> list[dict[str, Any]]:
    draft = row.get("draft")
    if not isinstance(draft, dict):
        draft = {"ops": []}
        row["draft"] = draft
    ops = draft.get("ops")
    if not isinstance(ops, list):
        ops = []
        draft["ops"] = ops
    return ops


def _next_temp(ops: list[dict[str, Any]]) -> str:
    n = 0
    for op in ops:
        tid = str(op.get("tempId") or "")
        if len(tid) > 1 and tid[0] == "P" and tid[1:].isdigit():
            n = max(n, int(tid[1:]))
    return "P" + str(n + 1)


def _need_session(session_id: str) -> str | None:
    if not session_id or session_id not in HITL:
        return "call read_hitl first"
    return None


def _set_op_status(ops: list[dict[str, Any]], op_id: str, status: str) -> None:
    target = next((op for op in ops if op.get("tempId") == op_id), None)
    if not target:
        return
    target["status"] = status
    if status == "discarded" and target.get("entity") == "material" and target.get("action") == "create":
        for op in ops:
            uses = op.get("entity") == "link" and (op.get("from") == op_id or op.get("to") == op_id)
            sketch = op.get("entity") == "material" and op.get("action") == "update" and op.get("id") == op_id
            if uses or sketch:
                op["status"] = "discarded"
                op["cascade"] = op_id
    if status == "pending":
        target.pop("cascade", None)
        if target.get("entity") == "material" and target.get("action") == "create":
            for op in ops:
                if op.get("cascade") == op_id:
                    op["status"] = "pending"
                    op.pop("cascade", None)


def _stage_sketch(ops: list[dict[str, Any]], material_id: str, file_path: str) -> str:
    fp = Path(file_path)
    if not fp.is_file():
        raise ValueError("missing file " + file_path)
    if fp.suffix.lower() not in _SKETCH_EXTS:
        raise ValueError("file must be png, jpg, webp, gif, mp4, webm, or mov")
    tid = _next_temp(ops)
    ops.append({
        "entity": "material",
        "action": "update",
        "tempId": tid,
        "id": material_id,
        "sketch": str(fp.resolve()),
        "status": "pending",
    })
    return tid


def _material(material_id: str) -> dict[str, Any] | None:
    rows = _call("GET", "/api/materials") or []
    return next((row for row in rows if row.get("id") == material_id), None)


@mcp.tool(name="list_materials")
async def _list_materials() -> str:
    return _json(_call("GET", "/api/materials"))


@mcp.tool(name="get_material")
async def _get_material(material_id: str) -> str:
    found = _material(material_id)
    if not found:
        return "unknown material " + material_id
    return _json(found)


@mcp.resource("material://{material_id}")
async def _material_resource(material_id: str) -> str:
    found = _material(material_id)
    return _json(found) if found else "unknown material " + material_id


@mcp.resource("prompt://kg-chat-system.md")
def _kg_chat_system() -> str:
    return (ROOT / "prompts" / "kg-chat-system.md").read_text()


@mcp.prompt(name="structure_reflection")
def _structure_reflection() -> str:
    payload = _call("GET", "/api/reflect-prompt")
    return str(payload.get("text") if isinstance(payload, dict) else payload)


@mcp.tool
async def search_materials(q: str, k: int = 8) -> str:
    """It looks up similar cards before a create."""
    return _json(_call("GET", "/api/search?q=" + urllib.request.quote(q) + "&k=" + str(k)))


@mcp.tool
async def create_material(name: str, look: str = "", notes: str = "", duration: int = 20, session_id: str = "") -> str:
    """It stages one card. The library changes only after the teacher approves on the page."""
    missing = _need_session(session_id)
    if missing:
        return missing
    ops = _ops(HITL[session_id])
    tid = _next_temp(ops)
    ops.append({
        "entity": "material",
        "action": "create",
        "tempId": tid,
        "name": name,
        "look": look,
        "notes": notes,
        "duration": duration,
        "status": "pending",
    })
    return _json({"tempId": tid, "staged": True, "url": _page_url(session_id), "name": name})


@mcp.tool
async def update_material(material_id: str, name: str = "", look: str = "", notes: str = "", duration: int = 0, date: str = "", grade: str = "", class_note: str = "", session_id: str = "") -> str:
    """It patches one existing card. A class note is written only when that date and grade are still empty."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    found = _material(material_id)
    if not found:
        return "unknown material " + material_id
    patch: dict[str, Any] = {}
    if name:
        patch["name"] = name
    if look:
        patch["look"] = look
    if notes:
        patch["notes"] = notes
    if duration:
        patch["duration"] = duration
    note_status: dict[str, Any] | None = None
    if class_note.strip():
        if not date or not grade:
            return "class note needs a date and a grade"
        rows = list(found.get("classNotes") or [])
        existing = next((row for row in rows if row.get("date") == date and row.get("grade") == grade), None)
        current = str((existing or {}).get("text") or "").strip()
        if current:
            note_status = {"exists": True, "wrote": False, "date": date, "grade": grade, "text": current}
        else:
            note = {"date": date, "grade": grade, "text": class_note.strip()}
            if existing:
                existing["text"] = note["text"]
            else:
                rows.append(note)
            patch["classNotes"] = rows
            note_status = {"exists": False, "wrote": True, "date": date, "grade": grade}
    if not patch:
        return _json({"material_id": material_id, "classNote": note_status})
    saved = _call("PATCH", "/api/materials/" + material_id, patch)
    if note_status:
        return _json({"classNote": note_status, "material": saved})
    return _json(saved)


@mcp.tool
async def delete_material(material_id: str, session_id: str = "") -> str:
    """It removes one card and its links."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("DELETE", "/api/materials/" + material_id))


@mcp.tool
async def merge_material(keep: str, drop: str = "", name: str = "", look: str = "", notes: str = "", session_id: str = "") -> str:
    """The old id stays, the name becomes the new name, and links and other fields are the union."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    op: dict[str, Any] = {"entity": "material", "action": "merge", "keep": keep}
    if drop:
        op["drop"] = drop
    if name:
        op["name"] = name
    if look:
        op["look"] = look
    if notes:
        op["notes"] = notes
    return _json(_call("POST", "/api/kg-ops", {"ops": [op]}))


@mcp.tool(name="list_links")
async def _list_links() -> str:
    return _json(_call("GET", "/api/links"))


@mcp.tool
async def create_link(from_id: str, to_id: str, kind: str = "progression", note: str = "", tag: str = "", session_id: str = "") -> str:
    """It stages one hop. from_id and to_id may be temp ids. The library changes only after approval."""
    missing = _need_session(session_id)
    if missing:
        return missing
    ops = _ops(HITL[session_id])
    tid = _next_temp(ops)
    body: dict[str, Any] = {
        "entity": "link",
        "action": "create",
        "tempId": tid,
        "from": from_id,
        "to": to_id,
        "kind": kind,
        "note": note,
        "status": "pending",
    }
    if tag:
        body["tag"] = tag
    ops.append(body)
    return _json({"tempId": tid, "staged": True, "url": _page_url(session_id)})


@mcp.tool
async def update_link(from_id: str, to_id: str, kind: str = "progression", note: str = "", tag: str = "", session_id: str = "") -> str:
    """It patches one hop."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    patch: dict[str, Any] = {}
    if note:
        patch["note"] = note
    if tag:
        patch["tag"] = tag
    return _json(_call("PATCH", "/api/links/" + from_id + "/" + kind + "/" + to_id, patch))


@mcp.tool
async def delete_link(from_id: str, to_id: str, kind: str = "progression", session_id: str = "") -> str:
    """It removes one hop."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("DELETE", "/api/links/" + from_id + "/" + kind + "/" + to_id))


@mcp.tool(name="list_sets")
async def _list_sets() -> str:
    return _json(_call("GET", "/api/sets"))


@mcp.tool
async def create_set(name: str, members: str = "", parent: str = "", session_id: str = "") -> str:
    """It creates one skill or activity set."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    body: dict[str, Any] = {"name": name, "members": [m for m in members.split() if m]}
    if parent:
        body["parent"] = parent
    return _json(_call("POST", "/api/sets", body))


@mcp.tool
async def update_set(set_id: str, name: str = "", members: str = "", parent: str = "", session_id: str = "") -> str:
    """It changes members or parent."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    patch: dict[str, Any] = {}
    if name:
        patch["name"] = name
    if members:
        patch["members"] = [m for m in members.split() if m]
    if parent:
        patch["parent"] = parent
    return _json(_call("PATCH", "/api/sets/" + set_id, patch))


@mcp.tool
async def delete_set(set_id: str, session_id: str = "") -> str:
    """It removes one skill or activity set."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("DELETE", "/api/sets/" + set_id))


def _multipart(filename: str, data: bytes, mime: str) -> tuple[bytes, str]:
    boundary = "----lessonlibrary"
    head = (
        "--" + boundary + "\r\n"
        'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n'
        "Content-Type: " + mime + "\r\n\r\n"
    ).encode()
    return head + data + ("\r\n--" + boundary + "--\r\n").encode(), "multipart/form-data; boundary=" + boundary


@mcp.tool
async def attach_sketch(material_id: str = "", session_id: str = "", path: str = "", items_json: str = "") -> str:
    """It stages one picture or video, or a batch via items_json of {material_id, path}. The file is copied onto the card only after approval."""
    missing = _need_session(session_id)
    if missing:
        return missing
    items: list[dict[str, Any]] = []
    if items_json.strip():
        parsed = json.loads(items_json)
        if not isinstance(parsed, list):
            return "items_json must be a list"
        items = [row for row in parsed if isinstance(row, dict)]
    elif path.strip():
        items = [{"material_id": material_id, "path": path}]
    else:
        row = HITL.get(session_id) or {}
        upload = row.get("upload")
        if not upload or not material_id:
            return "no picture path"
        dest_dir = ROOT / "library" / ".staged-sketches"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / (session_id + "-" + str(upload.get("filename") or "sketch.png"))
        dest.write_bytes(upload["data"])
        items = [{"material_id": material_id, "path": str(dest)}]
    ops = _ops(HITL[session_id])
    staged: list[str] = []
    try:
        for item in items:
            mid = str(item.get("material_id") or material_id or "")
            file_path = str(item.get("path") or "")
            if not mid or not file_path:
                return "each sketch needs material_id and path"
            staged.append(_stage_sketch(ops, mid, file_path))
    except ValueError as err:
        return str(err)
    return _json({"staged": staged, "url": _page_url(session_id)})


@mcp.tool
async def clear_sketch(material_id: str, session_id: str = "") -> str:
    """It removes that picture."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("DELETE", "/api/materials/" + material_id + "/sketch"))


@mcp.tool(name="get_period")
async def _get_period(period_id: str) -> str:
    return _json(_call("GET", "/api/periods/" + period_id))


@mcp.tool(name="list_periods")
async def _list_periods(grade: str) -> str:
    return _json(_call("GET", "/api/periods?grade=" + urllib.request.quote(grade)))


@mcp.tool
async def save_period(period_id: str, period_json: str = "", goal: str = "", reflection: str = "", flags: str = "", session_id: str = "") -> str:
    """It writes pins, today's goal, and today's reflection. Goal and reflection are written only when that field is still empty."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    stored = _call("GET", "/api/periods/" + period_id)
    if not isinstance(stored, dict):
        return "unknown period " + period_id
    goal_text = goal.strip()
    reflection_text = reflection.strip()
    current_goal = str(stored.get("objective") or "").strip()
    stored_reflection = stored.get("reflection") if isinstance(stored.get("reflection"), dict) else {}
    current_reflection = str(stored_reflection.get("text") or "").strip()
    kept: dict[str, Any] = {}
    if goal_text and current_goal:
        kept["goal"] = current_goal
    if reflection_text and current_reflection:
        kept["reflection"] = {"text": current_reflection, "flags": stored_reflection.get("flags") or []}
    if period_json:
        body = json.loads(period_json)
    else:
        body = stored
    body["id"] = period_id
    if goal_text and "goal" not in kept:
        body["objective"] = goal_text
    if reflection_text and "reflection" not in kept:
        body["reflection"] = {
            "flags": [flag.strip() for flag in flags.split(",") if flag.strip()],
            "text": reflection_text,
        }
    writing = ("goal" not in kept and bool(goal_text)) or ("reflection" not in kept and bool(reflection_text))
    if not period_json and not writing:
        return _json({"exists": True, "wrote": False, "period_id": period_id, "kept": kept})
    saved = _call("PUT", "/api/periods/" + period_id, body)
    if goal_text or reflection_text:
        return _json({"exists": bool(kept), "wrote": writing, "kept": kept, "period": saved})
    return _json(saved)


@mcp.tool
async def apply_reflection(period_id: str, output_json: str, session_id: str = "") -> str:
    """It checks the shape and applies Elo with no model call."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("POST", "/api/reflect", {"periodId": period_id, "output": json.loads(output_json)}))


@mcp.tool(name="get_calendar")
async def _get_calendar() -> str:
    return _json(_call("GET", "/api/calendar"))


@mcp.tool
async def save_calendar(calendar_json: str, session_id: str = "") -> str:
    """It writes weekdays, grades, labels, and painted ranges."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("PUT", "/api/calendar", json.loads(calendar_json)))


@mcp.tool(name="date_slots")
async def _date_slots(grade: str, count: int = 1, after: str = "") -> str:
    return _json(_call("POST", "/api/date-slots", {"grade": grade, "count": count, "after": after}))


@mcp.tool
async def begin_batch(session_id: str = "") -> str:
    """One agreed commit is one history round."""
    blocked = _blocked(session_id)
    if blocked:
        return blocked
    return _json(_call("POST", "/api/history/batch", {"action": "open"}))


@mcp.tool
async def end_batch() -> str:
    """It closes that round."""
    return _json(_call("POST", "/api/history/batch", {"action": "close"}))


@mcp.tool(name="list_patches")
async def _list_patches() -> str:
    return _json(_call("GET", "/api/history"))


@mcp.tool(name="restore_patch")
async def _restore_patch(patch_id: str) -> str:
    return _json(_call("POST", "/api/history/restore", {"id": patch_id}))


def _page_url(session_id: str) -> str:
    return PAGE + "/?session=" + session_id


@mcp.tool
async def push_draft(session_id: str, draft_json: str) -> str:
    """It updates the open page and does not write the library."""
    row = HITL.get(session_id)
    if not row:
        return "unknown session"
    kept_ops: list[Any] = []
    if isinstance(row.get("draft"), dict) and isinstance(row["draft"].get("ops"), list):
        kept_ops = row["draft"]["ops"]
    incoming = json.loads(draft_json)
    if not isinstance(incoming, dict):
        incoming = {"text": incoming}
    incoming["ops"] = kept_ops
    row["draft"] = incoming
    if row.get("phase") != "agreed":
        row["phase"] = "draft"
    return "draft updated"


@mcp.tool
async def read_hitl(session_id: str = "") -> str | InputRequiredResult:
    """It reads the session and does not write the library."""
    if not session_id:
        session_id = str(uuid.uuid4())
        HITL[session_id] = {"phase": "collecting", "draft": {"ops": []}, "submission": None, "upload": None, "last_approve": None}
        url = _page_url(session_id)
        params = ElicitRequestURLParams(
            mode="url",
            message="Open this page and leave it open: " + url,
            url=url,
            elicitation_id=session_id,
        )
        elicitation = ElicitRequest(method="elicitation/create", params=params)
        return InputRequiredResult(
            result_type="input_required",
            input_requests={"open": elicitation},
            request_state=session_id,
        )
    row = HITL.get(session_id)
    if not row:
        return "unknown session"
    return _json({
        "session_id": session_id,
        "url": _page_url(session_id),
        "phase": row.get("phase"),
        "draft": row.get("draft"),
        "submission": row.get("submission"),
        "last_approve": row.get("last_approve"),
    })


def _public_hitl(session_id: str) -> dict[str, Any]:
    row = HITL.get(session_id)
    if not row:
        return {}
    return {
        "session_id": session_id,
        "url": _page_url(session_id),
        "phase": row.get("phase"),
        "draft": row.get("draft"),
        "submission": row.get("submission"),
        "last_approve": row.get("last_approve"),
    }


@mcp.custom_route("/hitl/{session_id}", methods=["GET", "POST"])
async def _hitl_route(request):
    from starlette.responses import JSONResponse

    session_id = request.path_params["session_id"]
    if request.method == "GET":
        if session_id not in HITL:
            return JSONResponse({"error": "unknown session"}, status_code=404)
        return JSONResponse(_public_hitl(session_id))
    payload = await request.json()
    row = HITL.setdefault(session_id, {"phase": "collecting", "draft": {"ops": []}, "submission": None, "upload": None, "last_approve": None})
    ops = _ops(row)
    status = payload.get("op_status")
    if isinstance(status, dict) and status.get("id") and status.get("status") in ("discarded", "pending"):
        _set_op_status(ops, str(status["id"]), str(status["status"]))
    approved = payload.get("approved")
    if isinstance(approved, dict):
        chosen = {str(item) for item in (approved.get("ids") or [])}
        draft = row.get("draft") if isinstance(row.get("draft"), dict) else {"ops": []}
        draft["ops"] = [op for op in ops if op.get("tempId") not in chosen and op.get("status") != "discarded"]
        row["draft"] = draft
        row["last_approve"] = {"ids": list(chosen), "idMap": approved.get("idMap") or {}}
    if "upload" in payload and isinstance(payload["upload"], dict):
        import base64

        row["upload"] = {
            "filename": payload["upload"].get("filename") or "sketch.png",
            "mime": payload["upload"].get("mime") or "image/png",
            "data": base64.b64decode(payload["upload"].get("data") or ""),
        }
    submission = {key: payload.get(key) for key in ("name", "look", "notes", "text", "flags") if key in payload}
    if submission:
        row["submission"] = submission
    if payload.get("agree"):
        row["phase"] = "agreed"
    elif submission:
        row["phase"] = "submitted"
    elif payload.get("phase") in ("collecting", "submitted", "draft", "agreed"):
        row["phase"] = payload["phase"]
    return JSONResponse(_public_hitl(session_id))


class _RequestLog:
    """Records each HTTP request so a stuck Cursor client can be compared with what this process received."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode(): v.decode()[:120] for k, v in scope.get("headers", [])}
        status = {"code": None}

        async def send_wrap(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        # #region agent log
        def _dbg(message, data):
            import time

            line = json.dumps({
                "sessionId": "26cba1",
                "hypothesisId": "A-E",
                "location": "mcp/server.py:RequestLog",
                "message": message,
                "data": data,
                "timestamp": int(time.time() * 1000),
            })
            with open(
                "/Users/willieliao/工作/JCID/Units/(Flag) Football/.cursor/debug-26cba1.log",
                "a",
                encoding="utf-8",
            ) as fh:
                fh.write(line + "\n")

        _dbg("request", {
            "method": scope.get("method"),
            "path": scope.get("path"),
            "host": headers.get("host"),
            "origin": headers.get("origin"),
            "accept": headers.get("accept"),
            "session": headers.get("mcp-session-id"),
        })
        # #endregion
        try:
            await self.app(scope, receive, send_wrap)
        except Exception as err:
            # #region agent log
            _dbg("exception", {"method": scope.get("method"), "path": scope.get("path"), "error": type(err).__name__})
            # #endregion
            raise
        # #region agent log
        _dbg("response", {"method": scope.get("method"), "path": scope.get("path"), "status": status["code"]})
        # #endregion


if __name__ == "__main__":
    from starlette.middleware import Middleware

    # #region agent log
    with open(
        "/Users/willieliao/工作/JCID/Units/(Flag) Football/.cursor/debug-26cba1.log",
        "a",
        encoding="utf-8",
    ) as fh:
        fh.write(json.dumps({
            "sessionId": "26cba1",
            "hypothesisId": "E",
            "location": "mcp/server.py:main",
            "message": "mcp process start",
            "data": {"port": 8789},
            "timestamp": __import__("time").time_ns() // 1_000_000,
        }) + "\n")
    # #endregion
    mcp.run(transport="http", host="127.0.0.1", port=8789, middleware=[Middleware(_RequestLog)])
