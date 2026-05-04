/* =============================================
   P Ranker — Venue Discovery Logic
   ============================================= */

(function () {
  "use strict";

  // ---- Configuration ----

  const CORE_DATA_URL = "data/core.json";
  const SCIMAGO_DATA_URL = "data/scimago.json";
  /** Official URLs: prefer public mirror, then cache (same content after find_conf_urls.py). */
  const CONF_URLS_URLS = ["data/conf_urls.json", "data/conf_urls_cache.json"];
  /** Scraped scope text — fills gaps if core.json has no description yet. */
  const CONF_DESC_CACHE_URL = "data/conf_desc_cache.json";
  /** Bundled aideadlin.es snapshot (scripts/build_conference_deadlines.py). Same-origin = reliable. */
  const CONFERENCE_DEADLINES_JSON = "data/conference_deadlines.json";
  /** Optional live fallback if the bundle is missing. */
  const OPENALEX_WORKS_API = "https://api.openalex.org/works";
  /** Polite pool; same convention as CrossRef in this project. */
  const OPENALEX_MAILTO = "pranker-tool@users.noreply.github.com";
  const LITERATURE_TOP_N = 30;
  const OPENALEX_TIMEOUT_MS = 25000;

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
  /** Maps for conference date / location / link (rebuilt when YAML loads). */
  let confDeadlineByAcronym = null;
  let confDeadlineByNormTitle = null;
  /** Uppercase CORE acronym → official site URL (from conf_urls.json / cache). */
  let confOfficialUrlByAcronym = null;
  /** Uppercase CORE acronym → description string (from conf_desc_cache.json, fallback only). */
  let confDescFallbackByAcronym = null;
  let venueResults = [];
  let deadlineResults = [];
  let deadlineLoadFailed = false;
  /** Single flight so conf_urls / desc cache are ready before we render links (avoids DBLP+CORE when official URL exists). */
  let venueExtrasPromise = null;

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
  const literatureVenuesBtn     = document.getElementById("literature-venues-btn");
  const literatureVenuesSection = document.getElementById("literature-venues-section");
  const literatureVenuesList    = document.getElementById("literature-venues-list");
  const literatureVenuesNote    = document.getElementById("literature-venues-note");
  const literatureVenuesCount   = document.getElementById("literature-venues-count");
  const literatureVenuesCopyBtn = document.getElementById("literature-venues-copy-btn");

  /** Names from last OpenAlex venue run (for copy). */
  let literatureVenueNames = [];

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
      ? "AI search is ON: your full query is interpreted semantically — the LLM derives precise technical keywords and up to 10 venue suggestions. Local data (CORE + SCImago) is searched with those keywords, then AI extras are appended."
      : "Keywords from your query are matched against venue names and topic tags in the bundled CORE and SCImago data. Upcoming submission deadlines are fetched live from aideadlin.es.";
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
    `A researcher typed this query: "${query}"\n\n` +
    `Analyse the full meaning and return a JSON object ONLY, no explanation:\n` +
    `{"keywords":["stereo vision","visual servoing","camera calibration"],"venues":[{"acronym":"CVPR","name":"IEEE/CVF Conference on Computer Vision and Pattern Recognition"}]}\n\n` +
    `"keywords": up to 5 precise technical terms that capture the topic semantics. ` +
    `Do NOT use words from the query literally. Do NOT include generic words like system, method, approach.\n` +
    `"venues": up to 10 directly relevant conferences or journals.`;

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
    const raw = data.choices?.[0]?.message?.content || "";
    return parseAiResponse(raw);
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

      // Extract semantic keywords (new field)
      const keywords = Array.isArray(obj.keywords)
        ? obj.keywords
            .map((k) => String(k).toLowerCase().trim())
            .filter((k) => k.length >= 2)
            .slice(0, 5)
        : [];

      // Extract venue suggestions — support {venues:[{acronym,name}]} and legacy {acronyms:[]}
      let venues = [];
      if (Array.isArray(obj.venues)) {
        venues = obj.venues
          .filter((v) => v && v.acronym)
          .map((v) => ({
            acronym: String(v.acronym).toUpperCase().trim(),
            name: String(v.name || v.acronym).trim(),
          }));
      } else if (Array.isArray(obj.acronyms)) {
        venues = obj.acronyms
          .filter(Boolean)
          .map((a) => ({ acronym: String(a).toUpperCase().trim(), name: "" }));
      }

      if (!keywords.length && !venues.length) return null;
      return { keywords, venues };
    } catch { return null; }
  }

  // ---- Init ----

  async function init() {
    setupAiSettings();
    setupEventListeners();
    // Load ranking data + deadline data in parallel; don't block the UI
    Promise.allSettled([loadRankingData(), loadDeadlineData(), ensureVenueExtrasLoaded()]).then(() => {
      updateFindBtnState();
    });
  }

  function ensureVenueExtrasLoaded() {
    if (!venueExtrasPromise) venueExtrasPromise = loadVenueExtrasFromDataFiles();
    return venueExtrasPromise;
  }

  /**
   * Load URL + description caches produced by the Python data scripts.
   * These are optional: if missing or fetch fails, venue search still works from core.json only.
   */
  async function loadVenueExtrasFromDataFiles() {
    confOfficialUrlByAcronym = new Map();
    confDescFallbackByAcronym = new Map();
    try {
      let urlRaw = null;
      for (const u of CONF_URLS_URLS) {
        const urlResp = await fetch(u);
        if (urlResp.ok) {
          urlRaw = await urlResp.json();
          break;
        }
      }
      if (urlRaw && typeof urlRaw === "object") {
        for (const [key, val] of Object.entries(urlRaw)) {
          if (!val || typeof val !== "object") continue;
          const href = (val.url || "").trim();
          if (!href) continue;
          confOfficialUrlByAcronym.set(String(key).trim().toUpperCase(), href);
        }
      }

      const descResp = await fetch(CONF_DESC_CACHE_URL);
      if (descResp.ok) {
        const raw = await descResp.json();
        for (const [key, val] of Object.entries(raw)) {
          if (typeof val === "string" && val.trim()) {
            confDescFallbackByAcronym.set(String(key).trim().toUpperCase(), val.trim());
          }
        }
      }
    } catch (e) {
      console.warn("Optional venue extras (conf URLs / desc cache) not loaded:", e);
    }
  }

  function getOfficialConfUrl(acronym) {
    if (!confOfficialUrlByAcronym || !acronym) return "";
    return confOfficialUrlByAcronym.get(String(acronym).trim().toUpperCase()) || "";
  }

  function getConfDescriptionFallback(acronym) {
    if (!confDescFallbackByAcronym || !acronym) return "";
    return confDescFallbackByAcronym.get(String(acronym).trim().toUpperCase()) || "";
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
    deadlineLoadFailed = false;
    deadlineEntries = [];
    try {
      const resp = await fetch(CONFERENCE_DEADLINES_JSON);
      if (!resp.ok) throw new Error(`bundled deadlines HTTP ${resp.status}`);
      const data = await resp.json();
      deadlineEntries = Array.isArray(data) ? data : [];
      if (!deadlineEntries.length) throw new Error("bundled deadlines empty");
      rebuildConferenceDeadlineLookups();
    } catch (e) {
      console.warn("data/conference_deadlines.json not available, trying live YAML:", e.message || e);
      await loadDeadlineDataLiveYaml();
    }
  }

  async function loadDeadlineDataLiveYaml() {
    try {
      const resp = await fetch(DEADLINES_YAML_URL);
      if (!resp.ok) throw new Error(`YAML HTTP ${resp.status}`);
      const text = await resp.text();
      if (typeof jsyaml === "undefined") throw new Error("js-yaml not loaded");
      const parsed = jsyaml.load(text);
      deadlineEntries = Array.isArray(parsed) ? parsed : [];
      deadlineLoadFailed = !deadlineEntries.length;
      rebuildConferenceDeadlineLookups();
    } catch (e) {
      deadlineLoadFailed = true;
      deadlineEntries = [];
      rebuildConferenceDeadlineLookups();
      console.warn("Live deadline YAML failed:", e);
    }
  }

  // ---- Event listeners ----

  function setupEventListeners() {
    topicInput.addEventListener("input", updateFindBtnState);
    findBtn.addEventListener("click", handleFind);
    literatureVenuesBtn.addEventListener("click", () =>
      handleLiteratureVenues().catch(console.error)
    );
    literatureVenuesCopyBtn.addEventListener("click", handleLiteratureVenuesCopy);
    clearBtn.addEventListener("click", handleClear);
    venuesExportBtn.addEventListener("click", handleVenuesExport);
    deadlinesExportBtn.addEventListener("click", handleDeadlinesExport);
    venuesBody.addEventListener("click", onSeeMoreClick);
    deadlinesBody.addEventListener("click", onSeeMoreClick);
  }

  function updateFindBtnState() {
    const hasTopic = topicInput.value.trim().length > 0;
    findBtn.disabled = !hasTopic || (!coreData && !scimagoData);
    literatureVenuesBtn.disabled = !hasTopic;
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

    await ensureVenueExtrasLoaded();

    const coreRanks    = getChecked("core-rank");
    const scimagoRanks = getChecked("scimago-rank");
    const types        = getChecked("venue-type");

    findBtn.disabled = true;
    progressSection.hidden = false;
    venuesSection.hidden = true;
    deadlinesSection.hidden = true;

    let aiKeywords = [];
    let aiVenueSuggestions = [];

    if (isAiEnabled()) {
      setProgress(10, "Asking AI to interpret your query…");
      await tick();
      try {
        const aiResult = await callLlm(rawQuery);
        if (aiResult) {
          aiKeywords = aiResult.keywords || [];
          aiVenueSuggestions = (aiResult.venues || []).slice(0, 10);
        }
      } catch (e) {
        console.warn("AI search failed, falling back to keyword search:", e);
      }
    }

    setProgress(40, "Searching venues…");
    await tick();

    // Use LLM-generated semantic keywords for local search; fall back to raw words if AI is off
    // Multi-word LLM keywords (e.g. "stereo vision") are split into individual tokens first
    const rawKeywords = parseKeywords(rawQuery);
    const searchKeywords = aiKeywords.length > 0
      ? [...new Set(aiKeywords.flatMap((k) => parseKeywords(k)))]
      : rawKeywords;

    // Step 1: local search with semantic keywords against name + DBLP topics
    const kwResults = searchVenues(searchKeywords, coreRanks, scimagoRanks, types, [], 30);

    // Step 2: for each AI-suggested venue not already found, look it up in local data.
    // Check order: CORE by acronym → CORE by title → SCImago by title → AI-only
    const foundAcronyms = new Set(kwResults.map((v) => v.acronym.toUpperCase()));
    const aiExtra = [];

    // Normalize for lookup: lowercase, strip punctuation, collapse spaces.
    // Also try stripping a leading "the " since some sources include it and others don't.
    const normTitle = (s) => (s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const normTitleNoThe = (s) => normTitle(s).replace(/^the\s+/, "");
    const wantConference = types.includes("conference");
    const wantJournal    = types.includes("journal");

    for (const { acronym, name } of aiVenueSuggestions) {
      if (foundAcronyms.has(acronym)) continue;

      // 1. CORE conference by acronym
      const coreEntry = wantConference && coreData?.by_acronym?.[acronym];
      if (coreEntry) {
        if (coreRanks.length && !coreRanks.includes(coreEntry.r)) { foundAcronyms.add(acronym); continue; }
        const portalLink = coreEntry.id
          ? `https://portal.core.edu.au/conf-ranks/${coreEntry.id}/`
          : `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(acronym)}&by=acronym`;
        const aiDesc =
          (coreEntry.description && String(coreEntry.description).trim())
          || getConfDescriptionFallback(acronym);
        aiExtra.push({
          acronym, title: coreEntry.t, ranking: coreEntry.r,
          system: "CORE", type: "Conference",
          link: portalLink, dblpUrl: coreEntry.dblp || null,
          description: aiDesc,
          score: 0, aiSuggested: true,
        });
        foundAcronyms.add(acronym);
        continue;
      }

      // 2. CORE conference by full name
      if (wantConference && name && coreData?.by_title) {
        const coreByTitle = coreData.by_title[normTitle(name)];
        if (coreByTitle) {
          const acr2 = coreByTitle.a || acronym;
          const coreEntry2 = coreData.by_acronym[acr2] || {};
          if (!coreRanks.length || coreRanks.includes(coreByTitle.r)) {
            const portalLink = coreEntry2.id
              ? `https://portal.core.edu.au/conf-ranks/${coreEntry2.id}/`
              : `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(acr2)}&by=acronym`;
            const acrUse = acr2 || acronym;
            const aiDesc2 =
              (coreEntry2.description && String(coreEntry2.description).trim())
              || getConfDescriptionFallback(acrUse);
            aiExtra.push({
              acronym: acrUse, title: name, ranking: coreByTitle.r,
              system: "CORE", type: "Conference",
              link: portalLink, dblpUrl: coreEntry2.dblp || null,
              description: aiDesc2,
              score: 0, aiSuggested: true,
            });
            foundAcronyms.add(acronym);
            continue;
          }
        }
      }

      // 3. SCImago journal by full name (try with and without leading "the ")
      if (wantJournal && name && scimagoData?.by_title) {
        const sciEntry = scimagoData.by_title[normTitle(name)]
                      || scimagoData.by_title[normTitleNoThe(name)];
        if (sciEntry) {
          if (!scimagoRanks.length || scimagoRanks.includes(sciEntry.q)) {
            aiExtra.push({
              acronym, title: name, ranking: sciEntry.q,
              system: "SCImago", type: "Journal",
              link: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(name)}`,
              dblpUrl: null, score: 0, aiSuggested: true,
            });
            foundAcronyms.add(acronym);
            continue;
          }
        }
      }

      // 4. Not in CORE/SCImago — CORE portal + DBLP search (never use DBLP as primary link)
      if (wantConference) {
        const coreSearch = `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(acronym)}&by=acronym`;
        const dblpSearch = `https://dblp.org/search?q=${encodeURIComponent(name || acronym)}`;
        aiExtra.push({
          acronym, title: name || acronym, ranking: "?",
          system: "AI", type: "Conference",
          link: coreSearch,
          dblpUrl: dblpSearch,
          score: 0, aiSuggested: true,
        });
        foundAcronyms.add(acronym);
      }
    }

    venueResults = [...kwResults, ...aiExtra];

    setProgress(75, "Matching deadlines…");
    await tick();

    deadlineResults = matchDeadlines(venueResults, searchKeywords);

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

  function searchVenues(keywords, coreRanks, scimagoRanks, types, aiAcronyms = [], maxResults = MAX_VENUE_RESULTS) {
    const results = [];
    const aiAcronymSet = new Set(aiAcronyms.map((a) => a.toUpperCase()));
    const AI_BOOST = 1000;
    // Require at least 1 keyword match; when 3+ keywords are present the LLM
    // has provided precise terms so a single match is still meaningful.
    const minScore = 1;

    if (types.includes("conference") && coreData) {
      for (const [acronym, entry] of Object.entries(coreData.by_acronym)) {
        if (coreRanks.length && !coreRanks.includes(entry.r)) continue;
        const nameScore  = scoreMatch(keywords, [acronym, entry.t]);
        // topics are DBLP-derived word arrays — each element is a short word
        const topicScore = Array.isArray(entry.topics)
          ? scoreMatch(keywords, entry.topics) * 0.5
          : 0;
        // description provides rich scope text for matching
        const descScore = entry.description
          ? scoreMatch(keywords, [entry.description]) * 0.3
          : 0;
        const totalScore = nameScore + topicScore + descScore;
        const aiMatched  = aiAcronymSet.has(acronym.toUpperCase());
        if (totalScore < minScore && !aiMatched) continue;
        const portalLink = entry.id
          ? `https://portal.core.edu.au/conf-ranks/${entry.id}/`
          : `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(acronym)}&by=acronym`;
        const desc =
          (entry.description && String(entry.description).trim())
          || getConfDescriptionFallback(acronym);
        results.push({
          acronym,
          title: entry.t,
          ranking: entry.r,
          system: "CORE",
          type: "Conference",
          link: portalLink,
          dblpUrl: entry.dblp || null,
          description: desc,
          score: totalScore + (aiMatched ? AI_BOOST : 0),
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
        if (score < minScore) continue;
        results.push({
          acronym: "",
          title: entry.t,
          ranking: q,
          system: "SCImago",
          type: "Journal",
          link: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(entry.t)}`,
          score,
          dblpUrl: null,
          aiSuggested: false,
        });
      }
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (RANK_ORDER[a.ranking] || 9) - (RANK_ORDER[b.ranking] || 9);
    });

    return results.slice(0, maxResults);
  }

  function normalizeForMatch(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  // ---- OpenAlex: venues from top-cited papers (Scopus not callable client-side) ----

  function extractVenueNameFromOpenAlexWork(w) {
    if (!w || typeof w !== "object") return "";
    const fromLoc = (loc) => {
      if (!loc || typeof loc !== "object") return "";
      const src = loc.source;
      if (src && typeof src === "object" && src.display_name) {
        return String(src.display_name).trim();
      }
      return "";
    };
    let v = fromLoc(w.primary_location) || fromLoc(w.best_oa_location);
    if (v) return v;
    if (Array.isArray(w.locations)) {
      for (const loc of w.locations) {
        v = fromLoc(loc);
        if (v) return v;
      }
    }
    const hv = w.host_venue;
    if (hv && typeof hv === "object") {
      const n = hv.display_name || hv.name;
      if (n) return String(n).trim();
    }
    return "";
  }

  async function fetchJsonWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * OpenAlex returns works already sorted by cited_by_count desc.
   * We take the first LITERATURE_TOP_N works and collect host-venue names, deduped by normalizeForMatch,
   * preserving order of first appearance (highest-cited papers first).
   */
  async function fetchLiteratureVenueNamesFromOpenAlex(query) {
    const q = query.trim();
    if (!q) return { works: [], venues: [] };

    const params = new URLSearchParams({
      search: q,
      sort: "cited_by_count:desc",
      per_page: String(LITERATURE_TOP_N),
      mailto: OPENALEX_MAILTO,
    });
    const url = `${OPENALEX_WORKS_API}?${params.toString()}`;
    const data = await fetchJsonWithTimeout(url, OPENALEX_TIMEOUT_MS);
    const works = Array.isArray(data.results) ? data.results : [];
    const seen = new Set();
    const venues = [];
    for (const w of works) {
      const name = extractVenueNameFromOpenAlexWork(w);
      if (!name || name.length < 2) continue;
      const key = normalizeForMatch(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      venues.push({
        name,
        citedBy: typeof w.cited_by_count === "number" ? w.cited_by_count : 0,
      });
    }
    return { works, venues };
  }

  async function handleLiteratureVenues() {
    const q = topicInput.value.trim();
    if (!q) {
      alert("Enter keywords or a topic first.");
      return;
    }
    literatureVenuesBtn.disabled = true;
    literatureVenuesSection.hidden = false;
    literatureVenuesList.innerHTML = "";
    literatureVenuesCount.textContent = "";
    literatureVenuesNote.textContent = "Searching OpenAlex…";

    try {
      const { works, venues } = await fetchLiteratureVenueNamesFromOpenAlex(q);
      literatureVenueNames = venues.map((v) => v.name);

      literatureVenuesNote.innerHTML =
        `Elsevier <strong>Scopus</strong> cannot be queried from this browser-only app without an institutional API key. ` +
        `We use the public <a href="https://openalex.org" target="_blank" rel="noopener">OpenAlex</a> API instead: ` +
        `the top <strong>${LITERATURE_TOP_N}</strong> works matching your words, sorted by citation count, ` +
        `then each work’s host venue (journal, conference proceedings, etc.) is listed once, in citation order. ` +
        `Retrieved <strong>${works.length}</strong> works → <strong>${venues.length}</strong> distinct venues.`;

      for (const row of venues) {
        const li = document.createElement("li");
        li.textContent = row.name;
        literatureVenuesList.appendChild(li);
      }
      literatureVenuesCount.textContent = `(${venues.length} venues)`;

      if (works.length && !venues.length) {
        literatureVenuesNote.textContent +=
          " No host venues were attached to those works in OpenAlex.";
      }
    } catch (e) {
      literatureVenueNames = [];
      literatureVenuesNote.textContent =
        e.name === "AbortError"
          ? "Request timed out. Try a shorter query or check your connection."
          : `Could not reach OpenAlex: ${e.message || e}`;
    } finally {
      updateFindBtnState();
    }
  }

  function handleLiteratureVenuesCopy() {
    if (!literatureVenueNames.length) return;
    const text = literatureVenueNames.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => alert("Copied venue list to the clipboard."),
        () => fallbackCopyVenueList(text)
      );
    } else {
      fallbackCopyVenueList(text);
    }
  }

  function fallbackCopyVenueList(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      alert("Copied venue list to the clipboard.");
    } catch {
      prompt("Copy this text:", text);
    }
    document.body.removeChild(ta);
  }

  /**
   * Project a past ISO date (YYYY-MM-DD) to the next future occurrence
   * by incrementing the year, since most conferences repeat annually.
   * Returns {date, estimated} where estimated=true if year was bumped.
   */
  function projectToFuture(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d)) return null;
    let estimated = false;
    while (d < TODAY) {
      d.setFullYear(d.getFullYear() + 1);
      estimated = true;
    }
    return { date: d, estimated };
  }

  function matchDeadlines(venueResults, keywords) {
    if (!deadlineEntries.length) return [];

    const confAcronyms = new Set(
      venueResults
        .filter((v) => v.type === "Conference")
        .map((v) => v.acronym.toUpperCase())
    );

    // Deduplicate by acronym — keep only the most recent entry per conference
    // so we get one projected row, not one per historical year.
    const seen = new Set();

    const matched = deadlineEntries.filter((entry) => {
      // Exclude very old data (before 2022) to avoid noise
      const startIso = entry.start || "";
      if (startIso && startIso < "2022-01-01") return false;

      const shortName = (entry.title || entry.name || "").toUpperCase().trim();
      const fullName  = entry.full_name || "";

      if (confAcronyms.size > 0 && confAcronyms.has(shortName)) return true;
      return scoreMatch(keywords, [shortName, fullName]) > 0;
    });

    // Keep most-recent entry per acronym (highest start date)
    const byAcronym = new Map();
    for (const entry of matched) {
      const key = (entry.title || entry.name || "").toUpperCase().trim();
      const existing = byAcronym.get(key);
      const thisStart = entry.start || "0000";
      const prevStart = existing ? (existing.start || "0000") : "";
      if (!existing || thisStart > prevStart) byAcronym.set(key, entry);
    }

    return [...byAcronym.values()]
      .sort((a, b) => {
        // Sort by projected future conference date
        const proj = (e) => {
          const iso = e.start || "";
          const p = projectToFuture(iso);
          return p ? p.date : new Date("9999-12-31");
        };
        return proj(a) - proj(b);
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
   * Rebuild lookup maps from aideadlin.es YAML so we can match CORE venues
   * by acronym OR by normalised full title (YAML `full_name` vs CORE `t`).
   */
  function rebuildConferenceDeadlineLookups() {
    confDeadlineByAcronym = new Map();
    confDeadlineByNormTitle = new Map();
    if (!deadlineEntries.length) return;

    const best = new Map();
    for (const entry of deadlineEntries) {
      const startIso = entry.start || "";
      if (!startIso || startIso < "2022-01-01") continue;
      const acr = (entry.title || entry.name || "").toUpperCase().trim();
      if (!acr) continue;
      const existing = best.get(acr);
      if (!existing || startIso > (existing.start || "")) best.set(acr, entry);
    }

    const normPick = new Map(); // normKey → { start, row }

    for (const entry of best.values()) {
      const proj = projectToFuture(entry.start);
      if (!proj) continue;
      const label = proj.date.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
      const row = {
        date: proj.estimated ? `~${label} (est.)` : (entry.date || label),
        location: entry.place || "",
        siteLink: entry.link || "",
        estimated: proj.estimated,
      };
      const shortUpper = (entry.title || entry.name || "").toUpperCase().trim();
      confDeadlineByAcronym.set(shortUpper, row);

      const bump = (normKey) => {
        if (!normKey) return;
        const prev = normPick.get(normKey);
        const s = entry.start || "";
        if (!prev || s > prev.start) normPick.set(normKey, { start: s, row });
      };
      bump(normalizeForMatch(entry.full_name || ""));
      bump(normalizeForMatch(shortUpper));
    }

    for (const [normKey, { row }] of normPick) {
      confDeadlineByNormTitle.set(normKey, row);
    }
  }

  /** @returns {{date:string,location:string,siteLink:string,estimated?:boolean}|null} */
  function getConferenceDeadlineRow(v) {
    if (v.type !== "Conference" || !confDeadlineByAcronym) return null;
    const acr = (v.acronym || "").toUpperCase().trim();
    if (acr && confDeadlineByAcronym.has(acr)) return confDeadlineByAcronym.get(acr);
    const nt = normalizeForMatch(v.title || "");
    if (nt && confDeadlineByNormTitle.has(nt)) return confDeadlineByNormTitle.get(nt);
    return null;
  }

  /** True if href is a ranking/DBLP lookup page, not a venue homepage. */
  function isRankingOrDblpUrl(href) {
    if (!href || typeof href !== "string") return true;
    const h = href.trim().toLowerCase();
    return (
      /^https?:\/\/([^/]*\.)?dblp\.org/i.test(href)
      || h.includes("portal.core.edu.au")
      || h.includes("scimagojr.com/journalsearch")
    );
  }

  function venuePrimaryWebsiteUrl(v, dlInfo) {
    const deadlineSite = (dlInfo && dlInfo.siteLink) || "";
    const official = v.type === "Conference" ? getOfficialConfUrl(v.acronym) : "";
    const fromEntry =
      v.link && typeof v.link === "string" && !isRankingOrDblpUrl(v.link)
        ? v.link.trim()
        : "";
    return deadlineSite || official || fromEntry || "";
  }

  /** Primary website when known; otherwise DBLP + ranking portal so AI rows are still usable. */
  function formatVenueLinkCell(v, dlInfo) {
    const website = venuePrimaryWebsiteUrl(v, dlInfo);
    if (website) {
      return `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">Website ↗</a>`;
    }
    const parts = [];
    if (v.dblpUrl) {
      parts.push(
        `<a href="${escapeHtml(v.dblpUrl)}" target="_blank" rel="noopener">DBLP ↗</a>`
      );
    }
    if (v.link && !/^https?:\/\/([^/]*\.)?dblp\.org/i.test(v.link)) {
      const lbl = v.type === "Conference" ? "CORE ↗" : "SCImago ↗";
      parts.push(
        `<a href="${escapeHtml(v.link)}" target="_blank" rel="noopener">${lbl}</a>`
      );
    }
    return parts.length ? parts.join(" · ") : "—";
  }

  function renderVenuesTable() {
    venuesBody.innerHTML = "";
    if (!venueResults.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="9" style="text-align:center;color:var(--color-text-muted);padding:1.5rem">No matching venues found. Try broader keywords or relax the ranking filters.</td>`;
      venuesBody.appendChild(tr);
      return;
    }
    venueResults.forEach((v, i) => {
      const info = getConferenceDeadlineRow(v);
      const nextDate   = info ? info.date     : "—";
      const location   = info ? (info.location || "—") : "—";
      const siteLink   = formatVenueLinkCell(v, info);
      const aiBadge = v.aiSuggested
        ? `<span class="badge-ai" title="Suggested by AI">AI</span> `
        : "";
      const descHtml = v.description
        ? `<span class="desc-clamp" title="${escapeHtml(v.description)}">${escapeHtml(v.description.slice(0, 120))}${v.description.length > 120 ? "…" : ""}</span>`
        : `<span style="color:var(--color-text-muted)">—</span>`;
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
        <td class="desc-cell">${descHtml}</td>
        <td>${escapeHtml(String(nextDate))}</td>
        <td>${escapeHtml(location)}</td>
        <td>${siteLink}</td>
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
        "No current or upcoming conferences found for this topic in the deadline database. Note: coverage is primarily CS / AI / ML venues via aideadlin.es.";
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

      // Project conference date to the next future occurrence
      const proj = d.start ? projectToFuture(d.start) : null;
      let confDateCell;
      if (proj) {
        const label = proj.date.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
        confDateCell = proj.estimated
          ? `<span title="Based on last known date ${d.start}; actual date TBC">~${escapeHtml(label)} (est.)</span>`
          : escapeHtml(d.date || label);
      } else {
        confDateCell = escapeHtml(d.date || "—");
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="title-cell">${escapeHtml(shortName)}${d.full_name ? `<br><span class="venue-fullname">${escapeHtml(d.full_name)}</span>` : ""}</td>
        <td>${rankCell}</td>
        <td>${confDateCell}</td>
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
    const headers = ["#", "Name", "Acronym", "Type", "Ranking", "System", "Description", "Next Date", "Location", "Website", "DBLP", "Ranking Link"];
    const rows = venueResults.map((v, i) => {
      const info = getConferenceDeadlineRow(v);
      const websiteOut = venuePrimaryWebsiteUrl(v, info);
      return [
        i + 1,
        csvCell(v.title),
        csvCell(v.acronym || ""),
        v.type,
        csvCell(v.ranking),
        v.system,
        csvCell(v.description || ""),
        csvCell(info ? info.date : ""),
        csvCell(info ? (info.location || "") : ""),
        csvCell(websiteOut),
        csvCell(v.dblpUrl || ""),
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
      "#", "Conference", "Full Name", "CORE Ranking", "Conference Date", "Location", "Link",
    ];
    const rows = deadlineResults.map((d, i) => {
      const shortName = d.title || d.name || "";
      const rank = getCoreRankForConf(shortName);
      const proj = d.start ? projectToFuture(d.start) : null;
      const confDate = proj
        ? (proj.estimated
            ? `~${proj.date.toLocaleDateString("en-GB", { month: "short", year: "numeric" })} (est.)`
            : d.date || "")
        : (d.date || "");
      return [
        i + 1,
        csvCell(shortName),
        csvCell(d.full_name || ""),
        csvCell(rank),
        csvCell(confDate),
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
    literatureVenuesSection.hidden = true;
    literatureVenuesList.innerHTML = "";
    literatureVenuesNote.textContent = "";
    literatureVenuesCount.textContent = "";
    literatureVenueNames = [];
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
