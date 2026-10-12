#!/usr/bin/env python3
"""Cursor command entry. Starts missing lesson-library services, then bridges stdio to HTTP MCP."""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import anyio
import httpx2
from mcp.client.streamable_http import streamable_http_client
from mcp.server.stdio import stdio_server
from mcp.shared.message import SessionMessage

ROOT = Path(__file__).resolve().parents[1]
MCP_URL = os.environ.get("LESSON_LIBRARY_MCP_URL", "http://127.0.0.1:8789/mcp")
PORTS = (8787, 8788, 8789)
owned: subprocess.Popen | None = None


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def stop_owned() -> None:
    proc = owned
    if proc is None or proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def ensure_services() -> None:
    global owned
    if all(port_open(port) for port in PORTS):
        return
    log_path = ROOT / "library" / ".services.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "ab")
    owned = subprocess.Popen(
        ["npx", "tsx", "scripts/dev.ts", "--services"],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if all(port_open(port) for port in PORTS):
            return
        if owned.poll() is not None:
            raise RuntimeError("lesson-library services exited before the ports opened")
        time.sleep(0.2)
    raise RuntimeError("lesson-library services did not open 8787, 8788, and 8789")


async def _pump(source, destination, skip_errors: bool) -> None:
    async for message in source:
        if skip_errors and isinstance(message, Exception):
            continue
        if not isinstance(message, SessionMessage):
            continue
        await destination.send(message)


async def bridge() -> None:
    timeout = httpx2.Timeout(30.0, read=300.0)
    client = httpx2.AsyncClient(trust_env=False, timeout=timeout)
    async with client:
        async with stdio_server() as (client_read, client_write):
            async with streamable_http_client(MCP_URL, http_client=client, terminate_on_close=False) as (
                http_read,
                http_write,
            ):
                async with anyio.create_task_group() as tg:
                    tg.start_soon(_pump, client_read, http_write, False)
                    tg.start_soon(_pump, http_read, client_write, True)


def _on_term(_signum, _frame) -> None:
    stop_owned()
    raise SystemExit(0)


def main() -> None:
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    try:
        ensure_services()
        anyio.run(bridge)
    finally:
        if os.environ.get("LESSON_LIBRARY_SUPERVISOR_KEEP") != "1":
            stop_owned()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        stop_owned()
        raise
    except Exception as err:
        print(str(err), file=sys.stderr)
        stop_owned()
        raise
