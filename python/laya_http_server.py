#!/usr/bin/env python3
"""Persistent Laya HTTP server for the `laya.transport: "http"` backend.

Loads the checkpoint once and serves `POST /` (any path) with
`{"state", "questions", "model"?}` -> `{"answers", "model"?, "usage"?}`, the
same contract the TypeScript HTTP client sends. Reuses the sidecar's loading
and reply normalisation, so both transports behave the same.

  python python/laya_http_server.py --repo convaiinnovations/laya --router --port 8765

Binds to 127.0.0.1 by default. Another host needs --allow-remote and
LAYA_SERVER_TOKEN. A token set in LAYA_SERVER_TOKEN is enforced on any host:
every POST must then carry `Authorization: Bearer <token>`. Bodies over 1 MiB
are refused with 413 before they are read.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import ModuleType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LOCK = threading.Lock()  # one prediction at a time; the model is not thread-safe
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_BODY_BYTES = 1_048_576
ARGS: argparse.Namespace
TOKEN = ""
# Set by main() once the flags are accepted: importing laya_worker imports laya, which is slow.
worker: ModuleType


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - health check
        self._send(200, {"ok": True, "loaded": list(worker.STATE["loaded"])})

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= MAX_BODY_BYTES:
                # The body is left unread, so the connection cannot be reused.
                self.close_connection = True
                self._send(413, {"error": "request too large"})
                return
            body = self.rfile.read(length)
            presented = self.headers.get("Authorization", "")
            if TOKEN and not hmac.compare_digest(presented.encode(), f"Bearer {TOKEN}".encode()):
                self._send(401, {"error": "unauthorized"})
                return
            request = json.loads(body)
            reply = {"op": "predict", "state": request.get("state"), "questions": request.get("questions")}
            if isinstance(request.get("model"), str):
                reply["model"] = request["model"]
            with LOCK:
                result = worker.handle(reply, ARGS)
            self._send(200, result["result"])
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt: str, *args: object) -> None:
        pass


def main() -> int:
    global ARGS, TOKEN, worker
    parser = argparse.ArgumentParser(prog="laya_http_server")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--subfolder", default="")
    parser.add_argument("--device", default="")
    parser.set_defaults(preload=True)
    parser.add_argument("--router", action="store_true")
    parser.add_argument("--max-loaded", type=int, default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="allow a non-loopback --host; requires LAYA_SERVER_TOKEN",
    )
    ARGS = parser.parse_args()
    if ARGS.host not in LOOPBACK_HOSTS and not ARGS.allow_remote:
        print("laya_http_server: refusing non-loopback --host without --allow-remote", file=sys.stderr)
        return 2
    TOKEN = os.environ.get("LAYA_SERVER_TOKEN", "")
    if ARGS.allow_remote and not TOKEN:
        print("laya_http_server: --allow-remote requires LAYA_SERVER_TOKEN", file=sys.stderr)
        return 2

    import laya_worker

    worker = laya_worker
    worker.ensure_agent(ARGS)
    worker.STATE["loaded"] = worker.describe_loaded(worker.STATE["agent"], ARGS.subfolder or "english")
    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"laya_http_server: ready on http://{ARGS.host}:{ARGS.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
