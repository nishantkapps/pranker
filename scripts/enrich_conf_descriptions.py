#!/usr/bin/env python3
"""Scrape conference homepage descriptions and store them in core.json.

Reads data/conf_urls.csv (produced by find_conf_urls.py, edited by you),
fetches each conference's homepage, extracts a short description of the
conference scope / topics, and writes it back to core.json as a
'description' field.

Usage:
  python scripts/enrich_conf_descriptions.py          # all rows with a URL
  python scripts/enrich_conf_descriptions.py --top    # A*/A only

Cache: data/conf_desc_cache.json  (skip already-fetched entries on rerun)
"""

import csv
import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

DATA_DIR   = Path(__file__).resolve().parent.parent / "data"
CORE_JSON  = DATA_DIR / "core.json"
URL_CSV    = DATA_DIR / "conf_urls.csv"
CACHE_JSON = DATA_DIR / "conf_desc_cache.json"

DELAY    = 1.0   # seconds between page fetches
TIMEOUT  = 15
MAX_DESC = 600   # max characters to store

TOP_RANKS = {"A*", "A"}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})

# Section heading keywords that likely introduce scope/about text
SCOPE_HEADS = re.compile(
    r"\b(about|welcome|scope|aim|overview|introduction|call for paper|topics?)\b",
    re.IGNORECASE,
)


# ── Description extraction ────────────────────────────────────────────────────

def clean(text: str) -> str:
    """Collapse whitespace and strip control chars."""
    return re.sub(r"\s+", " ", text).strip()


def extract_description(html: str, url: str) -> str:
    """Return a short description extracted from conference homepage HTML."""
    soup = BeautifulSoup(html, "lxml")

    # Remove navigation, footer, script, style
    for tag in soup(["nav", "footer", "script", "style", "noscript",
                     "header", "aside", "form"]):
        tag.decompose()

    # 1. <meta name="description"> or og:description
    for attr in [{"name": "description"}, {"property": "og:description"}]:
        meta = soup.find("meta", attrs=attr)
        if meta:
            content = clean(meta.get("content", ""))
            if len(content) > 60:
                return content[:MAX_DESC]

    # 2. Section heading followed by paragraphs
    for heading in soup.find_all(re.compile(r"^h[1-4]$")):
        if SCOPE_HEADS.search(heading.get_text()):
            parts = []
            for sib in heading.next_siblings:
                if not hasattr(sib, "name"):
                    continue
                if re.match(r"^h[1-4]$", sib.name):
                    break
                t = clean(sib.get_text(" "))
                if len(t) > 40:
                    parts.append(t)
                if sum(len(p) for p in parts) > MAX_DESC:
                    break
            if parts:
                return " ".join(parts)[:MAX_DESC]

    # 3. First substantial paragraph in the main content area
    main = (soup.find("main")
            or soup.find("article")
            or soup.find(id=re.compile(r"content|main|body", re.I))
            or soup.find(class_=re.compile(r"content|main|intro|about", re.I))
            or soup.body)
    if main:
        for p in main.find_all("p"):
            t = clean(p.get_text(" "))
            # Must be substantial and not a cookie notice / copyright line
            if (len(t) > 80
                    and not re.search(r"cookie|copyright|©|privacy policy", t, re.I)):
                return t[:MAX_DESC]

    return ""


def fetch_description(url: str) -> str:
    """Fetch URL and extract description. Returns '' on failure."""
    try:
        time.sleep(DELAY)
        r = SESSION.get(url, timeout=TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "html" not in ct and "text" not in ct:
            return ""
        return extract_description(r.text, url)
    except Exception as exc:
        print(f"  [warn] fetch error for {url}: {exc}")
        return ""


# ── Cache helpers ─────────────────────────────────────────────────────────────

def load_cache() -> dict:
    if CACHE_JSON.exists():
        try:
            return json.loads(CACHE_JSON.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    CACHE_JSON.write_text(
        json.dumps(cache, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not URL_CSV.exists():
        print(f"ERROR: {URL_CSV} not found. Run find_conf_urls.py first.", file=sys.stderr)
        sys.exit(1)
    if not CORE_JSON.exists():
        print(f"ERROR: {CORE_JSON} not found.", file=sys.stderr)
        sys.exit(1)

    top_only = "--top" in sys.argv

    # Read the URL CSV
    rows: list[dict] = []
    with open(URL_CSV, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("url"):
                continue
            if top_only and row.get("rank") not in TOP_RANKS:
                continue
            rows.append(row)

    print(f"Processing {len(rows)} conferences with URLs …")

    core  = json.loads(CORE_JSON.read_text(encoding="utf-8"))
    cache = load_cache()

    fetched = skipped = failed = 0

    for i, row in enumerate(rows, 1):
        acronym = row["acronym"].strip().upper()
        url     = row["url"].strip()

        if not url:
            continue

        # Use cache if available
        if acronym in cache:
            desc = cache[acronym]
            if desc:
                entry = core["by_acronym"].get(acronym)
                if entry is not None:
                    entry["description"] = desc
            skipped += 1
            continue

        print(f"  [{i}/{len(rows)}] {acronym}: ", end="", flush=True)
        desc = fetch_description(url)

        if desc:
            cache[acronym] = desc
            entry = core["by_acronym"].get(acronym)
            if entry is not None:
                entry["description"] = desc
            print(f"{desc[:80]}…" if len(desc) > 80 else desc)
            fetched += 1
        else:
            cache[acronym] = ""
            print("no description found")
            failed += 1

        save_cache(cache)

    # Write enriched core.json
    CORE_JSON.write_text(
        json.dumps(core, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = CORE_JSON.stat().st_size / 1024
    print(f"\nDone.")
    print(f"  Descriptions fetched : {fetched}")
    print(f"  Loaded from cache    : {skipped}")
    print(f"  No description found : {failed}")
    print(f"  Wrote {CORE_JSON} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
