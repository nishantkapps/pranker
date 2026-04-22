/* venues_v2.js — Find Venues (v2, data-folder only)
 *
 * Loads only static files under data/:
 *   • data/conf_urls_cache.json — conference URLs
 *   • data/conf_desc_cache.json — conference blurbs (search + optional date phrases)
 *   • data/conference_deadlines.json — bundled schedule rows (acronym, start/end, place)
 *   • data/scimago.json — journal title + quartile; link is SCImago search (no DBLP/CORE URLs)
 *
 * No live scraping and no third-party reader APIs — only same-origin fetch() to data/*.json.
 *
 * Typical date column: prefers conference_deadlines.json (month/day projected to current year);
 * else parses dates in conf_desc_cache text (prior-year mention → same slot, current year).
 *
 * Pair with venues.html by swapping the script src to js/venues_v2.js.
 */

(function () {
  "use strict";

  const CONF_URLS_URL = "data/conf_urls_cache.json";
  const CONF_DESC_URL = "data/conf_desc_cache.json";
  const CONFERENCE_DEADLINES_URL = "data/conference_deadlines.json";
  const SCIMAGO_URL = "data/scimago.json";

  const MAX_RESULTS = 150;
  const MIN_KW_LEN = 2;

  const STOP = new Set([
    "the", "and", "for", "with", "from", "that", "this", "are", "was", "its", "has", "not",
    "but", "all", "can", "will", "may", "such", "on", "in", "of", "to", "a", "an", "at", "by",
    "or", "via", "international", "national", "conference", "workshop", "symposium", "journal",
    "transactions", "letters", "ieee", "acm", "annual", "meeting",
  ]);

  const MONTH_LONG = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const MONTH_SHORT = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };

  const now = new Date();
  const CURRENT_YEAR = now.getFullYear();
  const PREV_YEAR = CURRENT_YEAR - 1;

  let scimagoByIssn = Object.create(null);
  /** @type {Record<string, { url: string, source?: string }>} */
  let confUrlRecords = Object.create(null);
  /** @type {Record<string, string>} */
  let confDescriptions = Object.create(null);
  /** @type {Map<string, Record<string, unknown>>} */
  let deadlineByAcronym = new Map();

  let dataReady = false;
  let lastExportRows = [];

  const topicInput = document.getElementById("topic-input");
  const findBtn = document.getElementById("find-btn");
  const clearBtn = document.getElementById("venues-clear-btn");
  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const venuesSection = document.getElementById("venues-section");
  const venuesCount = document.getElementById("venues-count");
  const venuesBody = document.getElementById("venues-body");
  const venuesExportBtn = document.getElementById("venues-export-btn");
  const searchHint = document.getElementById("search-hint");

  function normalizeKey(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function keywordTokens(query) {
    const raw = normalizeKey(query).split(" ").filter((w) => w.length >= MIN_KW_LEN);
    return [...new Set(raw)].filter((w) => !STOP.has(w));
  }

  function tokenizeHaystack(text) {
    const set = new Set();
    for (const w of normalizeKey(text).split(" ")) {
      if (w.length < MIN_KW_LEN || STOP.has(w)) continue;
      set.add(w);
    }
    return set;
  }

  function scoreKeywordsAgainst(terms, haystackText) {
    if (!terms.length) return 0;
    const bag = tokenizeHaystack(haystackText);
    let hits = 0;
    for (const t of terms) {
      if (bag.has(t)) hits++;
      else {
        for (const h of bag) {
          if (h.length >= 5 && (h.startsWith(t) || t.startsWith(h))) {
            hits++;
            break;
          }
        }
      }
    }
    return hits;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function journalScimagoUrl(issn, title) {
    const q = issn || title;
    return `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(q)}`;
  }

  // ---- Deadline bundle (local JSON) ----

  function coerceDeadlineArray(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw.entries;
    return [];
  }

  /** Strip trailing bracket qualifiers, e.g. "NeurIPS [Track]" → "NeurIPS". */
  function deadlineAcronymKey(title) {
    return String(title || "")
      .replace(/\s*\[[^\]]*]\s*/g, "")
      .trim()
      .toUpperCase();
  }

  function parseIsoDate(s) {
    if (!s || typeof s !== "string" || s.length < 10) return null;
    const d = new Date(s.slice(0, 10) + "T12:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function buildDeadlineIndex(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const key = deadlineAcronymKey(e.title || e.name || "");
      if (!key) continue;
      const start = String(e.start || "").slice(0, 10);
      const prev = map.get(key);
      const prevStart = prev ? String(prev.start || "").slice(0, 10) : "";
      if (!prev || (start && start > prevStart)) map.set(key, e);
    }
    return map;
  }

  // ---- Date extraction from free text (descriptions) ----

  /**
   * @returns {{ y: number, m: number, d0?: number, d1?: number }[]}
   */
  function extractDateCandidates(text) {
    const out = [];
    const t = String(text || "");
    let m;

    const rxRangeLong =
      /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|–|—)\s*(\d{1,2})(?:st|nd|rd|th)?,?\s+([a-z]+)\s*,?\s*(\d{4})\b/gi;
    while ((m = rxRangeLong.exec(t)) !== null) {
      const d0 = +m[1];
      const d1 = +m[2];
      const mo = MONTH_LONG[m[3].toLowerCase()];
      const y = +m[4];
      if (mo && y >= 1990 && y <= 2100) out.push({ y, m: mo, d0, d1 });
    }

    const rxFromTo =
      /\bfrom\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi;
    while ((m = rxFromTo.exec(t)) !== null) {
      const mo = MONTH_LONG[m[1].toLowerCase()];
      const d0 = +m[2];
      const d1 = +m[3];
      const y = +m[4];
      if (mo && y >= 1990 && y <= 2100) out.push({ y, m: mo, d0, d1 });
    }

    const rxMonthDayYear =
      /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|–|—)\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi;
    while ((m = rxMonthDayYear.exec(t)) !== null) {
      const mon = m[1].toLowerCase();
      const mo = MONTH_LONG[mon] || MONTH_SHORT[mon.slice(0, 3)];
      const d0 = +m[2];
      const d1 = +m[3];
      const y = +m[4];
      if (mo && y >= 1990 && y <= 2100) out.push({ y, m: mo, d0, d1 });
    }

    const rxSimple = /\b([a-z]{3,9})\s+(\d{4})\b/gi;
    while ((m = rxSimple.exec(t)) !== null) {
      const mon = m[1].toLowerCase();
      const mo = MONTH_LONG[mon] || MONTH_SHORT[mon.slice(0, 3)];
      const y = +m[2];
      if (mo && y >= 1990 && y <= 2100) out.push({ y, m: mo });
    }

    const rxIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((m = rxIso.exec(t)) !== null) {
      const y = +m[1];
      const mo = +m[2];
      const d0 = +m[3];
      if (y >= 1990 && mo >= 1 && mo <= 12) out.push({ y, m: mo, d0, d1: d0 });
    }

    return out;
  }

  function monthName(month) {
    return [
      "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][month];
  }

  function pickPrevYearSpan(candidates) {
    const prev = candidates.filter((c) => c.y === PREV_YEAR);
    if (prev.length) return prev[0];
    const any = candidates.filter((c) => c.y < CURRENT_YEAR && c.y >= PREV_YEAR - 2);
    return any.length ? any[0] : null;
  }

  function projectDateLabel(span) {
    if (!span) return null;
    const mo = monthName(span.m);
    if (span.d0 != null && span.d1 != null && span.d0 !== span.d1) {
      return `${mo} ${span.d0}–${span.d1}, ${CURRENT_YEAR} (typical)`;
    }
    if (span.d0 != null) {
      return `${mo} ${span.d0}, ${CURRENT_YEAR} (typical)`;
    }
    return `${mo} ${CURRENT_YEAR} (typical)`;
  }

  function sniffLocation(text) {
    const t = String(text || "");
    const rx = /\b(?:in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}),\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
    const hit = t.match(rx);
    if (hit) return `${hit[1]}, ${hit[2]}`;
    return "";
  }

  function labelFromDeadlineEntry(entry) {
    const s = parseIsoDate(String(entry.start || ""));
    const e = parseIsoDate(String(entry.end || ""));
    if (s) {
      const month = s.getMonth() + 1;
      const d0 = s.getDate();
      let d1 = d0;
      if (e && s.getMonth() === e.getMonth()) d1 = e.getDate();
      return projectDateLabel({ m: month, d0, d1: d1 !== d0 ? d1 : undefined });
    }
    const spans = extractDateCandidates(String(entry.date || ""));
    const pick = pickPrevYearSpan(spans);
    if (pick) return projectDateLabel(pick);
    if (spans.length) {
      const latest = spans.reduce((a, b) => (a.y >= b.y ? a : b));
      return projectDateLabel(latest);
    }
    return null;
  }

  function dateFromDescription(description) {
    const spans = extractDateCandidates(description);
    const pick = pickPrevYearSpan(spans);
    if (!pick) return null;
    const label = projectDateLabel(pick);
    if (!label) return null;
    return {
      label,
      detail: pick.y === PREV_YEAR ? `from ${PREV_YEAR} in text` : `from ${pick.y} in text`,
    };
  }

  function attachConferenceFields(row) {
    const acronym = String(row.acronym || "").trim().toUpperCase();
    const description = row.description || "";
    const bundle = deadlineByAcronym.get(acronym);

    if (bundle) {
      const label = labelFromDeadlineEntry(bundle) || "—";
      const place = String(bundle.place || "").trim();
      row._dateLabel = label;
      row._dateDetail = `conference_deadlines.json · ${String(bundle.start || bundle.date || "").slice(0, 16)}`;
      row._location = place || sniffLocation(description) || "—";
      return;
    }

    const fromDesc = dateFromDescription(description);
    if (fromDesc) {
      row._dateLabel = fromDesc.label;
      row._dateDetail = `${fromDesc.detail} · conf_desc_cache`;
      row._location = sniffLocation(description) || "—";
      return;
    }

    row._dateLabel = "—";
    row._dateDetail = "no date in bundled data";
    row._location = sniffLocation(description) || "—";
  }

  function conferenceDisplayName(acronym, description) {
    const d = String(description || "").trim();
    if (!d) return acronym;
    const sentence = d.split(/[.•\n]/)[0].trim();
    if (sentence.length > 12 && sentence.length < 180) return sentence;
    return acronym;
  }

  function buildSearchCorpus() {
    const rows = [];

    for (const ac of Object.keys(confUrlRecords)) {
      const rec = confUrlRecords[ac];
      const url = (rec && rec.url) || "";
      if (!url) continue;
      const desc = confDescriptions[ac] || "";
      rows.push({
        kind: "conference",
        acronym: ac,
        name: conferenceDisplayName(ac, desc),
        rank: "—",
        description: desc,
        url,
        type: "Conference",
      });
    }

    for (const issn of Object.keys(scimagoByIssn)) {
      const e = scimagoByIssn[issn];
      const title = e.t || "";
      const q = e.q || "—";
      if (!title) continue;
      rows.push({
        kind: "journal",
        acronym: "—",
        name: title,
        rank: q,
        description: "",
        url: journalScimagoUrl(issn, title),
        type: "Journal",
        issn,
      });
    }

    return rows;
  }

  function rankMatches(rows, terms) {
    const scored = rows.map((row) => {
      let score = 0;
      const ac = row.acronym !== "—" ? row.acronym : "";
      const acu = ac.toUpperCase();

      for (const t of terms) {
        if (acu && acu === t.toUpperCase()) score += 120;
        else if (acu && acu.includes(t.toUpperCase())) score += 40;
      }

      score += scoreKeywordsAgainst(terms, row.name) * 18;
      score += scoreKeywordsAgainst(terms, row.description) * 10;
      if (row.kind === "journal") score += scoreKeywordsAgainst(terms, row.issn || "") * 25;

      return { row, score };
    });

    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.row);
  }

  function getChecked(name) {
    return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
  }

  function filterByType(rows, types) {
    const wantC = types.includes("conference");
    const wantJ = types.includes("journal");
    return rows.filter((r) => {
      if (r.kind === "conference") return wantC;
      if (r.kind === "journal") return wantJ;
      return false;
    });
  }

  function filterJournalsByQuartile(rows, allowedQ) {
    if (!allowedQ.length) return rows;
    return rows.filter((r) => {
      if (r.kind !== "journal") return true;
      return allowedQ.includes(r.rank);
    });
  }

  function setProgress(pct, label) {
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = label;
  }

  function hideLegacySections() {
    for (const id of ["deadlines-section", "ai-settings-btn", "ai-settings-panel"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const coreFilter = document.querySelector(".venue-filters .filter-group");
    if (coreFilter && coreFilter.textContent.includes("CORE")) coreFilter.hidden = true;
  }

  function updateFindEnabled() {
    if (!findBtn || !topicInput) return;
    findBtn.disabled = topicInput.value.trim().length === 0 || !dataReady;
  }

  function renderTable(conferenceRows, journalRows) {
    if (!venuesBody) return;
    venuesBody.innerHTML = "";
    const list = [...conferenceRows, ...journalRows].slice(0, MAX_RESULTS);

    if (!list.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td colspan="9" style="text-align:center;color:var(--color-text-muted);padding:1.5rem">` +
        `No matches. Try different keywords or enable both types in filters.</td>`;
      venuesBody.appendChild(tr);
      return;
    }

    list.forEach((v, i) => {
      const dateCell = v.kind === "conference" ? escapeHtml(v._dateLabel || "—") : "—";
      const dateTitle = v.kind === "conference" && v._dateDetail ? escapeHtml(v._dateDetail) : "";
      const loc = v.kind === "conference" ? escapeHtml(v._location || "") : "—";
      const desc = v.description
        ? `<span class="desc-clamp" title="${escapeHtml(v.description)}">${escapeHtml(v.description.slice(0, 140))}${v.description.length > 140 ? "…" : ""}</span>`
        : `<span style="color:var(--color-text-muted)">—</span>`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${escapeHtml(v.name)}</td>
        <td>${escapeHtml(v.acronym)}</td>
        <td>${escapeHtml(v.type)}</td>
        <td><span class="badge ${badgeClass(v.rank)}">${escapeHtml(v.rank)}</span></td>
        <td class="desc-cell">${desc}</td>
        <td title="${dateTitle}">${dateCell}</td>
        <td>${loc || "—"}</td>
        <td><a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">Website ↗</a></td>
      `;
      venuesBody.appendChild(tr);
    });
  }

  function badgeClass(rank) {
    const r = String(rank || "");
    if (r === "Q1") return "badge-q1";
    if (r === "Q2") return "badge-q2";
    if (r === "Q3") return "badge-q3";
    if (r === "Q4") return "badge-q4";
    return "badge-nr";
  }

  function exportCsv(rows) {
    const headers = ["#", "Name", "Acronym", "Type", "Ranking", "Typical date", "Location", "URL", "Date note"];
    const esc = (c) => `"${String(c).replace(/"/g, '""')}"`;
    const lines = [
      headers.join(","),
      ...rows.map((v, i) =>
        [
          i + 1,
          esc(v.name),
          esc(v.acronym),
          v.type,
          esc(v.rank),
          esc(v._dateLabel || ""),
          esc(v._location || ""),
          esc(v.url),
          esc(v._dateDetail || ""),
        ].join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `venues-v2-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function handleFind() {
    const q = topicInput.value.trim();
    if (!q || !dataReady) return;

    findBtn.disabled = true;
    if (progressSection) progressSection.hidden = false;
    setProgress(30, "Matching…");

    const terms = keywordTokens(q);
    const corpus = buildSearchCorpus();
    let matched = rankMatches(corpus, terms);
    const types = getChecked("venue-type");
    const qRanks = getChecked("scimago-rank");

    matched = filterByType(matched, types.length ? types : ["conference", "journal"]);
    matched = filterJournalsByQuartile(matched, qRanks);

    const conferences = matched.filter((r) => r.kind === "conference");
    const journals = matched.filter((r) => r.kind === "journal");

    const confLimited = conferences.slice(0, MAX_RESULTS);
    for (const row of confLimited) attachConferenceFields(row);

    setProgress(100, "Done");
    if (progressSection) progressSection.hidden = true;

    if (venuesCount) venuesCount.textContent = `(${confLimited.length + journals.length})`;
    renderTable(confLimited, journals);
    if (venuesSection) venuesSection.hidden = false;

    findBtn.disabled = false;
    updateFindEnabled();

    lastExportRows = [...confLimited, ...journals.slice(0, MAX_RESULTS)];
  }

  function handleClear() {
    topicInput.value = "";
    if (venuesSection) venuesSection.hidden = true;
    updateFindEnabled();
  }

  async function loadJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function bootstrap() {
    hideLegacySections();
    deadlineByAcronym = new Map();

    try {
      const [urls, desc, sci, deadlinesRaw] = await Promise.all([
        loadJson(CONF_URLS_URL),
        loadJson(CONF_DESC_URL),
        loadJson(SCIMAGO_URL),
        loadJson(CONFERENCE_DEADLINES_URL).catch(() => null),
      ]);

      confUrlRecords = urls && typeof urls === "object" ? urls : {};
      confDescriptions = desc && typeof desc === "object" ? desc : {};
      scimagoByIssn = (sci && sci.by_issn) || {};

      if (deadlinesRaw != null) {
        deadlineByAcronym = buildDeadlineIndex(coerceDeadlineArray(deadlinesRaw));
      }

      dataReady = true;
    } catch (e) {
      console.error("venues_v2 bootstrap failed:", e);
      dataReady = false;
      if (searchHint) {
        searchHint.textContent =
          "Could not load required data files under data/. Check that conf_urls_cache.json, conf_desc_cache.json, and scimago.json exist.";
      }
    }

    if (searchHint && dataReady) {
      searchHint.textContent =
        "v2 uses only files in data/: conf URLs + descriptions, conference_deadlines.json for dates when present, and SCImago for journals. No external page scraping.";
    }

    updateFindEnabled();
  }

  function init() {
    if (findBtn) findBtn.addEventListener("click", handleFind);
    if (clearBtn) clearBtn.addEventListener("click", handleClear);
    if (venuesExportBtn) venuesExportBtn.addEventListener("click", () => exportCsv(lastExportRows));
    if (topicInput) topicInput.addEventListener("input", updateFindEnabled);
    bootstrap();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
