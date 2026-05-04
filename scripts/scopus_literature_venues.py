#!/usr/bin/env python3
"""Search Scopus from your machine (API key in environment), sort by citations, list distinct sources.

For use from the P Ranker website without running this CLI, deploy ``server/scopus_proxy.py``
and paste the proxy URL into Find Venues → Scopus proxy settings.

Environment variables
-----------------------
  SCOPUS_API_KEY    Required. Sent as ``X-ELS-APIKey``.
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
import sys

import scopus_literature as sl


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
    p.add_argument("--count", type=int, default=200, help="Page size per request (max %d)." % sl.MAX_PAGE)
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
    p.add_argument("--sleep", type=float, default=sl.DEFAULT_SLEEP_S, help="Pause between pages (seconds).")
    args = p.parse_args()

    if args.query_expr:
        qexpr = args.query_expr.strip()
        user_kw = None
    else:
        user_kw = " ".join(args.words).strip()
        if not user_kw and not sys.stdin.isatty():
            user_kw = sys.stdin.read().strip()
        if not user_kw:
            p.error("Provide keywords, or --query-expr, or pipe query text on stdin.")
        qexpr = None

    api_key = _env_api_key()
    try:
        bundle = sl.run_literature_search(
            api_key,
            user_keywords=user_kw,
            query_expr=qexpr,
            top_works=args.top_works,
            top_venues=args.top_venues,
            page_size=min(args.count, sl.MAX_PAGE),
            sort=args.sort,
            view=args.view,
            journals_only=args.journals_only,
            max_start=args.max_start,
            max_pages=args.max_pages,
            sleep_s=args.sleep,
        )
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    venues = bundle["venues"]
    lines = ["rank\tpublication_name\tcitedby\taggregation_type\tscopus_id"]
    for i, row in enumerate(venues, start=1):
        lines.append(
            "\t".join(
                [
                    str(i),
                    row["name"],
                    str(row["citedBy"]),
                    str(row.get("aggregation_type") or "—"),
                    str(row.get("scopus_id") or ""),
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
            json.dump({"query": bundle["query_used"], "venues": venues}, f, indent=2)
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
