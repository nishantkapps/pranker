/* =============================================
   P Ranker — Application Logic
   ============================================= */

(function () {
  "use strict";

  // ---- Configuration ----

  const CROSSREF_API = "https://api.crossref.org/works/";
  const CROSSREF_MAILTO = "pranker-tool@users.noreply.github.com";
  const MAX_CONCURRENT = 5;
  const MAX_PDF_DOIS = 100;
  const MAX_PDF_CONCURRENT = 3;
  const REQUEST_TIMEOUT = 15000;

  // ---- State ----

  let scimagoData = null;
  let coreData = null;
  let results = [];
  let sortCol = null;
  let sortDir = "asc";
  let pdfFailures = [];

  // ---- DOM references ----

  const doiInput = document.getElementById("doi-input");
  const csvFileInput = document.getElementById("csv-file");
  const fileDropZone = document.getElementById("file-drop-zone");
  const fileNameDisplay = document.getElementById("file-name");
  const browseBtn = document.getElementById("browse-btn");
  const rankBtn = document.getElementById("rank-btn");
  const clearBtn = document.getElementById("clear-btn");
  const progressSection = document.getElementById("progress-section");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const resultsSection = document.getElementById("results-section");
  const resultCount = document.getElementById("result-count");
  const resultsBody = document.getElementById("results-body");
  const exportBtn = document.getElementById("export-btn");
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");
  const pdfZipBtn = document.getElementById("pdf-zip-btn");
  const pdfSuccessBanner = document.getElementById("pdf-success-banner");
  const pdfFailuresSection = document.getElementById("pdf-failures-section");
  const pdfFailuresBody = document.getElementById("pdf-failures-body");
  const pdfFailCountLabel = document.getElementById("pdf-fail-count-label");
  const pdfFailExportBtn = document.getElementById("pdf-fail-export-btn");

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
    clearBtn.addEventListener("click", handleClear);
    exportBtn.addEventListener("click", handleExport);

    pdfZipBtn.addEventListener("click", handlePdfZipDownload);
    pdfFailExportBtn.addEventListener("click", handlePdfFailExport);

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
    let hasDois = false;
    if (activeTab === "text") {
      hasDois = parseDOIsFromText(doiInput.value).length > 0;
    } else {
      hasDois = csvFileInput.files.length > 0;
    }
    rankBtn.disabled = !hasDois;
    pdfZipBtn.disabled = !hasDois;
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
    return text
      .split(/[\n,]+/)
      .map(extractDOI)
      .filter(Boolean);
  }

  async function parseDOIsFromCSV(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    const sep = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/["']/g, ""));
    const doiIdx = headers.findIndex(
      (h) => h === "doi" || h === "dois" || h === "doi_url"
    );

    if (doiIdx === -1) {
      const allDois = [];
      for (let i = 0; i < lines.length; i++) {
        const doi = extractDOI(lines[i].replace(/["']/g, "").trim());
        if (doi) allDois.push(doi);
      }
      return allDois;
    }

    const dois = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep);
      if (cols[doiIdx]) {
        const doi = extractDOI(cols[doiIdx].replace(/["']/g, "").trim());
        if (doi) dois.push(doi);
      }
    }
    return dois;
  }

  /** Same DOI list as Rank Papers: pasted text or CSV file. */
  async function getDoisFromActiveTab() {
    const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
    if (activeTab === "text") {
      return [...new Set(parseDOIsFromText(doiInput.value))];
    }
    const file = csvFileInput.files[0];
    if (!file) return [];
    return [...new Set(await parseDOIsFromCSV(file))];
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

  async function resolveDOI(doi) {
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
        title:
          (work.title && work.title[0]) || "Unknown Title",
        source:
          (work["container-title"] && work["container-title"][0]) || "",
        issn: work.ISSN || [],
        type: work.type || "",
        authors: (work.author || [])
          .map((a) => [a.given, a.family].filter(Boolean).join(" "))
          .slice(0, 3)
          .join(", "),
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

  // ---- PDF download: Unpaywall + CrossRef + OpenAlex; fetch via direct or CORS proxies ----

  function pickBestPdfUrlFromCrossRefLinks(links) {
    if (!links || !links.length) return null;
    const candidates = [];
    for (const l of links) {
      const u = l.URL;
      if (!u || typeof u !== "string") continue;
      const ct = (l["content-type"] || "").toLowerCase();
      const isPdfMime =
        ct.includes("pdf") ||
        ct.includes("x-pdf") ||
        ct.includes("acrobat");
      const looksPdfPath = /\.pdf(\?|#|$)/i.test(u);
      if (!isPdfMime && !looksPdfPath) continue;
      let score = looksPdfPath ? 2 : 1;
      if (ct.includes("application/pdf")) score = 4;
      else if (isPdfMime) score = 3;
      candidates.push({ url: u, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].url : null;
  }

  async function resolvePdfUrlFromOpenAlex(doi) {
    try {
      const filterUrl = `https://api.openalex.org/works?filter=${encodeURIComponent(
        `doi:${doi}`
      )}&per_page=1`;
      const resp = await fetchWithTimeout(filterUrl, 20000);
      if (!resp.ok) return null;
      const data = await resp.json();
      const work = data.results && data.results[0];
      if (!work) return null;
      for (const loc of work.locations || []) {
        if (loc.pdf_url) return loc.pdf_url;
      }
      const oa = work.open_access;
      if (oa && oa.oa_url && /\.pdf(\?|#|$)/i.test(oa.oa_url)) {
        return oa.oa_url;
      }
      if (oa && oa.oa_url && oa.is_oa) {
        return oa.oa_url;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function sanitizeDoiFilename(doi) {
    let s = doi.replace(/[^a-zA-Z0-9._-]+/g, "_");
    if (s.length > 120) s = s.slice(0, 120);
    return s || "unknown";
  }

  function formatPdfError(err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg === "Failed to fetch" || err.name === "TypeError") {
      return "Download blocked (CORS/network — try the publisher site)";
    }
    return msg;
  }

  async function resolvePdfUrl(doi) {
    let uwJson = null;
    try {
      const email = encodeURIComponent(CROSSREF_MAILTO);
      const uwResp = await fetchWithTimeout(
        `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${email}`,
        25000
      );
      if (uwResp.ok) {
        uwJson = await uwResp.json();
        const best = uwJson.best_oa_location;
        if (best && best.url_for_pdf) {
          return { url: best.url_for_pdf };
        }
        for (const loc of uwJson.oa_locations || []) {
          if (loc.url_for_pdf) {
            return { url: loc.url_for_pdf };
          }
        }
      }
    } catch (_) {
      /* continue */
    }

    try {
      const crResp = await fetchWithTimeout(
        `${CROSSREF_API}${encodeURIComponent(doi)}?mailto=${CROSSREF_MAILTO}`,
        REQUEST_TIMEOUT
      );
      if (crResp.ok) {
        const data = await crResp.json();
        const links = data.message && data.message.link ? data.message.link : [];
        const crPdf = pickBestPdfUrlFromCrossRefLinks(links);
        if (crPdf) {
          return { url: crPdf };
        }
      }
    } catch (_) {
      /* ignore */
    }

    const openAlexPdf = await resolvePdfUrlFromOpenAlex(doi);
    if (openAlexPdf) {
      return { url: openAlexPdf };
    }

    if (uwJson && uwJson.is_oa === false) {
      return { error: "Not open access (Unpaywall)" };
    }
    return { error: "No PDF URL found" };
  }

  async function tryFetchPdfOnce(resourceUrl) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const resp = await fetch(resourceUrl, {
        mode: "cors",
        credentials: "omit",
        redirect: "follow",
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      if (blob.size < 400) {
        throw new Error("Response too small (not a PDF)");
      }
      return blob;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Direct fetch first; then public CORS proxies (third parties see the URL). */
  async function downloadPdfBlob(url) {
    const proxyUrls = [
      url,
      `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    ];
    let lastErr;
    for (const resourceUrl of proxyUrls) {
      try {
        return await tryFetchPdfOnce(resourceUrl);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }


  async function fetchOnePdf(doi) {
    const resolved = await resolvePdfUrl(doi);
    if (resolved.error) {
      return { doi, error: resolved.error };
    }
    try {
      const blob = await downloadPdfBlob(resolved.url);
      return { doi, blob };
    } catch (err) {
      return { doi, error: formatPdfError(err) };
    }
  }

  async function handlePdfZipDownload() {
    if (typeof JSZip === "undefined") {
      alert("JSZip failed to load. Check your network and refresh the page.");
      return;
    }

    let dois = await getDoisFromActiveTab();
    if (!dois.length) {
      alert("No valid DOIs found. Please check your input.");
      return;
    }

    if (dois.length > MAX_PDF_DOIS) {
      alert(`Only the first ${MAX_PDF_DOIS} DOIs will be processed.`);
      dois = dois.slice(0, MAX_PDF_DOIS);
    }

    rankBtn.disabled = true;
    pdfZipBtn.disabled = true;
    progressSection.hidden = false;
    pdfSuccessBanner.hidden = true;
    pdfFailuresSection.hidden = true;
    pdfFailures = [];

    const total = dois.length;
    let done = 0;

    const tasks = dois.map((doi) => async () => {
      const result = await fetchOnePdf(doi);
      done++;
      const pct = Math.round((done / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `Downloading PDFs… ${done}/${total}`;
      return result;
    });

    const outcomes = await runWithConcurrency(tasks, MAX_PDF_CONCURRENT);

    const successes = outcomes.filter((o) => o.blob);
    pdfFailures = outcomes
      .filter((o) => o.error)
      .map((o) => ({ doi: o.doi, reason: o.error }));

    progressSection.hidden = true;

    if (successes.length) {
      const zip = new JSZip();
      const usedNames = new Set();
      successes.forEach((o, i) => {
        let base = sanitizeDoiFilename(o.doi);
        let name = `${base}.pdf`;
        let n = 1;
        while (usedNames.has(name)) {
          name = `${base}_${n}.pdf`;
          n++;
        }
        usedNames.add(name);
        zip.file(name, o.blob);
      });

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pdfs-${new Date().toISOString().slice(0, 10)}-${successes.length}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      pdfSuccessBanner.textContent = `Download started: ZIP with ${successes.length} PDF${successes.length === 1 ? "" : "s"}.`;
      pdfSuccessBanner.hidden = false;
    } else {
      pdfSuccessBanner.textContent =
        "No PDFs could be downloaded. See the table below.";
      pdfSuccessBanner.hidden = false;
    }

    if (pdfFailures.length) {
      pdfFailCountLabel.textContent = `(${pdfFailures.length})`;
      pdfFailuresBody.innerHTML = "";
      pdfFailures.forEach((row, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td class="doi-cell"><a href="https://doi.org/${encodeURIComponent(row.doi)}" target="_blank" rel="noopener">${escapeHtml(row.doi)}</a></td>
          <td>${escapeHtml(row.reason)}</td>
        `;
        pdfFailuresBody.appendChild(tr);
      });
      pdfFailuresSection.hidden = false;
    }

    rankBtn.disabled = false;
    pdfZipBtn.disabled = false;
    updateRankBtnState();
  }

  function handlePdfFailExport() {
    if (!pdfFailures.length) return;
    const headers = ["#", "DOI", "Reason"];
    const rows = pdfFailures.map((r, i) => [
      i + 1,
      r.doi,
      `"${(r.reason || "").replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pdf-download-failures-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
      const norm = normalizeTitle(sourceName);
      const entry = scimagoData.by_title[norm];
      if (entry) {
        return {
          ranking: entry.q === "-" ? "Not Ranked" : entry.q,
          system: "SCImago",
        };
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

    const norm = normalizeTitle(sourceName);
    const titleEntry = coreData.by_title[norm];
    if (titleEntry) {
      return {
        ranking: titleEntry.r,
        system: "CORE",
        matchedAcronym: titleEntry.a,
      };
    }

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
    const unique = await getDoisFromActiveTab();

    if (!unique.length) {
      alert("No valid DOIs found. Please check your input.");
      return;
    }

    rankBtn.disabled = true;
    pdfZipBtn.disabled = true;
    progressSection.hidden = false;
    resultsSection.hidden = true;
    results = [];

    let completed = 0;
    const total = unique.length;

    const tasks = unique.map((doi) => async () => {
      const paper = await resolveDOI(doi);
      const ranking = determineRanking(paper);
      completed++;
      updateProgress(completed, total);
      return { ...paper, ...ranking };
    });

    results = await runWithConcurrency(tasks, MAX_CONCURRENT);

    progressSection.hidden = true;
    resultsSection.hidden = false;
    resultCount.textContent = `(${results.length} papers)`;
    sortCol = null;
    renderTable();
    rankBtn.disabled = false;
    pdfZipBtn.disabled = false;
    updateRankBtnState();
  }

  function updateProgress(done, total) {
    const pct = Math.round((done / total) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `Resolving DOIs... ${done}/${total}`;
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
      const doiLink = `https://doi.org/${encodeURIComponent(r.doi)}`;
      const displayRanking = r.ranking || "Not Ranked";
      const systemLabel = r.system && r.system !== "-" ? ` (${r.system})` : "";

      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${escapeHtml(r.title || r.doi)}</td>
        <td>${escapeHtml(r.source || "-")}</td>
        <td>${getTypeLabel(r.type)}</td>
        <td><span class="badge ${getBadgeClass(displayRanking)}">${escapeHtml(displayRanking)}</span>${systemLabel}</td>
        <td class="doi-cell"><a href="${doiLink}" target="_blank" rel="noopener">${escapeHtml(r.doi)}</a></td>
      `;
      resultsBody.appendChild(tr);
    });
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

    const headers = ["#", "DOI", "Paper Title", "Source", "Type", "Ranking", "System"];
    const rows = results.map((r, i) => [
      i + 1,
      r.doi,
      `"${(r.title || "").replace(/"/g, '""')}"`,
      `"${(r.source || "").replace(/"/g, '""')}"`,
      getTypeLabel(r.type),
      r.ranking || "Not Ranked",
      r.system || "-",
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pranker-results-${new Date().toISOString().slice(0, 10)}.csv`;
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
    results = [];
    resultsBody.innerHTML = "";
    pdfSuccessBanner.hidden = true;
    pdfFailuresSection.hidden = true;
    pdfFailures = [];
    pdfFailuresBody.innerHTML = "";
    updateRankBtnState();
  }

  // ---- Boot ----

  init();
})();
