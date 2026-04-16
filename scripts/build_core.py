#!/usr/bin/env python3
"""Build CORE conference ranking data into a compact JSON lookup file.

Preferred mode — CSV file (fast, no network needed):
  Download all conferences from https://portal.core.edu.au/conf-ranks/
  (select source ICORE2026, click Export CSV), save as data/core_raw.csv,
  then run this script.

Fallback mode — web scraping:
  If data/core_raw.csv is not present the script scrapes the CORE portal
  page by page. This is slower and may be blocked by the portal.

Output: data/core.json
{
  "updated": "2026-04-16",
  "by_acronym": { "ICRA": { "t": "IEEE Int'l Conference on Robotics...", "r": "A*" }, ... },
  "by_title":   { "normalized title": { "a": "ICRA", "r": "A*" }, ... }
}
"""

import csv
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CSV_PATH = DATA_DIR / "core_raw.csv"
OUTPUT_PATH = DATA_DIR / "core.json"

# For deduplication: keep the entry with the highest-known rank when the same
# acronym appears more than once. Anything not listed here gets score 0.
RANK_ORDER = {"A*": 5, "A": 4, "B": 3, "Australasian B": 3, "C": 2, "Australasian C": 2}


def normalize_title(title: str) -> str:
    title = title.lower().strip()
    title = re.sub(r"[^\w\s]", "", title)
    title = re.sub(r"\s+", " ", title)
    return title


# ── CSV mode ──────────────────────────────────────────────────────────────────

def load_from_csv(path: Path) -> list[dict]:
    """Parse the CSV exported from portal.core.edu.au.

    Expected columns (no header row in export):
      ID, Title, Acronym, Source, Rank, DBLP, FoR1, FoR2, ...
    """
    entries = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if len(row) < 5:
                continue
            title   = row[1].strip()
            acronym = row[2].strip().upper()
            rank    = row[4].strip()
            if not title or not acronym:
                continue
            entries.append({"title": title, "acronym": acronym, "rank": rank})
    return entries


# ── Scrape mode ───────────────────────────────────────────────────────────────

CORE_BASE_URL = "https://portal.core.edu.au/conf-ranks/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
MAX_RETRIES = 3


def fetch_page(page: int):
    import requests
    params = {
        "search": "",
        "by": "all",
        "source": "ICORE2026",
        "sort": "atitle",
        "page": page,
    }
    resp = requests.get(CORE_BASE_URL, params=params, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    return resp


def parse_table(html: str) -> list[dict]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table")
    if not table:
        return []
    entries = []
    for row in table.find_all("tr")[1:]:
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        title   = cells[0].get_text(strip=True)
        acronym = cells[1].get_text(strip=True)
        rank    = cells[3].get_text(strip=True)
        if not title or not acronym:
            continue
        entries.append({"title": title, "acronym": acronym.upper(), "rank": rank})
    return entries


def scrape_all_pages() -> list[dict]:
    all_entries: list[dict] = []
    page = 1
    consecutive_failures = 0
    while consecutive_failures < 3:
        print(f"Fetching page {page} ...")
        success = False
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = fetch_page(page)
                entries = parse_table(resp.text)
                if not entries:
                    print(f"  No entries on page {page}, done.")
                    return all_entries
                all_entries.extend(entries)
                print(f"  Got {len(entries)} entries (total: {len(all_entries)})")
                consecutive_failures = 0
                success = True
                break
            except Exception as e:
                print(f"  Attempt {attempt}/{MAX_RETRIES} failed: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(3 * attempt)
        if not success:
            consecutive_failures += 1
            print(f"  Skipping page {page} after {MAX_RETRIES} retries")
        page += 1
        time.sleep(2)
    return all_entries


# ── Build JSON ────────────────────────────────────────────────────────────────

def build_json(entries: list[dict]) -> dict:
    by_acronym: dict[str, dict] = {}
    by_title: dict[str, dict] = {}
    for entry in entries:
        acronym = entry["acronym"]
        title   = entry["title"]
        rank    = entry["rank"]
        # Keep the higher-ranked entry when the same acronym appears twice
        existing = by_acronym.get(acronym)
        if existing and RANK_ORDER.get(existing["r"], 0) >= RANK_ORDER.get(rank, 0):
            continue
        by_acronym[acronym] = {"t": title, "r": rank}
        norm = normalize_title(title)
        if norm:
            by_title[norm] = {"a": acronym, "r": rank}
    print(f"Built {len(by_acronym)} acronyms, {len(by_title)} titles")
    return {
        "updated": date.today().isoformat(),
        "by_acronym": by_acronym,
        "by_title": by_title,
    }


def main():
    if CSV_PATH.exists():
        print(f"Loading from CSV: {CSV_PATH}")
        entries = load_from_csv(CSV_PATH)
    else:
        print(f"CSV not found at {CSV_PATH}, falling back to web scraping …")
        entries = scrape_all_pages()

    if not entries:
        print("WARNING: No entries found. Writing empty data file.", file=sys.stderr)

    data = build_json(entries)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
