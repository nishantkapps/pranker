#!/usr/bin/env python3
"""Enrich data/core.json with DBLP venue URLs and topic keywords.

Run once after build_core.py:
    python scripts/enrich_core_dblp.py

For each conference in core.json, this script:
  1. Queries the DBLP venue search API to find the DBLP URL
  2. Fetches up to 100 recent paper titles from DBLP
  3. Extracts the most frequent topic keywords from those titles
  4. Adds 'dblp' (URL string) and 'topics' (list of strings) to each entry

Results are cached in data/core_dblp_cache.json so re-runs skip already-fetched entries.
"""

import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

import requests

DATA_DIR  = Path(__file__).resolve().parent.parent / "data"
CORE_JSON  = DATA_DIR / "core.json"
CACHE_JSON = DATA_DIR / "core_dblp_cache.json"

DBLP_VENUE_API = "https://dblp.org/search/venue/api"
DBLP_PUBL_API  = "https://dblp.org/search/publ/api"
DELAY      = 0.6   # seconds between requests (be polite to DBLP)
MAX_PAPERS = 100
TOP_TOPICS = 15

# Words that carry no topical signal and should be dropped from topic tags
STOP_WORDS: set[str] = {
    "a", "an", "the", "and", "or", "for", "with", "from", "that", "this",
    "are", "was", "its", "has", "not", "but", "all", "can", "will", "may",
    "such", "on", "in", "of", "to", "at", "by", "via", "as", "be", "is",
    "it", "we", "our", "new", "using", "based", "towards", "toward", "into",
    "over", "under", "cross", "joint", "inter", "non", "self", "per",
    "deep", "large", "high", "low", "real", "fast", "first", "end", "multi",
    "de", "le", "et", "al", "vs", "ie", "eg",
    "system", "systems", "method", "methods", "approach", "framework",
    "model", "models", "data", "dataset", "task", "tasks", "performance",
    "efficient", "effective", "novel", "improved", "scalable",
    "analysis", "evaluation", "study", "survey", "review",
    "network", "networks", "architecture", "architectures",
    "representation", "representations", "learning", "training",
    "generative", "discriminative", "supervised", "unsupervised",
    "attention", "transformer", "encoder", "decoder",
}

SESSION = requests.Session()
SESSION.headers["User-Agent"] = (
    "P-Ranker-Enricher/1.0 "
    "(https://github.com/; enriching CORE venue data for a research-tool)"
)


# ── DBLP helpers ──────────────────────────────────────────────────────────────

def dblp_venue_search(acronym: str) -> dict | None:
    """Return the best-matching DBLP venue info dict for *acronym*, or None."""
    params = {"q": acronym, "format": "json", "h": 5, "c": 0}
    try:
        r = SESSION.get(DBLP_VENUE_API, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        hits_section = data.get("result", {}).get("hits", {})
        if int(hits_section.get("@total", 0)) == 0:
            return None
        raw_hits = hits_section.get("hit", [])
        if isinstance(raw_hits, dict):
            raw_hits = [raw_hits]
        # Prefer an exact acronym match
        for hit in raw_hits:
            info = hit.get("info", {})
            if info.get("acronym", "").upper() == acronym.upper():
                return info
        # Fall back to first hit when there is only one
        if len(raw_hits) == 1:
            return raw_hits[0].get("info")
        return None
    except Exception as exc:
        print(f"  [warn] DBLP venue search error for {acronym}: {exc}", file=sys.stderr)
        return None


def dblp_key_from_url(url: str) -> tuple[str, str] | None:
    """Parse (stream_type, key) from a DBLP URL.

    e.g. "https://dblp.org/db/conf/icra/" → ("conf", "icra")
    """
    m = re.search(r"/db/(conf|journals)/([^/]+)/", url)
    return (m.group(1), m.group(2)) if m else None


def dblp_fetch_titles(stream_type: str, key: str) -> list[str]:
    """Return up to MAX_PAPERS paper titles for a DBLP stream."""
    params = {
        "q": f"streamid:{stream_type}/{key}:",
        "format": "json",
        "h": MAX_PAPERS,
        "c": 0,
    }
    try:
        time.sleep(DELAY)
        r = SESSION.get(DBLP_PUBL_API, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        raw_hits = data.get("result", {}).get("hits", {}).get("hit", [])
        if isinstance(raw_hits, dict):
            raw_hits = [raw_hits]
        return [h.get("info", {}).get("title", "") for h in raw_hits if h.get("info", {}).get("title")]
    except Exception as exc:
        print(f"  [warn] DBLP paper fetch error for {stream_type}/{key}: {exc}", file=sys.stderr)
        return []


# ── Topic extraction ──────────────────────────────────────────────────────────

def extract_topics(titles: list[str], top_n: int = TOP_TOPICS) -> list[str]:
    """Return the *top_n* most-frequent meaningful words across all titles."""
    counter: Counter[str] = Counter()
    for title in titles:
        for word in re.findall(r"[a-z]+", title.lower()):
            if len(word) < 4 or word in STOP_WORDS:
                continue
            counter[word] += 1
    return [w for w, _ in counter.most_common(top_n)]


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
    if not CORE_JSON.exists():
        print(f"ERROR: {CORE_JSON} not found. Run build_core.py first.", file=sys.stderr)
        sys.exit(1)

    core  = json.loads(CORE_JSON.read_text(encoding="utf-8"))
    cache = load_cache()

    by_acronym = core.get("by_acronym", {})
    total      = len(by_acronym)
    enriched   = skipped = not_found = 0

    print(f"Enriching {total} conferences with DBLP data …")
    print(f"(results cached to {CACHE_JSON}; re-runs are fast)\n")

    for i, (acronym, entry) in enumerate(by_acronym.items(), 1):
        # Use cache when available
        if acronym in cache:
            cached = cache[acronym]
            if cached.get("dblp"):
                entry["dblp"] = cached["dblp"]
            if cached.get("topics"):
                entry["topics"] = cached["topics"]
            skipped += 1
            if i % 200 == 0:
                print(f"  [{i}/{total}] … (from cache)")
            continue

        print(f"  [{i}/{total}] {acronym}: ", end="", flush=True)

        # Step 1 — find DBLP venue URL
        time.sleep(DELAY)
        venue_info = dblp_venue_search(acronym)

        if not venue_info:
            print("not found in DBLP")
            cache[acronym] = {"dblp": "", "topics": []}
            save_cache(cache)
            not_found += 1
            continue

        dblp_url = venue_info.get("url", "")
        entry["dblp"] = dblp_url

        # Step 2 — fetch paper titles and extract topics
        parsed = dblp_key_from_url(dblp_url) if dblp_url else None
        topics: list[str] = []

        if parsed:
            stream_type, key = parsed
            titles = dblp_fetch_titles(stream_type, key)
            topics = extract_topics(titles)
            print(
                f"found ({stream_type}/{key}), "
                f"{len(titles)} papers → {len(topics)} topics"
            )
        else:
            print(f"URL={dblp_url or '(none)'}, no stream key")

        if topics:
            entry["topics"] = topics

        cache[acronym] = {"dblp": dblp_url, "topics": topics}
        save_cache(cache)
        enriched += 1

    # Write enriched core.json back
    CORE_JSON.write_text(
        json.dumps(core, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = CORE_JSON.stat().st_size / 1024
    print(f"\nDone.")
    print(f"  Enriched from DBLP : {enriched}")
    print(f"  Loaded from cache  : {skipped}")
    print(f"  Not found in DBLP  : {not_found}")
    print(f"  Wrote {CORE_JSON} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
