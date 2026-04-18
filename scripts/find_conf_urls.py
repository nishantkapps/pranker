#!/usr/bin/env python3
"""Find official website URLs for all conferences in core.json.

Sources (tried in order per conference):
  1. aideadlin.es YAML  — authoritative for CS/AI/ML
  2. DuckDuckGo HTML search — automatic fallback for the rest

Output:
  data/conf_urls.csv     — one row per conference; review / edit this file
  data/conf_urls_cache.json — raw search results cache (speeds up reruns)

After reviewing conf_urls.csv, run:
  python scripts/enrich_conf_descriptions.py
to fetch pages and store descriptions in core.json.

Usage:
  python scripts/find_conf_urls.py            # full run (slow first time)
  python scripts/find_conf_urls.py --top      # only A*/A conferences
  python scripts/find_conf_urls.py --export-only  # skip search, just export CSV
"""

import csv
import json
import re
import sys
import time
from pathlib import Path
import requests
try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS

DATA_DIR   = Path(__file__).resolve().parent.parent / "data"
CORE_JSON  = DATA_DIR / "core.json"
CACHE_JSON = DATA_DIR / "conf_urls_cache.json"
OUTPUT_CSV = DATA_DIR / "conf_urls.csv"

AIDEADLINES_URL = (
    "https://raw.githubusercontent.com/paperswithcode/ai-deadlines/"
    "gh-pages/_data/conferences.yml"
)

# Domains that are NOT the official conference website
BAD_DOMAINS = {
    "dblp.org", "dblp.uni-trier.de",
    "wikipedia.org", "en.wikipedia.org",
    "scholar.google.com", "google.com",
    "semanticscholar.org",
    "dl.acm.org",           # proceedings, not site
    "ieeexplore.ieee.org",  # proceedings
    "springer.com", "link.springer.com",
    "arxiv.org",
    "researchgate.net",
    "core.ac.uk",
    "portal.core.edu.au",
    "twitter.com", "x.com", "linkedin.com", "facebook.com",
    "youtube.com",
    "github.com",
    "reddit.com",
    "showsbee.com", "callforpaper.org", "iconf.com", "10times.com",
    "confhub.net", "allconferencecfp.com", "wikicfp.com",
    "papercept.net", "easychair.org",
}

DELAY = 0.8   # seconds between DuckDuckGo requests
TOP_RANKS = {"A*", "A"}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
})


# ── aideadlin.es helpers ──────────────────────────────────────────────────────

def load_aideadlines() -> dict[str, str]:
    """Return {ACRONYM: url} from aideadlin.es YAML."""
    try:
        import yaml
    except ImportError:
        print("[warn] pyyaml not installed; skipping aideadlin.es source")
        return {}
    try:
        r = SESSION.get(AIDEADLINES_URL, timeout=20)
        r.raise_for_status()
        data = yaml.safe_load(r.text)
        best: dict[str, dict] = {}
        for e in data:
            if not isinstance(e, dict) or not e.get("link"):
                continue
            name = (e.get("title") or "").upper().strip()
            if not name:
                continue
            start = str(e.get("start") or e.get("year") or "0")
            if name not in best or start > str(best[name].get("start") or best[name].get("year") or "0"):
                best[name] = e
        return {k: v["link"] for k, v in best.items() if v.get("link")}
    except Exception as exc:
        print(f"[warn] Could not load aideadlin.es: {exc}")
        return {}


# ── DuckDuckGo search ─────────────────────────────────────────────────────────

_ddgs = DDGS()


def ddg_first_good_url(query: str) -> str | None:
    """Run a DDG text search and return the first non-bad-domain URL."""
    try:
        time.sleep(DELAY)
        results = _ddgs.text(query, max_results=8)
        for r in results:
            href = r.get("href", "")
            domain = re.sub(r"^https?://(?:www\.)?", "", href).split("/")[0].lower()
            if href.startswith("http") and not any(bd in domain for bd in BAD_DOMAINS):
                return href
    except Exception as exc:
        print(f"  [warn] DDG error: {exc}")
    return None


def find_url_for(acronym: str, title: str) -> tuple[str, str]:
    """Return (url, source) for a conference. source is 'ddg' or ''."""
    url = ddg_first_good_url(f'"{acronym}" conference official website')
    if url:
        return url, "ddg"
    short_title = title[:60]
    url = ddg_first_good_url(f'"{short_title}" conference official site')
    if url:
        return url, "ddg"
    return "", ""


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
    export_only  = "--export-only" in sys.argv
    top_only     = "--top" in sys.argv

    core  = json.loads(CORE_JSON.read_text(encoding="utf-8"))
    cache = load_cache()

    # Pre-load aideadlin.es URLs
    if not export_only:
        print("Loading aideadlin.es URLs …")
        ai_urls = load_aideadlines()
        print(f"  Got {len(ai_urls)} conference URLs from aideadlin.es")
    else:
        ai_urls = {}

    by_acronym = core.get("by_acronym", {})
    entries = list(by_acronym.items())
    if top_only:
        entries = [(a, e) for a, e in entries if e.get("r") in TOP_RANKS]
        print(f"--top: processing {len(entries)} A*/A conferences only")

    found = skipped = searched = not_found = 0

    for i, (acronym, entry) in enumerate(entries, 1):
        rank  = entry.get("r", "")
        title = entry.get("t", "")

        # Already have a URL in cache?
        if acronym in cache and cache[acronym].get("url"):
            skipped += 1
            continue

        # Check aideadlin.es
        if acronym in ai_urls:
            cache[acronym] = {"url": ai_urls[acronym], "source": "aideadlines"}
            save_cache(cache)
            found += 1
            if i % 50 == 0 or found <= 5:
                print(f"  [{i}/{len(entries)}] {acronym}: {ai_urls[acronym]} (aideadlines)")
            continue

        if export_only:
            continue

        # DuckDuckGo search
        print(f"  [{i}/{len(entries)}] {acronym} ({rank}): searching … ", end="", flush=True)
        url, source = find_url_for(acronym, title)
        if url:
            cache[acronym] = {"url": url, "source": source}
            print(f"→ {url}")
            found += 1
        else:
            cache[acronym] = {"url": "", "source": ""}
            print("not found")
            not_found += 1
        searched += 1
        save_cache(cache)

    # Write CSV for review
    rows = []
    for acronym, entry in by_acronym.items():
        if top_only and entry.get("r") not in TOP_RANKS:
            continue
        c = cache.get(acronym, {})
        rows.append({
            "acronym":  acronym,
            "title":    entry.get("t", ""),
            "rank":     entry.get("r", ""),
            "url":      c.get("url", ""),
            "source":   c.get("source", ""),
        })

    rows.sort(key=lambda r: ({"A*": 0, "A": 1, "B": 2, "C": 3}.get(r["rank"], 9), r["acronym"]))

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["acronym", "title", "rank", "url", "source"])
        w.writeheader()
        w.writerows(rows)

    print(f"\nDone.")
    print(f"  From aideadlin.es / cache : {skipped + found - searched}")
    print(f"  Found via DuckDuckGo      : {searched - not_found}")
    print(f"  Not found                 : {not_found}")
    print(f"\nReview / edit: {OUTPUT_CSV}")
    print("Then run: python scripts/enrich_conf_descriptions.py")


if __name__ == "__main__":
    main()
