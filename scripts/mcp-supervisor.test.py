#!/usr/bin/env python3
"""Supervisor decision, cleanup, and live MCP handshake."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import anyio
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


def load_supervisor():
    path = ROOT / "scripts" / "mcp_supervisor.py"
    spec = importlib.util.spec_from_file_location("mcp_supervisor", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cleanup() -> None:
    module = load_supervisor()
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    module.owned = proc
    module.stop_owned()
    assert proc.poll() is not None, "owned service group was not stopped"
    assert not module.port_open(1)


def test_config_retired_url() -> None:
    raw = (ROOT / ".cursor" / "mcp.json").read_text()
    config = json.loads(raw)
    server = config["mcpServers"]["lesson-library"]
    assert "command" in server, "workspace MCP config must launch the supervisor"
    assert "url" not in server, "URL-only MCP config was not retired"


async def test_handshake() -> None:
    params = StdioServerParameters(
        command="python3",
        args=["scripts/mcp_supervisor.py"],
        cwd=ROOT,
        env={**os.environ, "LESSON_LIBRARY_SUPERVISOR_KEEP": "1"},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            listeners = subprocess.check_output(["lsof", "-nP", "-iTCP:8789", "-sTCP:LISTEN"], text=True)
    names = {tool.name for tool in tools.tools}
    assert "search_materials" in names, names
    assert "save_period" in names, names
    assert listeners.count("LISTEN") == 1, listeners


if __name__ == "__main__":
    test_cleanup()
    test_config_retired_url()
    anyio.run(test_handshake)
    print("mcp supervisor tests passed")
