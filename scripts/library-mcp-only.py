#!/usr/bin/env python3
from __future__ import annotations
import json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
MARK = "library" + "/"
LIBRARY = ROOT / "library"
IMAGE = re.compile(r"\.(?:png|jpe?g|webp|gif|mp4|m4v|webm|mov)\b", re.IGNORECASE)
PATH_KEYS = {"path", "file_path", "target_file", "target_notebook", "file", "filename"}
COMMAND_KEYS = {"command", "cmd"}
CONTENT_KEYS = {"contents", "content", "new_string", "old_string", "text", "patch", "input"}
SENTENCE = "wrong tool, use {tool}, read the description of each and use the right one"

def _walk(value, keys, found):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in keys and isinstance(item, str):
                found.append(item)
            elif key not in CONTENT_KEYS:
                _walk(item, keys, found)
    elif isinstance(value, list):
        for item in value:
            _walk(item, keys, found)

def _under(text):
    token = text.strip().strip("'\"")
    norm = token.replace("\\", "/")
    if MARK not in norm:
        return False
    path = Path(token)
    options = [path]
    if not path.is_absolute():
        options.append(Path.cwd() / path)
        options.append(ROOT / path)
    for option in options:
        try:
            resolved = option.resolve()
        except OSError:
            continue
        if resolved == LIBRARY or LIBRARY in resolved.parents:
            return True
    if norm.startswith(MARK) or norm.startswith("./" + MARK):
        return True
    lesson = "/" + "lesson-" + "library" + "/" + MARK
    return lesson in norm

def _targets(payload):
    found = []
    _walk(payload, PATH_KEYS | COMMAND_KEYS, found)
    kept = []
    for text in found:
        if _under(text):
            kept.append(text.replace("\\", "/"))
            continue
        for part in text.replace("\\", "/").split():
            part = part.strip("'\"")
            if _under(part):
                kept.append(part)
    return kept

def _contents(payload):
    found = []
    _walk(payload, CONTENT_KEYS, found)
    return "\n".join(found)

def _tool(paths, contents):
    media = "media_" + "library"
    history = "." + "history"
    if any(media in path for path in paths) or any(IMAGE.search(path) for path in paths):
        return "attach_sketch"
    materials = MARK + "materials"
    if any(materials in path for path in paths) and IMAGE.search(contents):
        return "attach_sketch"
    if any(history in path for path in paths):
        return "restore_patch"
    if any(path.endswith("_calendar.yaml") for path in paths):
        return "save_calendar"
    if any(path.endswith("_sets.yaml") for path in paths):
        return "update_set"
    if any((MARK + "periods") in path for path in paths):
        return "save_period"
    if any(materials in path for path in paths):
        return "update_material"
    return "update_material"

def _reply(fmt, message):
    if fmt == "cursor":
        print(json.dumps({"permission": "deny", "agent_message": message}))
        return 0
    if fmt == "claude":
        print(message, file=sys.stderr)
        return 2
    if fmt == "codex":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": message}}))
        return 2
    if fmt == "hermes":
        print(json.dumps({"action": "block", "message": message}))
        return 0
    print("unknown format " + fmt, file=sys.stderr)
    return 2

def main():
    fmt = "cursor"
    args = sys.argv[1:]
    if "--format" in args:
        fmt = args[args.index("--format") + 1]
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"command": raw}
    paths = _targets(payload)
    if not paths:
        if fmt == "cursor":
            print(json.dumps({"permission": "allow"}))
        return 0
    return _reply(fmt, SENTENCE.format(tool=_tool(paths, _contents(payload))))

if __name__ == "__main__":
    sys.exit(main())
