/* =============================================
   P Ranker — Venue Discovery Logic
   ============================================= */

(function () {
  "use strict";

  // ---- Configuration ----

  const CORE_DATA_URL = "data/core.json";
  const SCIMAGO_DATA_URL = "data/scimago.json";
  const DEADLINES_YAML_URL =
    "https://raw.githubusercontent.com/paperswithcode/ai-deadlines/gh-pages/_data/conferences.yml";

  const TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);
  const CURRENT_YEAR = TODAY.getFullYear();
  const NEXT_YEAR = CURRENT_YEAR + 1;
  const MAX_VENUE_RESULTS = 200;
  const MIN_KW_LENGTH = 2;

  // Words so common in venue names they add no signal for matching
  const VENUE_STOP_WORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "are", "was",
    "its", "has", "not", "but", "all", "can", "will", "may", "such",
    "on", "in", "of", "to", "a", "an", "at", "by", "or", "via",
    "international", "national", "conference", "workshop", "symposium",
    "proceedings", "annual", "journal", "transactions", "letters",
    "ieee", "acm", "advances", "research", "studies", "science",
  ]);

  // ---- State ----

  let coreData = null;
  let scimagoData = null;
  let deadlineEntries = [];
  let venueResults = [];
  let deadlineResults = [];
  let deadlineLoadFailed = false;

  // ---- DOM references ----

  const topicInput       = document.getElementById("topic-input");
  const findBtn          = document.getElementById("find-btn");
  const clearBtn         = document.getElementById("venues-clear-btn");
  const progressSection  = document.getElementById("progress-section");
  const progressFill     = document.getElementById("progress-fill");
  const progressText     = document.getElementById("progress-text");
  const venuesSection    = document.getElementById("venues-section");
  const venuesCount      = document.getElementById("venues-count");
  const venuesBody       = document.getElementById("venues-body");
  const venuesExportBtn  = document.getElementById("venues-export-btn");
  const deadlinesSection = document.getElementById("deadlines-section");
  const deadlinesCount   = document.getElementById("deadlines-count");
  const deadlinesBody    = document.getElementById("deadlines-body");
  const deadlinesNote    = document.getElementById("deadlines-note");
  const deadlinesExportBtn = document.getElementById("deadlines-export-btn");
  const searchHint       = document.getElementById("search-hint");

  // AI settings DOM refs
  const aiSettingsBtn    = document.getElementById("ai-settings-btn");
  const aiStatusDot      = document.getElementById("ai-status-dot");
  const aiSettingsPanel  = document.getElementById("ai-settings-panel");
  const aiProviderSel    = document.getElementById("ai-provider");
  const aiCustomUrlRow   = document.getElementById("ai-custom-url-row");
  const aiModelRow       = document.getElementById("ai-model-row");
  const aiCustomUrlInput = document.getElementById("ai-custom-url");
  const aiModelInput     = document.getElementById("ai-model");
  const aiKeyInput       = document.getElementById("ai-key");
  const aiSaveBtn        = document.getElementById("ai-save-btn");
  const aiDisableBtn     = document.getElementById("ai-disable-btn");

  // ---- AI settings helpers ----

  const LS_AI = "pranker_ai";

  function loadAiSettings() {
    try { return JSON.parse(localStorage.getItem(LS_AI) || "{}"); } catch { return {}; }
  }
  function saveAiSettings(obj) {
    localStorage.setItem(LS_AI, JSON.stringify(obj));
  }

  function applyAiSettingsToUI(s) {
    aiProviderSel.value = s.provider || "groq";
    aiCustomUrlInput.value = s.customUrl || "";
    aiModelInput.value = s.model || "";
    aiKeyInput.value = s.key || "";
    toggleAiProviderFields();
  }

  function toggleAiProviderFields() {
    const p = aiProviderSel.value;
    aiCustomUrlRow.hidden = p !== "custom";
    aiModelRow.hidden = p !== "custom";
  }

  function isAiEnabled() {
    const s = loadAiSettings();
    return !!(s.enabled && s.key);
  }

  function updateAiDot() {
    const on = isAiEnabled();
    aiStatusDot.className = `ai-dot ${on ? "ai-dot-on" : "ai-dot-off"}`;
    aiSettingsBtn.title = on ? "AI search is ON — click to configure" : "Enable AI-powered search";
    searchHint.textContent = on
      ? "AI search is ON: your query is sent to the LLM to suggest relevant venues and expand keywords, then looked up locally."
      : "Keywords are matched against venue titles and acronyms in the bundled CORE and SCImago data. Upcoming submission deadlines are fetched live from aideadlin.es.";
  }

  function setupAiSettings() {
    applyAiSettingsToUI(loadAiSettings());
    updateAiDot();

    aiSettingsBtn.addEventListener("click", () => {
      aiSettingsPanel.hidden = !aiSettingsPanel.hidden;
    });
    aiProviderSel.addEventListener("change", toggleAiProviderFields);
    aiSaveBtn.addEventListener("click", () => {
      const s = {
        enabled: true,
        provider: aiProviderSel.value,
        customUrl: aiCustomUrlInput.value.trim(),
        model: aiModelInput.value.trim(),
        key: aiKeyInput.value.trim(),
      };
      if (!s.key) { alert("Please enter an API key."); return; }
      saveAiSettings(s);
      updateAiDot();
      aiSettingsPanel.hidden = true;
    });
    aiDisableBtn.addEventListener("click", () => {
      const s = loadAiSettings();
      s.enabled = false;
      saveAiSettings(s);
      updateAiDot();
      aiSettingsPanel.hidden = true;
    });
  }

  // ---- LLM call ----

  const PROVIDER_DEFAULTS = {
    groq:   { url: "https://api.groq.com/openai/v1/chat/completions",       model: "llama-3.3-70b-versatile" },
    openai: { url: "https://api.openai.com/v1/chat/completions",            model: "gpt-4o-mini" },
    gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent", model: "" },
  };

  const AI_PROMPT = (query) =>
    `You are a computer science research expert helping a researcher find relevant academic venues.

Research topic: "${query}"

List the academic conferences and journals that are directly relevant to this topic.
Respond with a single JSON object (no markdown, no explanation):
{
  "acronyms": ["ICRA", "IROS", "HRI", ...]
}

Return 5–15 real academic venue acronyms. Only include venues that are clearly and directly about this topic. Do not include tangentially related venues.`;

  async function callLlm(query) {
    const s = loadAiSettings();
    if (!s.enabled || !s.key) return null;

    const provider = s.provider || "groq";

    if (provider === "gemini") {
      return callGemini(query, s.key);
    }
    // OpenAI-compatible (groq, openai, custom)
    const defaults = PROVIDER_DEFAULTS[provider] || {};
    const url   = provider === "custom" ? s.customUrl : defaults.url;
    const model = (provider === "custom" ? s.model : "") || defaults.model;
    if (!url) throw new Error("No endpoint URL configured.");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${s.key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: AI_PROMPT(query) }],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new Error(`LLM API error ${resp.status}: ${err}`);
    }
    const data = await resp.json();
    return parseAiResponse(data.choices?.[0]?.message?.content || "");
  }

  async function callGemini(query, key) {
    const url = `${PROVIDER_DEFAULTS.gemini.url}?key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: AI_PROMPT(query) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseAiResponse(text);
  }

  function parseAiResponse(text) {
    const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]);
      return {
        acronyms: Array.isArray(obj.acronyms)
          ? obj.acronyms.map((a) => String(a).toUpperCase().trim()).filter(Boolean)
          : [],
      };
    } catch { return null; }
  }

  // ---- Init ----

  async function init() {
    setupAiSettings();
    setupEventListeners();
    // Load ranking data + deadline data in parallel; don't block the UI
    Promise.allSettled([loadRankingData(), loadDeadlineData()]).then(() => {
      updateFindBtnState();
    });
  }

  async function loadRankingData() {
    try {
      const [cr, sr] = await Promise.all([
        fetch(CORE_DATA_URL),
        fetch(SCIMAGO_DATA_URL),
      ]);
      if (cr.ok) coreData = await cr.json();
      if (sr.ok) scimagoData = await sr.json();
    } catch (e) {
      console.warn("Failed to load ranking data:", e);
    }
    updateFindBtnState();
  }

  async function loadDeadlineData() {
    try {
      const resp = await fetch(DEADLINES_YAML_URL);
      if (!resp.ok) {
        deadlineLoadFailed = true;
        return;
      }
      const text = await resp.text();
      if (typeof jsyaml === "undefined") {
        deadlineLoadFailed = true;
        console.warn("js-yaml not loaded; deadline data unavailable");
        return;
      }
      const parsed = jsyaml.load(text);
      deadlineEntries = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      deadlineLoadFailed = true;
      console.warn("Failed to load deadline data:", e);
    }
  }

  // ---- Event listeners ----

  function setupEventListeners() {
    topicInput.addEventListener("input", updateFindBtnState);
    findBtn.addEventListener("click", handleFind);
    clearBtn.addEventListener("click", handleClear);
    venuesExportBtn.addEventListener("click", handleVenuesExport);
    deadlinesExportBtn.addEventListener("click", handleDeadlinesExport);
    venuesBody.addEventListener("click", onSeeMoreClick);
    deadlinesBody.addEventListener("click", onSeeMoreClick);
  }

  function updateFindBtnState() {
    findBtn.disabled =
      topicInput.value.trim().length === 0 || (!coreData && !scimagoData);
  }

  // ---- Search engine: stemming + prefix matching ----

  /**
   * Light suffix-stripping stemmer.
   * Goal: map inflected/derived forms to a shared root so "robotics",
   * "robotic", "robots" all reduce to "robot".
   */
  function stem(w) {
    if (w.length <= 4) return w;
    // Rules are tried in order; first match wins.
    // Each rule: [regex, replacement]. Only applied when result length >= 4.
    const rules = [
      [/ications?$/, "ify"],
      [/ations?$/, "ate"],
      [/nesses?$/, ""],
      [/ments?$/, ""],
      [/ings?$/, ""],
      [/ical(ly)?$/, ""],
      [/ics?$/, ""],
      [/ities$/, ""],
      [/ity$/, ""],
      [/ious$/, ""],
      [/ous$/, ""],
      [/ive$/, ""],
      [/ize$/, ""],
      [/ise$/, ""],
      [/tions?$/, "te"],
      [/al(ly)?$/, ""],
      [/ers?$/, ""],
      [/ies$/, "y"],
      [/es$/, ""],
      [/ed$/, ""],
      [/s$/, ""],
    ];
    for (const [re, rep] of rules) {
      const m = w.match(re);
      if (m) {
        const base = w.slice(0, w.length - m[0].length) + rep;
        if (base.length >= 4) return base;
      }
    }
    return w;
  }

  /** Tokenise text, drop stop-words, return stemmed set */
  function titleTokens(text) {
    const words = ((text || "").toLowerCase().match(/[a-z]+/g) || []);
    const out = new Set();
    for (const w of words) {
      if (w.length < 2 || VENUE_STOP_WORDS.has(w)) continue;
      out.add(stem(w));
      out.add(w); // keep unstemmed form too for exact matches
    }
    return out;
  }

  /** Check whether a (stemmed) keyword matches any token in a token set */
  function kwHits(stemmedKw, tokens) {
    if (tokens.has(stemmedKw)) return true;
    // Prefix match handles cases the stemmer misses:
    // "robotics"→"robot" matches "robots" or vice-versa
    const kLen = stemmedKw.length;
    for (const t of tokens) {
      const minLen = Math.min(kLen, t.length);
      if (minLen < 5) continue;
      if (t.startsWith(stemmedKw) || stemmedKw.startsWith(t)) return true;
      // Shared-prefix fallback (≥5 chars, ≥85 % of shorter word)
      let p = 0;
      while (p < minLen && stemmedKw[p] === t[p]) p++;
      if (p >= 5 && p >= minLen * 0.85) return true;
    }
    return false;
  }

  function parseKeywords(text) {
    return [
      ...new Set(
        text
          .toLowerCase()
          .split(/[\s,;/|]+/)
          .map((w) => w.replace(/[^\w]/g, ""))
          .filter((w) => w.length >= MIN_KW_LENGTH)
      ),
    ];
  }

  /**
   * Score how well a set of keyword strings matches a list of text fields.
   * Returns the number of distinct keywords that hit at least one token.
   */
  function scoreMatch(keywords, texts) {
    const tokens = new Set(texts.flatMap((t) => [...titleTokens(t)]));
    return keywords.reduce(
      (score, kw) => score + (kwHits(stem(kw), tokens) ? 1 : 0),
      0
    );
  }

  function getChecked(name) {
    return [
      ...document.querySelectorAll(`input[name="${name}"]:checked`),
    ].map((el) => el.value);
  }

  // ---- Main handler ----

  async function handleFind() {
    const rawQuery = topicInput.value.trim();
    if (!rawQuery) return;

    const coreRanks    = getChecked("core-rank");
    const scimagoRanks = getChecked("scimago-rank");
    const types        = getChecked("venue-type");

    findBtn.disabled = true;
    progressSection.hidden = false;
    venuesSection.hidden = true;
    deadlinesSection.hidden = true;

    let aiSuggestions = null;

    if (isAiEnabled()) {
      setProgress(10, "Asking AI for relevant venues…");
      await tick();
      try {
        aiSuggestions = await callLlm(rawQuery);
      } catch (e) {
        console.warn("AI search failed, falling back to keyword search:", e);
        aiSuggestions = null;
      }
    }

    setProgress(40, "Searching venues…");
    await tick();

    const userKeywords = parseKeywords(rawQuery);
    const aiAcronyms = aiSuggestions?.acronyms || [];

    // Step 1: keyword search against local data using the user's exact query
    const kwResults = searchVenues(userKeywords, coreRanks, scimagoRanks, types, []);

    // Step 2: look up AI-suggested acronyms in local data;
    //         append only those not already found by keyword search
    const foundAcronyms = new Set(kwResults.map((v) => v.acronym.toUpperCase()));
    const aiOnlyAcronyms = aiAcronyms.filter((a) => !foundAcronyms.has(a.toUpperCase()));
    const aiExtra = aiOnlyAcronyms.length > 0
      ? searchVenues([], coreRanks, scimagoRanks, types, aiOnlyAcronyms)
      : [];

    venueResults = [...kwResults, ...aiExtra];

    setProgress(75, "Matching deadlines…");
    await tick();

    deadlineResults = matchDeadlines(venueResults, userKeywords);

    setProgress(100, "Done");
    await tick();
    progressSection.hidden = true;

    venuesCount.textContent = `(${venueResults.length})`;
    renderVenuesTable();
    venuesSection.hidden = false;

    deadlinesCount.textContent = `(${deadlineResults.length})`;
    renderDeadlinesTable();
    deadlinesSection.hidden = false;

    findBtn.disabled = false;
    updateFindBtnState();
  }

  function tick() {
    return new Promise((r) => setTimeout(r, 15));
  }

  function setProgress(pct, label) {
    progressFill.style.width = `${pct}%`;
    progressText.textContent = label;
  }

  // ---- Rank ordering ----

  const RANK_ORDER = {
    "A*": 1, A: 2, B: 3, C: 4,
    Q1: 1, Q2: 2, Q3: 3, Q4: 4,
    "-": 9,
  };

  // ---- Venue search ----

  function searchVenues(keywords, coreRanks, scimagoRanks, types, aiAcronyms = []) {
    const results = [];
    const aiAcronymSet = new Set(aiAcronyms.map((a) => a.toUpperCase()));
    // Boost score for AI-suggested venues so they sort to the top
    const AI_BOOST = 1000;

    if (types.includes("conference") && coreData) {
      for (const [acronym, entry] of Object.entries(coreData.by_acronym)) {
        if (coreRanks.length && !coreRanks.includes(entry.r)) continue;
        const kwScore   = scoreMatch(keywords, [acronym, entry.t]);
        const aiMatched = aiAcronymSet.has(acronym.toUpperCase());
        if (kwScore === 0 && !aiMatched) continue;
        const portalLink = entry.id
          ? `https://portal.core.edu.au/conf-ranks/${entry.id}/`
          : `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(acronym)}&by=acronym`;
        results.push({
          acronym,
          title: entry.t,
          ranking: entry.r,
          system: "CORE",
          type: "Conference",
          link: portalLink,
          score: kwScore + (aiMatched ? AI_BOOST : 0),
          aiSuggested: aiMatched,
        });
      }
    }

    if (types.includes("journal") && scimagoData) {
      const seen = new Set();
      for (const entry of Object.values(scimagoData.by_issn)) {
        if (!entry.t || seen.has(entry.t)) continue;
        seen.add(entry.t);
        const q = entry.q;
        if (!q || q === "-") continue;
        if (scimagoRanks.length && !scimagoRanks.includes(q)) continue;
        const score = scoreMatch(keywords, [entry.t]);
        if (score === 0) continue;
        results.push({
          acronym: "",
          title: entry.t,
          ranking: q,
          system: "SCImago",
          type: "Journal",
          link: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(entry.t)}`,
          score,
          aiSuggested: false,
        });
      }
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (RANK_ORDER[a.ranking] || 9) - (RANK_ORDER[b.ranking] || 9);
    });

    return results.slice(0, MAX_VENUE_RESULTS);
  }

  // ---- Deadline matching ----

  function normalizeForMatch(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function matchDeadlines(venueResults, keywords) {
    if (!deadlineEntries.length) return [];

    const confAcronyms = new Set(
      venueResults
        .filter((v) => v.type === "Conference")
        .map((v) => v.acronym.toUpperCase())
    );

    return deadlineEntries
      .filter((entry) => {
        // Only current and next year
        const yr = entry.year ? parseInt(entry.year) : null;
        if (yr && yr !== CURRENT_YEAR && yr !== NEXT_YEAR) return false;

        // Only future deadlines
        const dlStr = entry.deadline || entry.abstract_deadline;
        if (!dlStr) return false;
        const dl = new Date(String(dlStr).replace(" ", "T"));
        if (isNaN(dl) || dl < TODAY) return false;

        const shortName = (entry.title || entry.name || "").toUpperCase().trim();
        const fullName = entry.full_name || "";

        // Match if acronym found in our results, OR keyword matches name/full_name
        if (confAcronyms.size > 0 && confAcronyms.has(shortName)) return true;
        return scoreMatch(keywords, [shortName, fullName]) > 0;
      })
      .sort((a, b) => {
        const da = new Date(
          String(a.deadline || a.abstract_deadline || "").replace(" ", "T")
        );
        const db = new Date(
          String(b.deadline || b.abstract_deadline || "").replace(" ", "T")
        );
        return da - db;
      });
  }

  function getCoreRankForConf(shortName) {
    if (!coreData) return "";
    const entry = coreData.by_acronym[shortName.toUpperCase().trim()];
    if (entry) return entry.r;
    return entry && entry.r ? entry.r : "";
  }

  // ---- Rendering ----

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }

  function clampHtml(text, threshold) {
    if (!text) return "";
    const needs = text.length > threshold;
    return `<div class="clamp-wrap">
      <div class="clamp-text${needs ? "" : " is-expanded"}">${escapeHtml(text)}</div>
      ${needs ? '<button type="button" class="see-more-btn">see more</button>' : ""}
    </div>`;
  }

  function onSeeMoreClick(e) {
    const btn = e.target.closest(".see-more-btn");
    if (!btn) return;
    const wrap = btn.closest(".clamp-wrap");
    const textEl = wrap.querySelector(".clamp-text");
    const expanded = textEl.classList.toggle("is-expanded");
    btn.textContent = expanded ? "see less" : "see more";
  }

  function getBadgeClass(ranking) {
    const map = {
      Q1: "badge-q1", Q2: "badge-q2", Q3: "badge-q3", Q4: "badge-q4",
      "A*": "badge-a-star", A: "badge-a", B: "badge-b", C: "badge-c",
    };
    return map[ranking] || "badge-nr";
  }

  function formatDate(str) {
    if (!str) return "—";
    try {
      const d = new Date(String(str).replace(" ", "T"));
      if (isNaN(d)) return String(str);
      return d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      return String(str);
    }
  }

  function isPast(str) {
    if (!str) return false;
    try {
      return new Date(String(str).replace(" ", "T")) < TODAY;
    } catch { return false; }
  }

  /**
   * Build a map from uppercase acronym → next upcoming conference date string.
   * Uses the already-loaded deadlineEntries (aideadlin.es YAML).
   */
  function buildDateMap() {
    const map = new Map();
    for (const entry of deadlineEntries) {
      const acr = (entry.title || entry.name || "").toUpperCase().trim();
      if (!acr || !entry.date) continue;
      // entry.date is a string like "2025-06-15" or "Jun 15-19, 2025"
      // Only keep current/next year entries
      const yr = entry.year ? parseInt(entry.year) : null;
      if (yr && yr !== CURRENT_YEAR && yr !== NEXT_YEAR) continue;
      const existing = map.get(acr);
      // Prefer the soonest future date; fall back to any date
      if (!existing) {
        map.set(acr, entry.date);
      } else {
        // Keep the earlier (closer upcoming) date
        try {
          const a = new Date(String(entry.date).replace(" ", "T"));
          const b = new Date(String(existing).replace(" ", "T"));
          if (!isNaN(a) && a >= TODAY && (isNaN(b) || b < TODAY || a < b)) {
            map.set(acr, entry.date);
          }
        } catch { /* leave existing */ }
      }
    }
    return map;
  }

  function renderVenuesTable() {
    venuesBody.innerHTML = "";
    if (!venueResults.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="7" style="text-align:center;color:var(--color-text-muted);padding:1.5rem">No matching venues found. Try broader keywords or relax the ranking filters.</td>`;
      venuesBody.appendChild(tr);
      return;
    }
    const dateMap = buildDateMap();
    venueResults.forEach((v, i) => {
      const nextDate = v.type === "Conference"
        ? (dateMap.get(v.acronym.toUpperCase()) || "—")
        : "—";
      const linkCell = v.link
        ? `<a href="${escapeHtml(v.link)}" target="_blank" rel="noopener">View ↗</a>`
        : "—";
      const aiBadge = v.aiSuggested
        ? `<span class="badge-ai" title="Suggested by AI">AI</span> `
        : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${aiBadge}${clampHtml(v.title, 100)}</td>
        <td>${escapeHtml(v.acronym || "—")}</td>
        <td>${escapeHtml(v.type)}</td>
        <td>
          <span class="badge ${getBadgeClass(v.ranking)}">${escapeHtml(v.ranking)}</span>
          <span class="system-label">${escapeHtml(v.system)}</span>
        </td>
        <td>${escapeHtml(String(nextDate))}</td>
        <td>${linkCell}</td>
      `;
      venuesBody.appendChild(tr);
    });
  }

  function renderDeadlinesTable() {
    deadlinesBody.innerHTML = "";

    // Compose the note
    if (deadlineLoadFailed) {
      deadlinesNote.textContent =
        "Could not load deadline data (network error or js-yaml not available). Check your internet connection.";
      deadlinesNote.hidden = false;
    } else if (!deadlineEntries.length) {
      deadlinesNote.textContent =
        "Deadline data is still loading or unavailable. Ensure you have an internet connection.";
      deadlinesNote.hidden = false;
    } else if (!deadlineResults.length) {
      deadlinesNote.textContent =
        "No upcoming deadlines found for this topic in the deadline database. Note: coverage is primarily CS / AI / ML venues via aideadlin.es.";
      deadlinesNote.hidden = false;
    } else {
      deadlinesNote.hidden = true;
    }

    deadlineResults.forEach((d, i) => {
      const shortName = (d.title || d.name || "").trim();
      const rank = getCoreRankForConf(shortName);
      const rankCell = rank
        ? `<span class="badge ${getBadgeClass(rank)}">${escapeHtml(rank)}</span>`
        : "—";

      const abstractDl = d.abstract_deadline;
      const paperDl = d.deadline;

      const abstractCell = abstractDl
        ? `<span${isPast(abstractDl) ? ' class="dl-past"' : ""}>${formatDate(abstractDl)}</span>`
        : "—";
      const paperCell = paperDl
        ? `<span${isPast(paperDl) ? ' class="dl-past"' : ""}>${formatDate(paperDl)}</span>`
        : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${escapeHtml(shortName)}${d.full_name ? `<br><span class="venue-fullname">${escapeHtml(d.full_name)}</span>` : ""}</td>
        <td>${rankCell}</td>
        <td>${abstractCell}</td>
        <td>${paperCell}</td>
        <td>${escapeHtml(d.date || "—")}</td>
        <td>${escapeHtml(d.place || "—")}</td>
        <td>${d.link ? `<a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Website ↗</a>` : "—"}</td>
      `;
      deadlinesBody.appendChild(tr);
    });
  }

  // ---- Export ----

  function csvCell(val) {
    return `"${String(val ?? "").replace(/"/g, '""')}"`;
  }

  function triggerDownload(content, filename) {
    const BOM = "\uFEFF";
    const blob = new Blob([BOM + content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleVenuesExport() {
    if (!venueResults.length) return;
    const dateMap = buildDateMap();
    const headers = ["#", "Name", "Acronym", "Type", "Ranking", "System", "Next Date", "Link"];
    const rows = venueResults.map((v, i) => {
      const nextDate = v.type === "Conference"
        ? (dateMap.get(v.acronym.toUpperCase()) || "")
        : "";
      return [
        i + 1,
        csvCell(v.title),
        csvCell(v.acronym || ""),
        v.type,
        csvCell(v.ranking),
        v.system,
        csvCell(nextDate),
        csvCell(v.link || ""),
      ].join(",");
    });
    triggerDownload(
      [headers.join(","), ...rows].join("\n"),
      `venues-${new Date().toISOString().slice(0, 10)}.csv`
    );
  }

  function handleDeadlinesExport() {
    if (!deadlineResults.length) return;
    const headers = [
      "#", "Conference", "Full Name", "CORE Ranking",
      "Abstract Deadline", "Paper Deadline", "Conference Date", "Location", "Link",
    ];
    const rows = deadlineResults.map((d, i) => {
      const shortName = d.title || d.name || "";
      const rank = getCoreRankForConf(shortName);
      return [
        i + 1,
        csvCell(shortName),
        csvCell(d.full_name || ""),
        csvCell(rank),
        csvCell(formatDate(d.abstract_deadline)),
        csvCell(formatDate(d.deadline)),
        csvCell(d.date || ""),
        csvCell(d.place || ""),
        csvCell(d.link || ""),
      ].join(",");
    });
    triggerDownload(
      [headers.join(","), ...rows].join("\n"),
      `deadlines-${new Date().toISOString().slice(0, 10)}.csv`
    );
  }

  // ---- Clear ----

  function handleClear() {
    topicInput.value = "";
    venuesSection.hidden = true;
    deadlinesSection.hidden = true;
    venueResults = [];
    deadlineResults = [];
    venuesBody.innerHTML = "";
    deadlinesBody.innerHTML = "";
    progressSection.hidden = true;
    progressFill.style.width = "0%";
    updateFindBtnState();
  }

  // ---- Boot ----

  init();
})();
