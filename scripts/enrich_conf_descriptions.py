#!/usr/bin/env python3
"""Scrape conference homepages and extract topics/scope into core.json.

Strategy (in priority order):
  1. Find a heading containing "topic", "scope", "call for paper", "aim",
     "area" — then extract bullet-point list items beneath it.
  2. Fall back to finding any substantial paragraph near those headings.
  3. Last resort: first meaningful paragraph in the main content area.

The extracted text is stored as `description` in core.json and is used
by the venues page for display and relevance scoring.

Usage:
  python scripts/enrich_conf_descriptions.py           # all conferences
  python scripts/enrich_conf_descriptions.py --top     # A*/A only
  python scripts/enrich_conf_descriptions.py --reset   # clear cache and refetch all

Cache: data/conf_desc_cache.json  (skip already-fetched entries on rerun)
"""

import csv
import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup, NavigableString

DATA_DIR   = Path(__file__).resolve().parent.parent / "data"
CORE_JSON  = DATA_DIR / "core.json"
URL_CSV    = DATA_DIR / "conf_urls.csv"
CACHE_JSON = DATA_DIR / "conf_desc_cache.json"

DELAY   = 0.8   # seconds between page fetches
TIMEOUT = 15
MAX_DESC = 800  # max characters stored

TOP_RANKS = {"A*", "A"}

# Headings that introduce topics/scope on conference pages
SCOPE_RE = re.compile(
    r"\b(topic|scope|aim|area|theme|subject|track|call.for.paper|research.area|"
    r"focus|interest|coverage)\b",
    re.IGNORECASE,
)

# Headings to stop at (navigation / unrelated sections)
STOP_RE = re.compile(
    r"\b(sponsor|committee|organiz|chair|keynote|speaker|schedule|program|"
    r"registration|venue|hotel|contact|travel|accept|submission|important.date|"
    r"deadline|fee|award|proceed|review|paper.format)\b",
    re.IGNORECASE,
)

# Tags whose text we never want
SKIP_TAGS = {"script", "style", "noscript", "meta", "link", "head",
             "nav", "footer", "header", "aside", "form"}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})


# ── Text helpers ──────────────────────────────────────────────────────────────

def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def is_junk(text: str) -> bool:
    """True if the text looks like a cookie notice, nav item, copyright, etc."""
    if len(text) < 20:
        return True
    junk_patterns = [
        r"cookie", r"copyright", r"©", r"privacy policy",
        r"all rights reserved", r"^\s*(home|about|contact|login|register)\s*$",
        r"^\s*\d{4}\s*$",   # bare year
    ]
    return any(re.search(p, text, re.IGNORECASE) for p in junk_patterns)


# ── Core extraction ───────────────────────────────────────────────────────────

def extract_items_after(heading) -> list[str]:
    """Collect list items (li) that follow a heading until a stop heading."""
    items = []
    for sib in heading.next_siblings:
        if isinstance(sib, NavigableString):
            continue
        name = getattr(sib, "name", None)
        if not name:
            continue
        # Stop at the next heading
        if re.match(r"^h[1-5]$", name):
            h_text = clean(sib.get_text(" "))
            if STOP_RE.search(h_text) or (items and not SCOPE_RE.search(h_text)):
                break
        # Collect list items
        if name in ("ul", "ol"):
            for li in sib.find_all("li", recursive=True):
                t = clean(li.get_text(" "))
                if 10 < len(t) < 200 and not is_junk(t):
                    items.append(t)
            if items:
                return items
        # Paragraph fallback
        if name == "p":
            t = clean(sib.get_text(" "))
            if len(t) > 60 and not is_junk(t):
                items.append(t)
                if len(" • ".join(items)) > MAX_DESC:
                    break
    return items


def extract_description(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")

    # Remove known-noise elements
    for tag in soup(SKIP_TAGS):
        tag.decompose()

    # ── Strategy 1: find a scope/topics heading and grab items beneath it ──
    for heading in soup.find_all(re.compile(r"^h[1-5]$")):
        h_text = clean(heading.get_text(" "))
        if SCOPE_RE.search(h_text) and not STOP_RE.search(h_text):
            items = extract_items_after(heading)
            if items:
                joined = " • ".join(items)
                return joined[:MAX_DESC]

    # ── Strategy 2: look for any <ul>/<ol> near "topics" text on the page ──
    for ul in soup.find_all(["ul", "ol"]):
        # Check the preceding sibling / parent for scope keywords
        context = ""
        prev = ul.find_previous_sibling()
        if prev:
            context = clean(prev.get_text(" "))
        parent = ul.parent
        if parent:
            context += " " + clean(parent.get_text(" "))[:200]
        if SCOPE_RE.search(context):
            items = [clean(li.get_text(" ")) for li in ul.find_all("li")]
            items = [t for t in items if 10 < len(t) < 200 and not is_junk(t)]
            if len(items) >= 3:
                return (" • ".join(items))[:MAX_DESC]

    # ── Strategy 3: first meaningful paragraph in main content ──
    main = (soup.find("main")
            or soup.find("article")
            or soup.find(id=re.compile(r"content|main|body", re.I))
            or soup.find(class_=re.compile(r"content|main|intro|about", re.I))
            or soup.body)
    if main:
        for p in main.find_all("p"):
            t = clean(p.get_text(" "))
            if len(t) > 80 and not is_junk(t):
                return t[:MAX_DESC]

    return ""


CFP_PATHS = [
    "/call-for-papers", "/cfp", "/call", "/topics",
    "/authors", "/papers", "/submissions", "/scope",
]

CFP_LINK_RE = re.compile(
    r"call.for.paper|cfp|topic|scope|author.guideline|submission",
    re.IGNORECASE,
)


def fetch_html(url: str) -> str | None:
    """Fetch a URL and return HTML text, or None on failure."""
    try:
        r = SESSION.get(url, timeout=TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "html" not in ct and "text" not in ct:
            return None
        return r.text
    except Exception:
        return None


def find_cfp_link(html: str, base_url: str) -> str | None:
    """Find a CFP/topics link on the page and return its absolute URL."""
    from urllib.parse import urljoin
    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a", href=True):
        text = clean(a.get_text(" "))
        href = a["href"]
        if CFP_LINK_RE.search(text) or CFP_LINK_RE.search(href):
            full = urljoin(base_url, href)
            # Stay on same domain
            from urllib.parse import urlparse
            if urlparse(full).netloc == urlparse(base_url).netloc:
                return full
    return None


def fetch_description(url: str) -> str:
    from urllib.parse import urljoin, urlparse

    time.sleep(DELAY)
    html = fetch_html(url)
    if not html:
        return ""

    # Try homepage first
    desc = extract_description(html)
    if desc and " • " in desc:
        # Got a proper topic list — use it
        return desc

    # Try CFP sub-pages by following link found on homepage
    cfp_url = find_cfp_link(html, url)
    if cfp_url and cfp_url != url:
        time.sleep(DELAY)
        cfp_html = fetch_html(cfp_url)
        if cfp_html:
            cfp_desc = extract_description(cfp_html)
            if cfp_desc:
                return cfp_desc

    # Try common path patterns on same domain
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    for path in CFP_PATHS:
        candidate = base + path
        if candidate == url or candidate == cfp_url:
            continue
        time.sleep(DELAY * 0.5)
        path_html = fetch_html(candidate)
        if path_html:
            path_desc = extract_description(path_html)
            if path_desc:
                return path_desc

    # Fall back to homepage paragraph even without bullet points
    return desc


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

    top_only  = "--top"   in sys.argv
    reset     = "--reset" in sys.argv

    # Read URL CSV
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
    cache = {} if reset else load_cache()

    fetched = skipped = failed = 0

    for i, row in enumerate(rows, 1):
        acronym = row["acronym"].strip().upper()
        url     = row["url"].strip()

        if not url:
            continue

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

        # Fall back to DBLP topics if no web description found
        if not desc:
            entry = core["by_acronym"].get(acronym)
            if entry and entry.get("topics"):
                desc = "Topics: " + ", ".join(entry["topics"][:20])

        cache[acronym] = desc
        save_cache(cache)

        if desc:
            entry = core["by_acronym"].get(acronym)
            if entry is not None:
                entry["description"] = desc
            preview = desc[:90].replace("\n", " ")
            print(f"{preview}{'…' if len(desc) > 90 else ''}")
            fetched += 1
        else:
            print("no description found")
            failed += 1

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
