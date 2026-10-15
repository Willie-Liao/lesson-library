#!/usr/bin/env python3
"""MiniLM embedding sidecar for lesson-library search. Layout never uses these vectors."""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("EMBED_MODEL", "all-MiniLM-L6-v2")
PORT = int(os.environ.get("EMBED_PORT", "8788"))

print("embed sidecar loading", MODEL_NAME, file=sys.stderr, flush=True)
from sentence_transformers import SentenceTransformer

model = SentenceTransformer(MODEL_NAME)
print("embed sidecar ready on", PORT, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/embed":
            self._send(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length") or "0")
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return
        texts = payload.get("texts") or []
        if not isinstance(texts, list):
            self._send(400, {"error": "texts must be a list"})
            return
        strs = [str(t) for t in texts]
        if not strs:
            self._send(200, {"vectors": []})
            return
        vecs = model.encode(strs, normalize_embeddings=True)
        self._send(200, {"vectors": vecs.tolist()})


if __name__ == "__main__":
    HTTPServer = ThreadingHTTPServer
    httpd = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
