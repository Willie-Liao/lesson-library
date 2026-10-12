"""Validator for the library guard and the home-directory installer."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts" / "library-mcp-only.py"
INSTALL = ROOT / "scripts" / "install-library-guard.py"
MARK = "library" + "/"
SENTENCE = "wrong tool, use {tool}, read the description of each and use the right one"


def run(fmt: str, payload: dict) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GUARD), "--format", fmt],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
    )


def expect(fmt: str, payload: dict, tool: str) -> None:
    result = run(fmt, payload)
    message = SENTENCE.format(tool=tool)
    blob = result.stdout + result.stderr
    if message not in blob:
        raise SystemExit(f"{fmt} {tool} missing message:\n{blob}")
    if fmt == "cursor":
        body = json.loads(result.stdout)
        if body.get("permission") != "deny" or result.returncode != 0:
            raise SystemExit(f"cursor deny shape {result.returncode} {result.stdout}")
    elif fmt == "claude":
        if result.returncode != 2 or message not in result.stderr:
            raise SystemExit(f"claude deny shape {result.returncode} {result.stderr}")
    elif fmt == "codex":
        body = json.loads(result.stdout)
        decision = body["hookSpecificOutput"]["permissionDecision"]
        if decision != "deny" or result.returncode != 2:
            raise SystemExit(f"codex deny shape {result.returncode} {result.stdout}")
    elif fmt == "hermes":
        body = json.loads(result.stdout)
        if body.get("action") != "block" or result.returncode != 0:
            raise SystemExit(f"hermes deny shape {result.returncode} {result.stdout}")


def main() -> None:
    picture = {
        "tool_name": "Write",
        "tool_input": {"path": MARK + "materials/M117.md", "contents": "sketch.png"},
    }
    cases = [
        (picture, "attach_sketch"),
        ({"tool_input": {"path": MARK + "periods/2026-10-13-G6.md"}}, "save_period"),
        ({"tool_input": {"file_path": MARK + "_sets.yaml"}}, "update_set"),
        ({"tool_input": {"path": MARK + "_calendar.yaml"}}, "save_calendar"),
        ({"tool_input": {"path": MARK + ".history/index.json"}}, "restore_patch"),
    ]
    for payload, tool in cases:
        for fmt in ("cursor", "claude", "codex", "hermes"):
            expect(fmt, payload, tool)
    allowed = run("cursor", {"tool_input": {"path": "scripts/foo.ts"}})
    if allowed.returncode != 0 or json.loads(allowed.stdout).get("permission") != "allow":
        raise SystemExit("outside path was not allowed: " + allowed.stdout)
    for fmt in ("claude", "codex", "hermes"):
        outside = run(fmt, {"tool_input": {"path": "scripts/foo.ts"}})
        if outside.returncode != 0:
            raise SystemExit(fmt + " outside path blocked")

    home = Path(tempfile.mkdtemp())
    hermes = home / ".hermes"
    hermes.mkdir()
    (hermes / "config.yaml").write_text(
        "hooks:\n  pre_tool_call:\n    - matcher: terminal\n      command: /tmp/keep.sh\n      timeout: 30\n"
    )
    (home / ".minimax").mkdir()
    (home / ".mavis").mkdir()
    subprocess.check_call([sys.executable, str(INSTALL), "--home", str(home)])
    text = (hermes / "config.yaml").read_text()
    if "/tmp/keep.sh" not in text or "library-mcp-only.py" not in text:
        raise SystemExit("hermes config dropped a hook:\n" + text)
    for name in (".minimax", ".mavis"):
        note = (home / name / "hooks" / "library-mcp-only.md").read_text()
        if "hookEvent: PreToolUse" not in note or "--format claude" not in note:
            raise SystemExit(name + " markdown missing")
        if "__REPO__" in note:
            raise SystemExit(name + " placeholder left in place")
    print("guard ok")


if __name__ == "__main__":
    main()
