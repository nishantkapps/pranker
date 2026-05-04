#!/usr/bin/env python3
"""Search Scopus from your machine (API key in environment), sort by citations, list distinct sources.

This mirrors the Find Venues “top-cited papers → host venues” flow using Elsevier’s Scopus Search API.
It does not ship credentials in the web app; run locally with ``SCOPUS_API_KEY`` set.

Environment variables
-----------------------
  SCOPUS_API_KEY    Required. Sent as ``X-ELS-APIKey`` (or query ``apiKey``).
  SCOPUS_INSTTOKEN  Optional. ``X-ELS-Insttoken`` for institutional entitlements.

Examples
--------
  export SCOPUS_API_KEY=...
  python scripts/scopus_literature_venues.py "stroke rehabilitation robot"
  python scripts/scopus_literature_venues.py --query-expr "TITLE-ABS-KEY(robot) AND PUBYEAR > 2020" \\
      --top-works 50 --top-venues 30 --journals-only

Output: TSV on stdout (rank, publication_name, citedby, aggregation_type, scopus_id).
Use ``-o file.tsv`` to write instead of stdout.

API reference: https://dev.elsevier.com/documentation/ScopusSearchAPI.wadl
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any

import requests

SCOPUS_SEARCH_URL = "https://api.elsevier.com/content/search/scopus"
MAX_PAGE = 200
DEFAULT_SLEEP_S = 0.12


def _env_api_key() -> str:
    key = (os.environ.get("SCOPUS_API_KEY") or "").strip()
    if not key:
        print(
            "Missing SCOPUS_API_KEY. Export your Elsevier developer API key, e.g.\n"
            "  export SCOPUS_API_KEY='...'\n"
            "Optional: export SCOPUS_INSTTOKEN='...' for institutional access.",
            file=sys.stderr,
        )
        sys.exit(1)
    return key


def normalize_venue_key(name: str) -> str:
    """Match venues.js normalizeForMatch: lowercase, strip non-alphanumerics."""
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def build_default_query(user_words: str) -> str:
    """Wrap free text as a Scopus TITLE-ABS-KEY search (words ANDed)."""
    text = " ".join(user_words.split())
    if not text:
        raise SystemExit("Empty search query.")
    # Split into tokens; keep alphanumerics per token
    parts = re.findall(r"[^\s,;]+", text)
    if not parts:
        raise SystemExit("Empty search query.")
    inner = " AND ".join(parts)
    return f"TITLE-ABS-KEY({inner})"


def search_results_entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    sr = data.get("search-results") or {}
    raw = sr.get("entry")
    if raw is None:
        return []
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    return []


def citedby(entry: dict[str, Any]) -> int:
    v = entry.get("citedby-count")
    if v is None:
        return 0
    try:
        return int(str(v).strip())
    except ValueError:
        return 0


def publication_name(entry: dict[str, Any]) -> str:
    return str(entry.get("prism:publicationName") or "").strip()


def aggregation_type(entry: dict[str, Any]) -> str:
    return str(entry.get("prism:aggregationType") or "").strip()


def scopus_id(entry: dict[str, Any]) -> str:
    ident = str(entry.get("dc:identifier") or "")
    if ident.upper().startswith("SCOPUS_ID:"):
        return ident.split(":", 1)[1].strip()
    return ident


def fetch_page(
    session: requests.Session,
    api_key: str,
    *,
    query: str,
    start: int,
    count: int,
    sort: str,
    view: str,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "X-ELS-APIKey": api_key,
    }
    inst = (os.environ.get("SCOPUS_INSTTOKEN") or "").strip()
    if inst:
        headers["X-ELS-Insttoken"] = inst

    params: dict[str, str | int] = {
        "query": query,
        "start": start,
        "count": min(count, MAX_PAGE),
        "sort": sort,
        "httpAccept": "application/json",
        "view": view,
    }
    r = session.get(SCOPUS_SEARCH_URL, headers=headers, params=params, timeout=60)
    if r.status_code != 200:
        msg = f"Scopus HTTP {r.status_code}"
        try:
            body = r.json()
            if isinstance(body, dict):
                err = body.get("service-error") or body.get("error-response") or body
                msg += f": {err}"
            else:
                msg += f": {body!r}"
        except Exception:
            msg += f": {r.text[:500]!r}"
        raise RuntimeError(msg)
    return r.json()


def total_results(data: dict[str, Any]) -> int:
    sr = data.get("search-results") or {}
    raw = sr.get("opensearch:totalResults", "0")
    try:
        return int(str(raw))
    except ValueError:
        return 0


def collect_works(
    session: requests.Session,
    api_key: str,
    *,
    query: str,
    target_works: int,
    page_size: int,
    sort: str,
    view: str,
    journals_only: bool,
    max_start: int,
    max_pages: int,
    sleep_s: float,
) -> list[dict[str, Any]]:
    """Fetch enough pages to gather ``target_works`` entries (optionally only journals)."""
    collected: list[dict[str, Any]] = []
    start = 0
    pages = 0
    while len(collected) < target_works and start <= max_start:
        pages += 1
        if pages > max_pages:
            break
        data = fetch_page(
            session,
            api_key,
            query=query,
            start=start,
            count=page_size,
            sort=sort,
            view=view,
        )
        batch = search_results_entries(data)
        if not batch:
            break
        for entry in batch:
            if journals_only:
                ag = aggregation_type(entry).lower()
                if ag != "journal":
                    continue
            collected.append(entry)
            if len(collected) >= target_works:
                break
        start += len(batch)
        if start >= total_results(data):
            break
        time.sleep(sleep_s)
    return collected


def distinct_venues_in_order(
    works: list[dict[str, Any]], *, max_venues: int
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for w in works:
        name = publication_name(w)
        if len(name) < 2:
            continue
        key = normalize_venue_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "publication_name": name,
                "citedby": citedby(w),
                "aggregation_type": aggregation_type(w) or "—",
                "scopus_id": scopus_id(w),
            }
        )
        if len(out) >= max_venues:
            break
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Scopus search → top-cited works → distinct source names.")
    p.add_argument(
        "words",
        nargs="*",
        help="Free-text keywords (combined with TITLE-ABS-KEY AND). Ignored if --query-expr is set.",
    )
    p.add_argument(
        "--query-expr",
        dest="query_expr",
        metavar="Q",
        help="Raw Scopus boolean query (overrides positional words).",
    )
    p.add_argument(
        "--sort",
        default="-citedby-count",
        help='Sort expression (default: %(default)s). Example: "+pubyear,-citedby-count"',
    )
    p.add_argument("--count", type=int, default=200, help="Page size per request (max %d)." % MAX_PAGE)
    p.add_argument("--top-works", type=int, default=30, help="How many papers to walk (after filters).")
    p.add_argument("--top-venues", type=int, default=30, help="Max distinct publication names to emit.")
    p.add_argument(
        "--journals-only",
        action="store_true",
        help='Keep only works with prism:aggregationType "Journal" when filling --top-works.',
    )
    p.add_argument(
        "--view",
        default="STANDARD",
        choices=("STANDARD", "COMPLETE"),
        help="Scopus search view (default STANDARD; use COMPLETE if fields are missing).",
    )
    p.add_argument(
        "--max-start",
        type=int,
        default=4999,
        help="Do not paginate beyond this start offset (Scopus cluster limits apply).",
    )
    p.add_argument(
        "--max-pages",
        type=int,
        default=30,
        help="Safety cap on HTTP requests when filling --top-works (e.g. with --journals-only).",
    )
    p.add_argument("-o", "--output", metavar="FILE", help="Write TSV here instead of stdout.")
    p.add_argument("--json-out", metavar="FILE", help="Also write venues as JSON array to this file.")
    p.add_argument("--sleep", type=float, default=DEFAULT_SLEEP_S, help="Pause between pages (seconds).")
    args = p.parse_args()

    if args.query_expr:
        query = args.query_expr.strip()
    else:
        user = " ".join(args.words).strip()
        if not user and not sys.stdin.isatty():
            user = sys.stdin.read().strip()
        if not user:
            p.error("Provide keywords, or --query-expr, or pipe query text on stdin.")
        query = build_default_query(user)

    session = requests.Session()
    session.headers.setdefault("User-Agent", "pranker-scopus-literature-venues/1.0 (research tool)")

    api_key = _env_api_key()
    works = collect_works(
        session,
        api_key,
        query=query,
        target_works=args.top_works,
        page_size=min(args.count, MAX_PAGE),
        sort=args.sort,
        view=args.view,
        journals_only=args.journals_only,
        max_start=args.max_start,
        max_pages=args.max_pages,
        sleep_s=args.sleep,
    )
    venues = distinct_venues_in_order(works, max_venues=args.top_venues)

    lines = ["rank\tpublication_name\tcitedby\taggregation_type\tscopus_id"]
    for i, row in enumerate(venues, start=1):
        lines.append(
            "\t".join(
                [
                    str(i),
                    row["publication_name"],
                    str(row["citedby"]),
                    row["aggregation_type"],
                    row["scopus_id"],
                ]
            )
        )
    text = "\n".join(lines) + "\n"

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Wrote {len(venues)} venues to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(text)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"query": query, "venues": venues}, f, indent=2)
            f.write("\n")
        print(f"Wrote JSON to {args.json_out}", file=sys.stderr)

    if not venues:
        print(
            "No venues extracted. Try lowering --journals-only, increasing --top-works / --max-start, "
            "or using --view COMPLETE.",
            file=sys.stderr,
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
