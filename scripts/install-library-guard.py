#!/usr/bin/env python3
"""Register the library guard with Hermes and MiniMax Code. Project hooks already live in git."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "library-mcp-only.py"
MINIMAX_SRC = ROOT / "hooks" / "minimax" / "library-mcp-only.md"


def _hermes_entry(command: str) -> str:
    return (
        '    - matcher: "write_file|patch|terminal"\n'
        f"      command: {json_quote(command)}\n"
        "      timeout: 30\n"
    )


def json_quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def add_hermes(text: str, command: str) -> str:
    if "library-mcp-only.py" in text:
        return text
    item = _hermes_entry(command)
    if re.search(r"(?m)^  pre_tool_call:\s*$", text):
        return re.sub(r"(?m)^(  pre_tool_call:\s*\n)", r"\1" + item, text, count=1)
    if re.search(r"(?m)^hooks:\s*$", text):
        return re.sub(r"(?m)^(hooks:\s*\n)", "\\1  pre_tool_call:\n" + item, text, count=1)
    return text.rstrip() + "\n\nhooks:\n  pre_tool_call:\n" + item


def install(home: Path) -> None:
    command = f"python3 {SCRIPT}"
    hermes = home / ".hermes" / "config.yaml"
    if hermes.is_file():
        hermes.write_text(add_hermes(hermes.read_text(), command + " --format hermes"))
    note = MINIMAX_SRC.read_text().replace("__REPO__", str(ROOT))
    for folder in (home / ".minimax", home / ".mavis"):
        if not folder.is_dir():
            continue
        dest = folder / "hooks"
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "library-mcp-only.md").write_text(note)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=str(Path.home()))
    args = parser.parse_args()
    install(Path(args.home))


if __name__ == "__main__":
    main()
