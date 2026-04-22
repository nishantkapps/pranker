#!/usr/bin/env python3
"""Download ai-deadlines conference YAML and emit a static JSON for the web app.

Source: https://github.com/paperswithcode/ai-deadlines (Papers With Code)
YAML:  gh-pages/_data/conferences.yml

Output: data/conference_deadlines.json
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.request import Request, urlopen

import yaml

SOURCE_URL = (
    "https://raw.githubusercontent.com/paperswithcode/ai-deadlines/"
    "gh-pages/_data/conferences.yml"
)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_PATH = DATA_DIR / "conference_deadlines.json"
CUTOFF = date(2022, 1, 1)


def _as_iso_start(val) -> str:
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.date().isoformat()
    if isinstance(val, date):
        return val.isoformat()
    s = str(val).strip()
    if not s:
        return ""
    # YAML may use "YYYY-MM-DD" or datetime string
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return s


def _dedupe_key(item: dict) -> str:
    t = (item.get("title") or item.get("name") or "")
    return str(t).strip().upper()


def main() -> int:
    req = Request(SOURCE_URL, headers={"User-Agent": "pranker-build/1.0"})
    with urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")

    parsed = yaml.safe_load(raw)
    if parsed is None:
        rows: list[dict] = []
    elif isinstance(parsed, list):
        rows = [x for x in parsed if isinstance(x, dict)]
    elif isinstance(parsed, dict):
        rows = [v for v in parsed.values() if isinstance(v, dict)]
    else:
        print("Unexpected YAML root type", type(parsed), file=sys.stderr)
        return 1

    best: dict[str, dict] = {}
    for item in rows:
        start_iso = _as_iso_start(item.get("start"))
        if not start_iso or start_iso < CUTOFF.isoformat():
            continue
        key = _dedupe_key(item)
        if not key:
            continue
        prev = best.get(key)
        prev_start = _as_iso_start(prev.get("start")) if prev else ""
        if not prev or start_iso > prev_start:
            best[key] = item

    entries = []
    for item in best.values():
        entries.append(
            {
                "title": item.get("title") or "",
                "name": item.get("name") or "",
                "full_name": item.get("full_name") or "",
                "start": _as_iso_start(item.get("start")),
                "date": item.get("date") if item.get("date") is not None else "",
                "place": item.get("place") if item.get("place") is not None else "",
                "link": item.get("link") if item.get("link") is not None else "",
            }
        )

    entries.sort(key=lambda e: e.get("start") or "", reverse=True)

    today = date.today().isoformat()
    out = {
        "updated": today,
        "source": SOURCE_URL,
        "count": len(entries),
        "entries": entries,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {OUTPUT_PATH} ({len(entries)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
