/* =============================================
   P Ranker — Application Logic
   ============================================= */

(function () {
  "use strict";

  // ---- Configuration ----

  const CROSSREF_API = "https://api.crossref.org/works/";
  const CROSSREF_MAILTO = "pranker-tool@users.noreply.github.com";
  const MAX_CONCURRENT = 5;
  const REQUEST_TIMEOUT = 15000;
  const ABSTRACT_CLIP_LENGTH = 180;

  // ---- State ----

  let scimagoData = null;
  let coreData = null;
  let results = [];
  let metadataResults = [];
  let sortCol = null;
  let sortDir = "asc";

  // ---- DOM references ----

  const doiInput = document.getElementById("doi-input");
  const csvFileInput = document.getElementById("csv-file");
  const fileDropZone = document.getElementById("file-drop-zone");
  const fileNameDisplay = document.getElementById("file-name");
  const browseBtn = document.getElementById("browse-btn");
  const rankBtn = document.getElementById("rank-btn");
  const metadataBtn = document.getElementById("metadata-btn");
  const clearBtn = document.getElementById("clear-btn");
  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const resultsSection = document.getElementById("results-section");
  const resultCount = document.getElementById("result-count");
  const resultsBody = document.getElementById("results-body");
  const exportBtn = document.getElementById("export-btn");
  const metadataSection = document.getElementById("metadata-section");
  const metadataCount = document.getElementById("metadata-count");
  const metadataBody = document.getElementById("metadata-body");
  const metadataExportBtn = document.getElementById("metadata-export-btn");
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  // ---- Initialization ----

  async function init() {
    setupEventListeners();
    updateRankBtnState();
    await loadRankingData();
  }

  async function loadRankingData() {
    try {
      const [scimagoResp, coreResp] = await Promise.all([
        fetch("data/scimago.json"),
        fetch("data/core.json"),
      ]);

      if (scimagoResp.ok) {
        scimagoData = await scimagoResp.json();
        console.log(
          `Loaded SCImago data: ${Object.keys(scimagoData.by_issn || {}).length} ISSNs`
        );
      } else {
        console.warn("SCImago data not available — journal rankings will show as Not Ranked");
      }

      if (coreResp.ok) {
        coreData = await coreResp.json();
        console.log(
          `Loaded CORE data: ${Object.keys(coreData.by_acronym || {}).length} conferences`
        );
      } else {
        console.warn("CORE data not available — conference rankings will show as Not Ranked");
      }
    } catch (err) {
      console.warn("Failed to load ranking data:", err);
    }
  }

  // ---- Event Listeners ----

  function setupEventListeners() {
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    doiInput.addEventListener("input", updateRankBtnState);

    browseBtn.addEventListener("click", () => csvFileInput.click());
    csvFileInput.addEventListener("change", handleFileSelect);

    fileDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      fileDropZone.classList.add("dragover");
    });
    fileDropZone.addEventListener("dragleave", () => {
      fileDropZone.classList.remove("dragover");
    });
    fileDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      fileDropZone.classList.remove("dragover");
      if (e.dataTransfer.files.length) {
        csvFileInput.files = e.dataTransfer.files;
        handleFileSelect();
      }
    });

    rankBtn.addEventListener("click", handleRank);
    metadataBtn.addEventListener("click", handleMetadataSheet);
    clearBtn.addEventListener("click", handleClear);
    exportBtn.addEventListener("click", handleExport);
    metadataExportBtn.addEventListener("click", handleMetadataExport);
    metadataBody.addEventListener("click", onSeeMoreClick);
    resultsBody.addEventListener("click", onSeeMoreClick);

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => handleSort(th.dataset.col));
    });
  }

  // ---- Tab Switching ----

  function switchTab(tab) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    tabContents.forEach((c) =>
      c.classList.toggle("active", c.id === `tab-${tab}`)
    );
    updateRankBtnState();
  }

  // ---- File Handling ----

  function handleFileSelect() {
    const file = csvFileInput.files[0];
    if (file) {
      fileNameDisplay.textContent = file.name;
      updateRankBtnState();
    }
  }

  function updateRankBtnState() {
    const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
    let hasRankInput = false;
    let hasDoiForMetadata = false;
    if (activeTab === "text") {
      const items = parseItemsFromText(doiInput.value);
      hasRankInput = items.length > 0;
      hasDoiForMetadata = items.some((x) => x.kind === "doi");
    } else {
      hasRankInput = csvFileInput.files.length > 0;
      hasDoiForMetadata = csvFileInput.files.length > 0;
    }
    rankBtn.disabled = !hasRankInput;
    metadataBtn.disabled = !hasDoiForMetadata;
  }

  // ---- DOI Parsing ----

  function extractDOI(input) {
    input = input.trim();
    if (!input) return null;

    const urlPatterns = [
      /(?:https?:\/\/)?(?:dx\.)?doi\.org\/(.+)/i,
      /(?:https?:\/\/)?(?:www\.)?doi\.org\/(.+)/i,
    ];
    for (const pattern of urlPatterns) {
      const match = input.match(pattern);
      if (match) return match[1].trim();
    }

    if (/^10\.\d{4,}\/\S+$/.test(input)) return input;

    return null;
  }

  function parseDOIsFromText(text) {
    return parseItemsFromText(text)
      .filter((x) => x.kind === "doi")
      .map((x) => x.value);
  }

  /** @returns {{ kind: 'doi'|'venue', value: string }[]} */
  function parseItemsFromText(text) {
    const items = [];
    const seenDoi = new Set();
    const seenVenue = new Set();
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const chunks = line.split(/[,;|]+/).map((c) => c.trim()).filter(Boolean);
      const parts = chunks.length ? chunks : [];
      if (!parts.length) continue;
      for (const part of parts) {
        const doi = extractDOI(part);
        if (doi) {
          if (!seenDoi.has(doi)) {
            seenDoi.add(doi);
            items.push({ kind: "doi", value: doi });
          }
        } else {
          const key = normalizeTitle(part);
          if (key && !seenVenue.has(key)) {
            seenVenue.add(key);
            items.push({ kind: "venue", value: part });
          }
        }
      }
    }
    return items;
  }

  async function parseItemsFromCSV(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];

    const sep = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(sep).map((h) =>
      h.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/\s+/g, " ")
    );

    const doiIdx = headers.findIndex(
      (h) => h === "doi" || h === "dois" || h === "doi_url"
    );
    const journalIdx = headers.findIndex((h) =>
      [
        "journal",
        "journal_name",
        "journal name",
        "venue",
        "publication",
        "source",
        "container",
        "container_title",
      ].includes(h)
      || (h.length > 2 && h.includes("journal"))
    );

    const items = [];
    const seenDoi = new Set();
    const seenVenue = new Set();

    if (doiIdx >= 0 || journalIdx >= 0) {
      for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        const cols = raw.split(sep).map((c) => {
          let s = c.trim();
          if (
            (s.startsWith('"') && s.endsWith('"')) ||
            (s.startsWith("'") && s.endsWith("'"))
          ) {
            s = s.slice(1, -1);
          }
          return s.trim();
        });

        if (doiIdx >= 0 && cols[doiIdx]) {
          const doi = extractDOI(cols[doiIdx]);
          if (doi && !seenDoi.has(doi)) {
            seenDoi.add(doi);
            items.push({ kind: "doi", value: doi });
          }
        }

        if (journalIdx >= 0 && cols[journalIdx]) {
          const name = cols[journalIdx];
          if (!extractDOI(name)) {
            const key = normalizeTitle(name);
            if (key && !seenVenue.has(key)) {
              seenVenue.add(key);
              items.push({ kind: "venue", value: name });
            }
          }
        }
      }
      return items;
    }

    for (let i = 0; i < lines.length; i++) {
      const doi = extractDOI(lines[i].replace(/["']/g, "").trim());
      if (doi && !seenDoi.has(doi)) {
        seenDoi.add(doi);
        items.push({ kind: "doi", value: doi });
      }
    }
    return items;
  }

    const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
    if (activeTab === "text") {
      return parseItemsFromText(doiInput.value);
    }
    const file = csvFileInput.files[0];
    if (!file) return [];
    return parseItemsFromCSV(file);
  }

  // ---- CrossRef API ----

  async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  function stripJats(raw) {
    if (!raw) return "";
    return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  function yearFromWork(work) {
    const dp = (src) => src && src["date-parts"] && src["date-parts"][0];
    const y =
      (dp(work["published-print"]) || [])[0] ||
      (dp(work["published-online"]) || [])[0] ||
      (dp(work.created) || [])[0];
    return y != null ? y : "";
  }

  function buildPaperFromVenueName(name) {
    const s = name.trim();
    return {
      doi: "",
      title: "—",
      source: s,
      issn: [],
      type: "listed-name",
      authors: "",
      abstract: "",
      year: "",
      publisher: "",
      citations: 0,
    };
  }

  async function fetchWorkByDoi(doi) {
    const url = `${CROSSREF_API}${encodeURIComponent(doi)}?mailto=${CROSSREF_MAILTO}`;
    try {
      const resp = await fetchWithTimeout(url, REQUEST_TIMEOUT);
      if (!resp.ok) {
        return { doi, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      const work = data.message;
      return {
        doi,
        title: (work.title && work.title[0]) || "Unknown Title",
        source: (work["container-title"] && work["container-title"][0]) || "",
        issn: work.ISSN || [],
        type: work.type || "",
        authors: (work.author || [])
          .map((a) => [a.given, a.family].filter(Boolean).join(" "))
          .slice(0, 3)
          .join(", "),
        abstract: stripJats(work.abstract || ""),
        year: yearFromWork(work),
        publisher: work.publisher || work["publisher-name"] || "",
        citations: typeof work["is-referenced-by-count"] === "number"
          ? work["is-referenced-by-count"]
          : (Number(work["is-referenced-by-count"]) || 0),
      };
    } catch (err) {
      if (err.name === "AbortError") {
        return { doi, error: "Timeout" };
      }
      return { doi, error: err.message };
    }
  }

  // ---- Concurrency Limiter ----

  async function runWithConcurrency(tasks, limit) {
    const results = [];
    let idx = 0;

    async function worker() {
      while (idx < tasks.length) {
        const currentIdx = idx++;
        results[currentIdx] = await tasks[currentIdx]();
      }
    }

    const workers = Array.from(
      { length: Math.min(limit, tasks.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }

  // ---- Ranking Lookup ----

  function normalizeTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeIssnKey(issn) {
    if (!issn) return "";
    let s = String(issn).toUpperCase().trim().replace(/[^\dX-]/g, "");
    if (/^\d{8}$/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4)}`;
    }
    return s;
  }

  function venueTitleVariants(name) {
    const s = String(name || "").trim();
    if (!s) return [];
    const n = normalizeTitle(s);
    const stripped = normalizeTitle(s.replace(/^the\s+/i, ""));
    return n === stripped ? [n] : [...new Set([n, stripped].filter(Boolean))];
  }

  function lookupJournalRanking(issns, sourceName) {
    if (!scimagoData) return { ranking: "Not Ranked", system: "SCImago" };

    for (const issn of issns) {
      const normalized = normalizeIssnKey(issn);
      const entry =
        scimagoData.by_issn[normalized] ||
        scimagoData.by_issn[issn.toUpperCase().trim()];
      if (entry) {
        return {
          ranking: entry.q === "-" ? "Not Ranked" : entry.q,
          system: "SCImago",
          matchedTitle: entry.t,
        };
      }
    }

    if (sourceName) {
      for (const norm of venueTitleVariants(sourceName)) {
        const entry = scimagoData.by_title[norm];
        if (entry) {
          return {
            ranking: entry.q === "-" ? "Not Ranked" : entry.q,
            system: "SCImago",
          };
        }
      }
    }

    return { ranking: "Not Ranked", system: "SCImago" };
  }

  function lookupConferenceRanking(sourceName) {
    if (!coreData || !sourceName) {
      return { ranking: "Not Ranked", system: "CORE" };
    }

    const sourceUpper = sourceName.toUpperCase().trim();
    const acronymEntry = coreData.by_acronym[sourceUpper];
    if (acronymEntry) {
      return {
        ranking: acronymEntry.r,
        system: "CORE",
        matchedTitle: acronymEntry.t,
      };
    }

    for (const norm of venueTitleVariants(sourceName)) {
      const titleEntry = coreData.by_title[norm];
      if (titleEntry) {
        return {
          ranking: titleEntry.r,
          system: "CORE",
          matchedAcronym: titleEntry.a,
        };
      }
    }

    const norm = normalizeTitle(sourceName);
    for (const [acronym, entry] of Object.entries(coreData.by_acronym)) {
      if (
        norm.includes(acronym.toLowerCase()) ||
        normalizeTitle(entry.t).includes(norm) ||
        norm.includes(normalizeTitle(entry.t))
      ) {
        return {
          ranking: entry.r,
          system: "CORE",
          matchedTitle: entry.t,
        };
      }
    }

    return { ranking: "Not Ranked", system: "CORE" };
  }

  function determineRanking(paper) {
    if (paper.error) {
      return {
        ranking: "Error",
        system: "-",
        detail: paper.error,
      };
    }

    const type = paper.type || "";
    const isConference =
      type.includes("proceedings") || type.includes("conference");
    const isJournal = type.includes("journal");

    if (isJournal) {
      return lookupJournalRanking(paper.issn, paper.source);
    }

    if (isConference) {
      const result = lookupConferenceRanking(paper.source);
      if (result.ranking !== "Not Ranked") return result;
      return lookupJournalRanking(paper.issn, paper.source);
    }

    const journalResult = lookupJournalRanking(paper.issn, paper.source);
    if (journalResult.ranking !== "Not Ranked") return journalResult;

    const confResult = lookupConferenceRanking(paper.source);
    if (confResult.ranking !== "Not Ranked") return confResult;

    return { ranking: "Not Ranked", system: "-" };
  }

  // ---- Main Flow ----

  async function handleRank() {
    const items = await getItemsFromActiveTab();
    if (!items.length) {
      alert("No DOIs or venue names found. Paste one per line or upload a CSV.");
      return;
    }

    rankBtn.disabled = true;
    metadataBtn.disabled = true;
    progressSection.hidden = false;
    resultsSection.hidden = true;
    results = [];

    let completed = 0;
    const total = items.length;

    const tasks = items.map((item) => async () => {
      let paper;
      if (item.kind === "doi") {
        paper = await fetchWorkByDoi(item.value);
      } else {
        paper = buildPaperFromVenueName(item.value);
      }
      const ranking = determineRanking(paper);
      completed++;
      setProgress(completed, total, "Looking up rankings");
      return { ...paper, ...ranking };
    });

    results = await runWithConcurrency(tasks, MAX_CONCURRENT);

    progressSection.hidden = true;
    resultsSection.hidden = false;
    resultCount.textContent = `(${results.length} papers)`;
    sortCol = null;
    renderTable();
    rankBtn.disabled = false;
    metadataBtn.disabled = false;
    updateRankBtnState();
  }

  async function handleMetadataSheet() {
    const items = await getItemsFromActiveTab();
    const dois = items.filter((x) => x.kind === "doi").map((x) => x.value);
    const uniqueDois = [...new Set(dois)];
    if (!uniqueDois.length) {
      alert(
        "Download Abstracts needs at least one DOI. Journal-name-only rows are skipped for this export."
      );
      return;
    }

    rankBtn.disabled = true;
    metadataBtn.disabled = true;
    progressSection.hidden = false;
    metadataSection.hidden = true;
    metadataResults = [];

    let completed = 0;
    const total = uniqueDois.length;

    const tasks = uniqueDois.map((doi) => async () => {
      const paper = await fetchWorkByDoi(doi);
      const ranking = determineRanking(paper);
      completed++;
      setProgress(completed, total, "Fetching metadata");
      return { ...paper, ...ranking };
    });

    metadataResults = await runWithConcurrency(tasks, MAX_CONCURRENT);

    progressSection.hidden = true;
    metadataSection.hidden = false;
    metadataCount.textContent = `(${metadataResults.length} papers)`;
    renderMetadataTable();
    rankBtn.disabled = false;
    metadataBtn.disabled = false;
    updateRankBtnState();
  }

  function setProgress(done, total, label) {
    const pct = Math.round((done / total) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `${label}… ${done}/${total}`;
  }

  // ---- Rendering ----

  function getBadgeClass(ranking) {
    const map = {
      Q1: "badge-q1",
      Q2: "badge-q2",
      Q3: "badge-q3",
      Q4: "badge-q4",
      "A*": "badge-a-star",
      A: "badge-a",
      B: "badge-b",
      C: "badge-c",
      Error: "badge-error",
      "Not Ranked": "badge-nr",
    };
    return map[ranking] || "badge-nr";
  }

  function getTypeLabel(type) {
    if (!type) return "-";
    if (type === "listed-name") return "Listed name";
    if (type.includes("journal")) return "Journal";
    if (type.includes("proceedings") || type.includes("conference"))
      return "Conference";
    if (type.includes("book")) return "Book";
    return type.replace(/-/g, " ");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderTable() {
    resultsBody.innerHTML = "";
    results.forEach((r, i) => {
      const tr = document.createElement("tr");
      const doiHtml = r.doi
        ? (() => {
            const doiLink = `https://doi.org/${encodeURIComponent(r.doi)}`;
            return `<td class="doi-cell"><a href="${doiLink}" target="_blank" rel="noopener">${escapeHtml(r.doi)}</a></td>`;
          })()
        : `<td class="doi-cell"><span style="color:var(--color-text-muted)">—</span></td>`;
      const displayRanking = r.ranking || "Not Ranked";
      const systemLabel = r.system && r.system !== "-" ? ` (${r.system})` : "";

      const titleForCell =
        r.type === "listed-name"
          ? r.source || "—"
          : r.title || r.doi || "—";
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${clampHtml(titleForCell, ABSTRACT_CLIP_LENGTH)}</td>
        <td>${escapeHtml(r.source || "-")}</td>
        <td>${getTypeLabel(r.type)}</td>
        <td><span class="badge ${getBadgeClass(displayRanking)}">${escapeHtml(displayRanking)}</span>${systemLabel}</td>
        ${doiHtml}
      `;
      resultsBody.appendChild(tr);
    });
  }

  function renderMetadataTable() {
    metadataBody.innerHTML = "";
    metadataResults.forEach((r, i) => {
      const tr = document.createElement("tr");
      const doiLink = `https://doi.org/${encodeURIComponent(r.doi)}`;
      const displayRanking = r.ranking || "Not Ranked";
      const systemLabel = r.system && r.system !== "-" ? ` (${r.system})` : "";
      const abstract = r.abstract || "";
      const yearStr = r.year !== "" && r.year != null ? String(r.year) : "—";
      const pubStr = (r.publisher || r.source || "—");
      const citeStr = typeof r.citations === "number" ? String(r.citations) : "—";

      const abstractHtml = abstract
        ? clampHtml(abstract, ABSTRACT_CLIP_LENGTH)
        : `<em style="color:var(--color-text-muted)">No abstract available</em>`;

      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${clampHtml(r.title || r.doi, ABSTRACT_CLIP_LENGTH)}</td>
        <td class="abstract-cell">${abstractHtml}</td>
        <td>${escapeHtml(yearStr)}</td>
        <td>${escapeHtml(pubStr)}</td>
        <td><span class="badge ${getBadgeClass(displayRanking)}">${escapeHtml(displayRanking)}</span>${systemLabel}</td>
        <td>${escapeHtml(citeStr)}</td>
        <td class="doi-cell"><a href="${doiLink}" target="_blank" rel="noopener">${escapeHtml(r.doi)}</a></td>
      `;
      metadataBody.appendChild(tr);
    });
  }

  function onSeeMoreClick(e) {
    const btn = e.target.closest(".see-more-btn");
    if (!btn) return;
    const wrap = btn.closest(".clamp-wrap");
    const textEl = wrap.querySelector(".clamp-text");
    const expanded = textEl.classList.toggle("is-expanded");
    btn.textContent = expanded ? "see less" : "see more";
  }

  function clampHtml(text, threshold) {
    if (!text) return "";
    const needs = text.length > threshold;
    return `<div class="clamp-wrap">
      <div class="clamp-text${needs ? "" : " is-expanded"}">${escapeHtml(text)}</div>
      ${needs ? '<button type="button" class="see-more-btn">see more</button>' : ""}
    </div>`;
  }

  // ---- Sorting ----

  function handleSort(col) {
    if (sortCol === col) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortCol = col;
      sortDir = "asc";
    }

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.col === col) {
        th.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
      }
    });

    const rankOrder = {
      Q1: 1, "A*": 1,
      Q2: 2, A: 2,
      Q3: 3, B: 3,
      Q4: 4, C: 4,
      "Not Ranked": 5,
      Error: 6,
    };

    results.sort((a, b) => {
      let va, vb;
      switch (col) {
        case "idx":
          return 0;
        case "title":
          va = (a.title || "").toLowerCase();
          vb = (b.title || "").toLowerCase();
          break;
        case "source":
          va = (a.source || "").toLowerCase();
          vb = (b.source || "").toLowerCase();
          break;
        case "type":
          va = a.type || "";
          vb = b.type || "";
          break;
        case "ranking":
          va = rankOrder[a.ranking] || 99;
          vb = rankOrder[b.ranking] || 99;
          return sortDir === "asc" ? va - vb : vb - va;
        default:
          return 0;
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });

    renderTable();
  }

  // ---- Export ----

  function handleExport() {
    if (!results.length) return;

    const BOM = "\uFEFF";
    const headers = ["#", "Title", "Source", "Type", "Ranking", "System", "DOI"];
    const rows = results.map((r, i) => [
      i + 1,
      csvCell(r.title || ""),
      csvCell(r.source || ""),
      getTypeLabel(r.type),
      r.ranking || "Not Ranked",
      r.system || "-",
      csvCell(r.doi),
    ].join(","));

    const csv = BOM + [headers.join(","), ...rows].join("\n");
    triggerDownload(csv, `pranker-results-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function handleMetadataExport() {
    if (!metadataResults.length) return;

    const BOM = "\uFEFF";
    const headers = ["Title", "Abstract", "Year", "Publisher", "Ranking", "Citations", "DOI"];
    const rows = metadataResults.map((r) => {
      const rankStr = (r.ranking || "Not Ranked") +
        (r.system && r.system !== "-" ? ` (${r.system})` : "");
      return [
        csvCell(r.title || ""),
        csvCell(r.abstract || ""),
        r.year !== "" && r.year != null ? r.year : "",
        csvCell(r.publisher || r.source || ""),
        csvCell(rankStr),
        typeof r.citations === "number" ? r.citations : "",
        csvCell(r.doi),
      ].join(",");
    });

    const csv = BOM + [headers.join(","), ...rows].join("\n");
    triggerDownload(csv, `abstracts-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function csvCell(val) {
    return `"${String(val ?? "").replace(/"/g, '""')}"`;
  }

  function triggerDownload(content, filename) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Clear ----

  function handleClear() {
    doiInput.value = "";
    csvFileInput.value = "";
    fileNameDisplay.textContent = "";
    progressSection.hidden = true;
    resultsSection.hidden = true;
    metadataSection.hidden = true;
    results = [];
    metadataResults = [];
    resultsBody.innerHTML = "";
    metadataBody.innerHTML = "";
    updateRankBtnState();
  }

  // ---- Boot ----

  init();
})();
