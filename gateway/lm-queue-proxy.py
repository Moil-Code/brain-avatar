#!/usr/bin/env python3
"""lm-queue-proxy — a transparent single-flight gateway in front of LM Studio.

Runs ON the 24GB Mac (the box that hosts LM Studio). LM Studio runs every
concurrent request in PARALLEL — it never queues — so two heavy generations
(e.g. the avatar + the MacBook, or the 26B + 12B at once) overwhelm the box and
stall the whole machine. This proxy sits in front of LM Studio and serializes
*generation* requests to one-at-a-time: the second caller WAITS instead of
piling on.

It is transparent: it adds NO auth of its own and simply forwards the incoming
Authorization header to LM Studio, so every client keeps using the same LM Studio
token it already uses — no credential changes anywhere. Point clients at this
proxy's port instead of LM Studio's :1234.

  - Generation paths (….../completions, /responses) are gated by a global lock.
  - Everything else (/models, /embeddings, health) passes through ungated so the
    model picker and probes stay instant.

Config via env:
  LMQ_BIND        host:port to listen on        (default 0.0.0.0:1235)
  LMQ_UPSTREAM    LM Studio base URL            (default http://127.0.0.1:1234)
  LMQ_TIMEOUT     upstream timeout seconds      (default 600)

Stdlib only (no pip). ThreadingHTTPServer gives a thread per request; the global
lock is what serializes them. Holding the lock across a streamed response is
intentional — that is the serialization.
"""
import os
import sys
import threading
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BIND = os.environ.get("LMQ_BIND", "0.0.0.0:1235")
UPSTREAM = os.environ.get("LMQ_UPSTREAM", "http://127.0.0.1:1234").rstrip("/")
TIMEOUT = float(os.environ.get("LMQ_TIMEOUT", "600"))

_up = urlparse(UPSTREAM)
UP_HOST = _up.hostname or "127.0.0.1"
UP_PORT = _up.port or 1234

# The single-flight gate. Only one generation runs at a time across ALL clients.
GEN_LOCK = threading.Lock()

# Paths that actually generate tokens (heavy) → must be serialized. Substring match.
GATED = ("/completions", "/responses")


def _is_gated(path: str) -> bool:
    p = path.split("?", 1)[0]
    return any(seg in p for seg in GATED)


def _log(msg: str) -> None:
    sys.stderr.write(f"[lm-queue-proxy] {msg}\n")
    sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lm-queue-proxy/1.0"

    def log_message(self, *args):  # silence default access logging
        pass

    def _relay(self, method: str):
        path = self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        gated = _is_gated(path)
        if gated and not GEN_LOCK.acquire(blocking=False):
            _log(f"{method} {path} queued — another generation in flight")
            GEN_LOCK.acquire()  # now block until the in-flight one finishes
        try:
            conn = http.client.HTTPConnection(UP_HOST, UP_PORT, timeout=TIMEOUT)
            # Forward headers as-is (incl. Authorization) minus hop-by-hop ones.
            fwd = {
                k: v
                for k, v in self.headers.items()
                if k.lower() not in ("host", "connection", "proxy-connection")
            }
            try:
                conn.request(method, path, body=body, headers=fwd)
                resp = conn.getresponse()
            except Exception as e:
                self._fail(502, f"upstream unreachable: {e}")
                return

            # Stream the response back. Avoid relying on Content-Length for
            # streamed bodies — read until EOF and use chunked transfer downstream.
            self.send_response(resp.status)
            passthrough = [
                (k, v)
                for k, v in resp.getheaders()
                if k.lower() not in ("transfer-encoding", "content-length", "connection")
            ]
            for k, v in passthrough:
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(b"%X\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                # Client disconnected (e.g. Stop) — drop upstream and free the gate.
                _log(f"{method} {path} client disconnected — releasing gate")
            finally:
                conn.close()
        finally:
            if gated and GEN_LOCK.locked():
                GEN_LOCK.release()

    def _fail(self, code: int, msg: str):
        payload = msg.encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            pass

    def do_GET(self):
        self._relay("GET")

    def do_POST(self):
        self._relay("POST")


def main():
    host, _, port = BIND.partition(":")
    addr = (host or "0.0.0.0", int(port or "1235"))
    httpd = ThreadingHTTPServer(addr, Handler)
    _log(f"listening on http://{addr[0]}:{addr[1]} → upstream {UPSTREAM} "
         f"(serializing {', '.join(GATED)})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
