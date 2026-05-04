#!/usr/bin/env python3
"""Small HTTP proxy so P Ranker (Find Venues) can use Scopus without exposing your API key.

Run on any host you control (Fly.io, Railway, VPS, etc.). The static site calls this URL;
``SCOPUS_API_KEY`` stays only in this process environment.

Environment
-----------
  SCOPUS_API_KEY            Required.
  SCOPUS_INSTTOKEN          Optional (institutional).
  SCOPUS_PROXY_SECRET       Optional. If set, browser must send header ``X-Pranker-Scopus-Secret`` with the same value.
  SCOPUS_PROXY_ALLOW_ORIGIN Optional. Default ``*``. Set to your GitHub Pages origin, e.g. ``https://you.github.io``
  PORT                      Optional. Default 8787.

Start
-----
  export SCOPUS_API_KEY=...
  python server/scopus_proxy.py

Endpoint
--------
  POST /literature-venues
  Content-Type: application/json

  {
    "query": "keywords from the topic box",
    "queryExpr": null,
    "topWorks": 30,
    "topVenues": 30,
    "journalsOnly": false,
    "sort": "-citedby-count",
    "view": "STANDARD"
  }

Response: same JSON shape as OpenAlex branch in ``venues.js`` (``works``, ``venues``, ``query_used``, ``source``).
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import scopus_literature as sl  # noqa: E402


def _cors_headers(request_origin: str | None) -> dict[str, str]:
    allow = (os.environ.get("SCOPUS_PROXY_ALLOW_ORIGIN") or "*").strip()
    if allow == "*":
        origin = "*"
    else:
        origin = allow
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Pranker-Scopus-Secret",
        "Access-Control-Max-Age": "86400",
    }


def _check_secret(handler: BaseHTTPRequestHandler) -> bool:
    want = (os.environ.get("SCOPUS_PROXY_SECRET") or "").strip()
    if not want:
        return True
    got = handler.headers.get("X-Pranker-Scopus-Secret") or ""
    return got.strip() == want


def _api_key() -> str:
    k = (os.environ.get("SCOPUS_API_KEY") or "").strip()
    if not k:
        raise RuntimeError("Server misconfiguration: SCOPUS_API_KEY is not set.")
    return k


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def do_OPTIONS(self) -> None:
        o = self.headers.get("Origin")
        for k, v in _cors_headers(o).items():
            self.send_header(k, v)
        self.send_response(204)
        self.end_headers()

    def do_POST(self) -> None:
        o = self.headers.get("Origin")
        cors = _cors_headers(o)
        parsed = urlparse(self.path)
        if parsed.path not in ("/literature-venues", "/literature-venues/"):
            self._json(404, {"error": "not found"}, cors)
            return
        if not _check_secret(self):
            self._json(403, {"error": "invalid or missing X-Pranker-Scopus-Secret"}, cors)
            return
        length = int(self.headers.get("Content-Length") or "0")
        if length > 262144:
            self._json(413, {"error": "body too large"}, cors)
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"}, cors)
            return
        if not isinstance(body, dict):
            self._json(400, {"error": "JSON object expected"}, cors)
            return

        query = (body.get("query") or "").strip()
        query_expr = body.get("queryExpr")
        if isinstance(query_expr, str):
            query_expr = query_expr.strip() or None
        else:
            query_expr = None

        if not query and not query_expr:
            self._json(400, {"error": "query or queryExpr required"}, cors)
            return

        top_works = min(int(body.get("topWorks") or 30), 200)
        top_venues = min(int(body.get("topVenues") or 30), 100)
        journals_only = bool(body.get("journalsOnly"))
        sort = str(body.get("sort") or "-citedby-count")[:80]
        view = str(body.get("view") or "STANDARD")
        if view not in ("STANDARD", "COMPLETE"):
            view = "STANDARD"
        page_size = min(int(body.get("pageSize") or 200), sl.MAX_PAGE)
        max_start = min(int(body.get("maxStart") or 4999), 20000)
        max_pages = min(int(body.get("maxPages") or 30), 100)
        sleep_s = float(body.get("sleep") or sl.DEFAULT_SLEEP_S)
        sleep_s = max(0.0, min(sleep_s, 2.0))

        try:
            bundle = sl.run_literature_search(
                _api_key(),
                user_keywords=query or None,
                query_expr=query_expr,
                top_works=top_works,
                top_venues=top_venues,
                page_size=page_size,
                sort=sort,
                view=view,
                journals_only=journals_only,
                max_start=max_start,
                max_pages=max_pages,
                sleep_s=sleep_s,
            )
        except ValueError as e:
            self._json(400, {"error": str(e)}, cors)
            return
        except RuntimeError as e:
            self._json(502, {"error": str(e)}, cors)
            return

        self._json(200, bundle, cors)

    def _json(self, status: int, obj: dict, cors: dict[str, str]) -> None:
        b = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        for k, v in cors.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)


def main() -> None:
    port = int(os.environ.get("PORT") or os.environ.get("SCOPUS_PROXY_PORT") or "8787")
    host = os.environ.get("SCOPUS_PROXY_HOST") or "0.0.0.0"
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Scopus proxy listening on http://{host}:{port}", file=sys.stderr)
    print("POST /literature-venues with JSON body (see module docstring).", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)


if __name__ == "__main__":
    main()
