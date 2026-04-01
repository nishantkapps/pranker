#!/usr/bin/env python3
"""Download CORE conference ranking data and produce a compact JSON lookup file.

Scrapes the CORE portal at portal.core.edu.au/conf-ranks/ page by page.

Output: data/core.json with structure:
{
  "updated": "2026-04-01",
  "by_acronym": { "ICSE": { "t": "International Conference on ...", "r": "A*" }, ... },
  "by_title": { "normalized title": { "a": "ICSE", "r": "A*" }, ... }
}
"""

import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

CORE_BASE_URL = "https://portal.core.edu.au/conf-ranks/"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "core.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

VALID_RANKS = {"A*", "A", "B", "C"}
MAX_RETRIES = 3


def normalize_title(title: str) -> str:
    title = title.lower().strip()
    title = re.sub(r"[^\w\s]", "", title)
    title = re.sub(r"\s+", " ", title)
    return title


def fetch_page(page: int) -> requests.Response:
    """Fetch a single page from the CORE portal."""
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
    """Parse the HTML table and extract conference entries."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table")
    if not table:
        return []

    entries = []
    rows = table.find_all("tr")
    for row in rows[1:]:  # skip header
        cells = row.find_all("td")
        if len(cells) < 4:
            continue

        title = cells[0].get_text(strip=True)
        acronym = cells[1].get_text(strip=True)
        source = cells[2].get_text(strip=True)
        rank = cells[3].get_text(strip=True)

        if rank not in VALID_RANKS:
            continue

        if title and acronym:
            entries.append({"title": title, "acronym": acronym, "rank": rank})

    return entries


def scrape_all_pages() -> list[dict]:
    """Scrape all pages from the CORE portal with retry logic."""
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

            except requests.RequestException as e:
                print(f"  Attempt {attempt}/{MAX_RETRIES} failed: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(3 * attempt)

        if not success:
            consecutive_failures += 1
            print(f"  Skipping page {page} after {MAX_RETRIES} retries")

        page += 1
        time.sleep(2)

    return all_entries


def build_json(entries: list[dict]) -> dict:
    """Build the lookup dictionaries from parsed entries."""
    by_acronym: dict[str, dict] = {}
    by_title: dict[str, dict] = {}

    for entry in entries:
        acronym = entry["acronym"].upper()
        title = entry["title"]
        rank = entry["rank"]

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
    entries = scrape_all_pages()

    if not entries:
        print("WARNING: No entries scraped. Writing empty data file.", file=sys.stderr)

    data = build_json(entries)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
