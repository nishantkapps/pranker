#!/usr/bin/env python3
"""Download SCImago journal ranking data and produce a compact JSON lookup file.

Output: data/scimago.json with structure:
{
  "updated": "2026-04-01",
  "by_issn": { "1234-5678": { "t": "Journal Title", "q": "Q1" }, ... },
  "by_title": { "normalized title": { "i": "1234-5678", "q": "Q1" }, ... }
}
"""

import csv
import io
import json
import re
import sys
import time
import zipfile
from datetime import date
from pathlib import Path

import requests

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "scimago.json"

DOWNLOAD_URLS = [
    "https://www.scimagojr.com/journalrank.php?out=xls",
    "https://www.scimagojr.com/journalrank.php?year=2023&out=xls",
    "https://www.scimagojr.com/journalrank.php?year=2022&out=xls",
]

MAX_RETRIES = 3
RETRY_DELAY = 5


def normalize_title(title: str) -> str:
    """Lowercase, strip punctuation and extra whitespace."""
    title = title.lower().strip()
    title = re.sub(r"[^\w\s]", "", title)
    title = re.sub(r"\s+", " ", title)
    return title


def _normalize_issn_digits(eight: str) -> str:
    """SCImago CSV often uses 8 digits without hyphen; CrossRef uses NNNN-NNNX."""
    eight = eight.strip().upper()
    if len(eight) != 8:
        return ""
    if not eight[:7].isdigit():
        return ""
    last = eight[7]
    if not (last.isdigit() or last == "X"):
        return ""
    return f"{eight[:4]}-{eight[4:7]}{last}"


def parse_issns(issn_field: str) -> list[str]:
    """Extract ISSNs from a field; SCImago uses unhyphenated 8-digit blocks."""
    seen: set[str] = set()
    out: list[str] = []

    for m in re.findall(r"\d{4}-\d{3}[\dXx]", issn_field):
        u = m.upper()
        if u not in seen:
            seen.add(u)
            out.append(u)

    for m in re.findall(r"\b\d{8}\b", issn_field.replace(",", " ")):
        u = _normalize_issn_digits(m)
        if u and u not in seen:
            seen.add(u)
            out.append(u)

    return out


def find_local_scimago_csv() -> Path | None:
    """Prefer scimago_raw.csv, then scimagojr *.csv in data/."""
    data_dir = Path(__file__).resolve().parent.parent / "data"
    candidates = [
        data_dir / "scimago_raw.csv",
        data_dir / "scimagojr 2024.csv",
    ]
    for p in candidates:
        if p.is_file():
            return p
    for p in sorted(data_dir.glob("scimagojr*.csv")):
        if p.is_file():
            return p
    for p in sorted(data_dir.glob("**/scimagojr*.csv")):
        if p.is_file():
            return p
    return None


def download_scimago_data() -> str:
    """Download the SCImago CSV/XLS export. Returns raw text content."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    session = requests.Session()
    session.headers.update(headers)

    for url in DOWNLOAD_URLS:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                print(f"Downloading from {url} (attempt {attempt}/{MAX_RETRIES}) ...")
                resp = session.get(url, timeout=120)
                resp.raise_for_status()

                content_type = resp.headers.get("Content-Type", "")
                if "zip" in content_type or resp.content[:4] == b"PK\x03\x04":
                    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                        for name in zf.namelist():
                            if name.endswith(".csv"):
                                return zf.read(name).decode("utf-8-sig")
                        return zf.read(zf.namelist()[0]).decode("utf-8-sig")

                text = resp.content.decode("utf-8-sig")
                if ";" in text[:500] or "Title" in text[:500]:
                    return text

                print(f"  Response doesn't look like CSV data, trying next URL...")
                break

            except requests.RequestException as e:
                print(f"  Attempt {attempt} failed: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY * attempt)
                continue

    print("ERROR: Could not download SCImago data from any source.", file=sys.stderr)
    print("TIP: You can manually download from https://www.scimagojr.com/journalrank.php")
    print("     and place the CSV as data/scimago_raw.csv, then run this script with --local")
    sys.exit(1)


def build_json(raw_csv: str) -> dict:
    """Parse the CSV and build the lookup dictionaries."""
    by_issn: dict[str, dict] = {}
    by_title: dict[str, dict] = {}

    reader = csv.DictReader(io.StringIO(raw_csv), delimiter=";")

    if reader.fieldnames is None:
        reader = csv.DictReader(io.StringIO(raw_csv), delimiter=",")

    row_count = 0
    for row in reader:
        title = row.get("Title", "").strip()
        if not title:
            continue

        quartile_field = (
            row.get("SJR Best Quartile", "")
            or row.get("sjr_best_quartile", "")
            or ""
        ).strip()

        if quartile_field not in ("Q1", "Q2", "Q3", "Q4"):
            quartile_field = "-"

        issn_raw = row.get("Issn", "") or row.get("issn", "") or ""
        issns = parse_issns(issn_raw)

        entry_for_issn = {"t": title, "q": quartile_field}
        for issn in issns:
            by_issn[issn.upper()] = entry_for_issn

        norm = normalize_title(title)
        if norm:
            first_issn = issns[0].upper() if issns else ""
            by_title[norm] = {"i": first_issn, "q": quartile_field}

        row_count += 1

    print(f"Processed {row_count} journals, {len(by_issn)} ISSNs, {len(by_title)} titles")
    return {
        "updated": date.today().isoformat(),
        "by_issn": by_issn,
        "by_title": by_title,
    }


def main():
    local_csv = find_local_scimago_csv()
    if "--force-download" not in sys.argv and local_csv is not None:
        print(f"Reading local file: {local_csv}")
        raw = local_csv.read_text(encoding="utf-8-sig")
    elif "--local" in sys.argv:
        print("ERROR: No local CSV found in data/ (scimago_raw.csv or scimagojr*.csv)", file=sys.stderr)
        sys.exit(1)
    else:
        raw = download_scimago_data()

    data = build_json(raw)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
