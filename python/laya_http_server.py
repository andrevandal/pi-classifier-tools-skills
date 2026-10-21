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

Request telemetry (schema: docs/telemetry.md, `loadout.http`). Every POST writes one
content-free JSON line to stderr, the service log (the journal under systemd): the
client's request id, the outcome, the HTTP status, and the queue wait, inference and
total times in milliseconds. A phase that was not measured is null. The queue and
inference times also come back in a `Server-Timing` header. The client's `X-Request-Id`
(a lowercase UUIDv4) is the correlation id; anything else is logged as invalid, never
copied. `X-Loadout-Telemetry: off` opts one request out of all of this and
`--no-telemetry` opts out every request; any value other than `on` counts as off. A
client that disconnects is only noticed when the answer is written, after inference has run.
"""

from __future__ import annotations

import argparse
import contextlib
import hmac
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import ModuleType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LOCK = threading.Lock()  # one prediction at a time; the model is not thread-safe
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_BODY_BYTES = 1_048_576
REQUEST_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ERROR_CLASS = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
ARGS: argparse.Namespace
TOKEN = ""
# Set by main() once the flags are accepted: importing laya_worker imports laya, which is slow.
worker: ModuleType


def class_name(exc: BaseException) -> str:
    """The exception's class name, never its text, and only if it fits the record's allowlist."""
    name = type(exc).__name__
    return name if ERROR_CLASS.fullmatch(name) else "Error"


class Trace:
    """What one POST may report about itself: id, phases and outcome, never content."""

    def __init__(self, headers) -> None:
        self.start = time.monotonic()
        # Fail closed: "on" is the only value that keeps telemetry, so a garbled opt-out still opts out.
        optouts = headers.get_all("X-Loadout-Telemetry", [])
        self.enabled = not ARGS.no_telemetry and all(value.strip().lower() == "on" for value in optouts)
        ids = [value.strip() for value in headers.get_all("X-Request-Id", [])]
        self.request_id = ids[0] if len(ids) == 1 and REQUEST_ID.fullmatch(ids[0]) else None
        self.id_status = "valid" if self.request_id else "invalid" if ids else "absent"
        self.queue_ms: float | None = None  # waiting for LOCK
        self.infer_ms: float | None = None  # holding LOCK, up to the answer or the exception
        self.status: int | None = None  # the status the server chose to send; a disconnect may mean it never arrived
        self.error: str | None = None  # class of the exception that made the answer a 500
        self.gone: str | None = None  # class of the disconnect raised while writing the answer

    def timing_header(self) -> str:
        if not self.enabled:
            return ""
        phases = (("queue", self.queue_ms), ("infer", self.infer_ms))
        return ", ".join(f"{name};dur={value:.3f}" for name, value in phases if value is not None)

    def emit(self) -> None:
        """Write the `loadout.http` v1 line. Never raises: telemetry must not fail a request."""
        if not self.enabled:
            return
        with contextlib.suppress(Exception):
            if self.gone:
                outcome, error_class = "client-gone", self.gone
            elif self.status is None or self.status >= 500:
                outcome, error_class = "error", self.error
            elif self.status >= 400:
                outcome, error_class = "rejected", None
            else:
                outcome, error_class = "ok", None
            record = {
                "type": "loadout.http",
                "v": 1,
                "requestId": self.request_id,
                "idStatus": self.id_status,
                "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "outcome": outcome,
                "status": self.status,
                "queueMs": self.queue_ms,
                "inferenceMs": self.infer_ms,
                "totalMs": round((time.monotonic() - self.start) * 1000, 3),
                "errorClass": error_class,
            }
            sys.stderr.write(json.dumps(record, separators=(",", ":")) + "\n")
            sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _reply(self, trace: Trace, status: int, payload: dict) -> None:
        """Answer a POST, noting the status and whether the client was already gone when it was written."""
        if not trace.gone:  # the 500 retried after a failed write must not replace the status that failed
            trace.status = status
        timing = trace.timing_header()
        try:
            self._send(status, payload, {"Server-Timing": timing} if timing else None)
        except ConnectionError as exc:
            trace.gone = trace.gone or class_name(exc)
            raise

    def do_GET(self) -> None:  # noqa: N802 - health check
        self._send(200, {"ok": True, "loaded": list(worker.STATE["loaded"])})

    def do_POST(self) -> None:  # noqa: N802
        trace = Trace(self.headers)
        try:
            self._post(trace)
        finally:
            trace.emit()

    def _post(self, trace: Trace) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= MAX_BODY_BYTES:
                # The body is left unread, so the connection cannot be reused.
                self.close_connection = True
                self._reply(trace, 413, {"error": "request too large"})
                return
            body = self.rfile.read(length)
            presented = self.headers.get("Authorization", "")
            if TOKEN and not hmac.compare_digest(presented.encode(), f"Bearer {TOKEN}".encode()):
                self._reply(trace, 401, {"error": "unauthorized"})
                return
            request = json.loads(body)
            reply = {"op": "predict", "state": request.get("state"), "questions": request.get("questions")}
            if isinstance(request.get("model"), str):
                reply["model"] = request["model"]
            queued = time.monotonic()
            with LOCK:
                acquired = time.monotonic()
                trace.queue_ms = round((acquired - queued) * 1000, 3)
                try:
                    result = worker.handle(reply, ARGS)
                finally:
                    trace.infer_ms = round((time.monotonic() - acquired) * 1000, 3)
            self._reply(trace, 200, result["result"])
        except Exception as exc:  # noqa: BLE001
            if not trace.gone:
                trace.error = class_name(exc)
            self._reply(trace, 500, {"error": f"{type(exc).__name__}: {exc}"})

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
    parser.add_argument(
        "--no-telemetry",
        action="store_true",
        help="write no per-request loadout.http log line and send no Server-Timing header",
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
