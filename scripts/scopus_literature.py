"""Shared Scopus Search logic for CLI and the optional P Ranker proxy server."""

from __future__ import annotations

import os
import re
import time
from typing import Any

import requests

SCOPUS_SEARCH_URL = "https://api.elsevier.com/content/search/scopus"
MAX_PAGE = 200
DEFAULT_SLEEP_S = 0.12


def normalize_venue_key(name: str) -> str:
    """Match venues.js normalizeForMatch: lowercase, strip non-alphanumerics."""
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def normalize_issn_key(issn: str) -> str:
    """Match venues.js normalizeIssnKeyLiterature / app.js."""
    if not issn:
        return ""
    s = re.sub(r"[^\dX-]", "", str(issn).upper().strip())
    if re.fullmatch(r"\d{8}", s):
        return f"{s[:4]}-{s[4:]}"
    return s


def build_default_query(user_words: str) -> str:
    """Wrap free text as a Scopus TITLE-ABS-KEY search (tokens ANDed)."""
    text = " ".join(user_words.split())
    if not text:
        raise ValueError("Empty search query.")
    parts = re.findall(r"[^\s,;]+", text)
    if not parts:
        raise ValueError("Empty search query.")
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


def issns_from_scopus_entry(entry: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for k in ("prism:issn", "prism:eIssn"):
        raw = entry.get(k)
        if not raw:
            continue
        norm = normalize_issn_key(str(raw).strip())
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def fetch_page(
    session: requests.Session,
    api_key: str,
    *,
    query: str,
    start: int,
    count: int,
    sort: str,
    view: str,
    inst_token: str | None = None,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "X-ELS-APIKey": api_key,
    }
    inst = (
        (inst_token or "").strip()
        if inst_token is not None
        else (os.environ.get("SCOPUS_INSTTOKEN") or "").strip()
    )
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
    inst_token: str | None = None,
) -> list[dict[str, Any]]:
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
            inst_token=inst_token,
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


def distinct_pranker_venues_from_works(
    works: list[dict[str, Any]], *, max_venues: int
) -> list[dict[str, Any]]:
    """Shape expected by venues.js OpenAlex path: name, issns, citedBy."""
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
                "name": name,
                "issns": issns_from_scopus_entry(w),
                "citedBy": citedby(w),
                "aggregation_type": aggregation_type(w) or "—",
                "scopus_id": scopus_id(w),
            }
        )
        if len(out) >= max_venues:
            break
    return out


def run_literature_search(
    api_key: str,
    *,
    user_keywords: str | None = None,
    query_expr: str | None = None,
    inst_token: str | None = None,
    top_works: int = 30,
    top_venues: int = 30,
    page_size: int = 200,
    sort: str = "-citedby-count",
    view: str = "STANDARD",
    journals_only: bool = False,
    max_start: int = 4999,
    max_pages: int = 30,
    sleep_s: float = DEFAULT_SLEEP_S,
) -> dict[str, Any]:
    """Return JSON-serializable payload for P Ranker ``venues.js``."""
    if query_expr and query_expr.strip():
        query = query_expr.strip()
    elif user_keywords and user_keywords.strip():
        query = build_default_query(user_keywords.strip())
    else:
        raise ValueError("Provide user_keywords or query_expr.")

    session = requests.Session()
    session.headers.setdefault("User-Agent", "pranker-scopus-literature/1.1 (proxy or CLI)")

    works = collect_works(
        session,
        api_key,
        query=query,
        target_works=top_works,
        page_size=min(page_size, MAX_PAGE),
        sort=sort,
        view=view,
        journals_only=journals_only,
        max_start=max_start,
        max_pages=max_pages,
        sleep_s=sleep_s,
        inst_token=inst_token,
    )
    venues = distinct_pranker_venues_from_works(works, max_venues=top_venues)
    return {
        "source": "scopus",
        "query_used": query,
        "works": [{"cited_by_count": citedby(w)} for w in works],
        "venues": venues,
    }
