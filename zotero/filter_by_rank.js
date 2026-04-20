/**
 * P Ranker — Zotero Filter Script
 * ================================
 * Filters a Zotero collection (or entire library) by venue ranking, using the
 * same data as https://nishantkapps.github.io/pranker/
 *
 * WHAT IT DOES
 * ------------
 * 1. Fetches core.json (CORE conference ranks) and scimago.json (SCImago
 *    journal quartiles) from the live GitHub Pages app.
 * 2. For every regular item in the selected collection (or library), looks up
 *    the publication venue and determines its rank.
 * 3. Adds a tag like "PRanker: Q1", "PRanker: CORE-A*", "PRanker: Unranked"
 *    to each item so you can sort/filter by tag at any time.
 * 4. Items that do NOT meet the threshold (see KEEP_RANKS below) are moved
 *    into a child collection called "Filtered Out (PRanker)" for review.
 *    Nothing is deleted automatically — you decide what to remove.
 *
 * HOW TO RUN
 * ----------
 * 1. In Zotero, select the collection you want to filter in the left panel.
 *    (If nothing is selected the script processes your entire library.)
 * 2. Open  Tools → Developer → Run JavaScript
 * 3. Paste the ENTIRE contents of this file into the code box.
 * 4. Click  Run  and watch the Output pane for progress.
 * 5. When done, review the "Filtered Out (PRanker)" collection.
 *    Delete items from there if desired — or drag them back if you disagree.
 * 6. To undo tags: right-click any tag in the tag selector and choose
 *    "Delete Tag" to remove it from all items at once.
 *
 * CUSTOMISE
 * ---------
 * Edit KEEP_RANKS below to change the threshold before running.
 *
 * MATCHING LOGIC (in order)
 * --------------------------
 * Journals : ISSN → scimago.by_issn
 *            then normalized publicationTitle → scimago.by_title
 * Conferences: normalized proceedingsTitle / conferenceName → core.by_title
 *              then acronym extracted from parentheses → core.by_acronym
 *              then normalized publicationTitle → core.by_title (fallback)
 * Both are tried for every item so a journal-style paper found in proceedings
 * is still caught.
 */

// ── Configuration ──────────────────────────────────────────────────────────────

// Ranks that are considered "good enough" to KEEP.
// Everything else goes to "Filtered Out (PRanker)".
const KEEP_RANKS = new Set([
  "Q1", "Q2", "Q3",   // SCImago journal quartiles
  "A*", "A",           // CORE conference ranks
]);

// Base URL for the ranking data (no trailing slash)
const DATA_BASE = "https://nishantkapps.github.io/pranker/data";

// Tag prefix added to every processed item
const TAG_PREFIX = "PRanker: ";

// Name of the destination collection for filtered-out items
const FILTERED_COLLECTION_NAME = "Filtered Out (PRanker)";

// ── Normalise title (must match Python build scripts exactly) ──────────────────
// Python: title.lower().strip() → re.sub(r"[^\w\s]","",t) → re.sub(r"\s+"," ",t)

function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")   // strip punctuation (same as Python [^\w\s])
    .replace(/\s+/g, " ");
}

// ── ISSN helpers ───────────────────────────────────────────────────────────────

/** Normalise a single ISSN to "XXXX-XXXX" uppercase. */
function normalizeIssn(raw) {
  const digits = raw.replace(/[^0-9Xx]/gi, "").toUpperCase();
  if (digits.length === 8) return digits.slice(0, 4) + "-" + digits.slice(4);
  return raw.toUpperCase().trim();
}

/** Return all ISSNs found in a Zotero ISSN field string. */
function parseIssns(field) {
  if (!field) return [];
  // Field may contain multiple ISSNs separated by spaces, commas, semicolons
  return field.split(/[\s,;]+/).map(normalizeIssn).filter(Boolean);
}

// ── Conference acronym extraction ──────────────────────────────────────────────

/**
 * Try to pull a short conference acronym from a title string.
 * Handles patterns like:
 *   "2024 IEEE ICRA"  →  ["ICRA"]
 *   "Proceedings of CVPR (2025)"  →  ["CVPR"]
 *   "ACM SIGMOD Conference"  →  ["SIGMOD"]
 */
function extractAcronyms(text) {
  if (!text) return [];
  const candidates = new Set();

  // 1. Words in parentheses that look like acronyms
  for (const m of text.matchAll(/\(([A-Z][A-Z0-9\-]{1,14})\)/g)) {
    candidates.add(m[1]);
  }
  // 2. All-caps tokens of 2–12 chars (not common noise words)
  const noise = new Set(["IEEE", "ACM", "IFIP", "USENIX", "SIAM", "LNCS",
    "THE", "AND", "FOR", "ON", "OF", "IN", "AN", "AT", "IS"]);
  for (const token of text.split(/\s+/)) {
    const t = token.replace(/[^A-Z0-9]/g, "");
    if (t.length >= 2 && t.length <= 12 && /^[A-Z]/.test(t) && !noise.has(t)) {
      candidates.add(t);
    }
  }
  return [...candidates];
}

// ── Strip common proceedings prefixes before title matching ───────────────────

function stripProceedingsPrefix(title) {
  return title
    .replace(/^(proceedings\s+of\s+(the\s+)?(\d+(st|nd|rd|th)\s+)?)/i, "")
    .replace(/^(proc\.\s+)/i, "")
    .trim();
}

// ── Main lookup function ───────────────────────────────────────────────────────

/**
 * Given a Zotero item and the loaded ranking data, return
 * { rank, system, tag } or null if not found.
 *
 * rank   — e.g. "Q1", "A*", "B", "Unranked"
 * system — "SCImago" | "CORE"
 * tag    — the full tag string to attach, e.g. "PRanker: Q1 (SCImago)"
 */
function lookupRank(item, coreData, scimagoData) {
  const issns        = parseIssns(item.getField("ISSN") || "");
  const pubTitle     = item.getField("publicationTitle") || "";
  const procTitle    = item.getField("proceedingsTitle") || "";
  const confName     = item.getField("conferenceName") || "";

  // ── 1. ISSN → SCImago ────────────────────────────────────────────────────
  for (const issn of issns) {
    const entry = scimagoData.by_issn[issn];
    if (entry && entry.q && entry.q !== "-") {
      return makeResult(entry.q, "SCImago");
    }
  }

  // ── 2. Normalised publicationTitle → SCImago ─────────────────────────────
  if (pubTitle) {
    const norm = normalizeTitle(pubTitle);
    const entry = scimagoData.by_title[norm];
    if (entry && entry.q && entry.q !== "-") {
      return makeResult(entry.q, "SCImago");
    }
  }

  // ── 3. Conference title matching → CORE ──────────────────────────────────
  const confCandidates = [procTitle, confName, pubTitle].filter(Boolean);

  for (const raw of confCandidates) {
    // a) Full normalised title
    const normFull = normalizeTitle(raw);
    let cEntry = coreData.by_title[normFull];
    if (cEntry) return makeResult(cEntry.r, "CORE");

    // b) Strip "Proceedings of the …" prefix and retry
    const stripped = stripProceedingsPrefix(raw);
    if (stripped !== raw) {
      const normStripped = normalizeTitle(stripped);
      cEntry = coreData.by_title[normStripped];
      if (cEntry) return makeResult(cEntry.r, "CORE");
    }
  }

  // ── 4. Acronym extraction → CORE by_acronym ──────────────────────────────
  for (const raw of confCandidates) {
    for (const acr of extractAcronyms(raw)) {
      const cEntry = coreData.by_acronym[acr];
      if (cEntry) return makeResult(cEntry.r, "CORE");
    }
  }

  return null; // could not determine rank
}

function makeResult(rank, system) {
  const tag = `${TAG_PREFIX}${rank} (${system})`;
  return { rank, system, tag };
}

// ── Zotero collection helpers ──────────────────────────────────────────────────

async function getOrCreateFilteredCollection(libraryID, parentCollectionID) {
  // Check if it already exists under the same parent
  const existing = Zotero.Collections.getByLibrary(libraryID)
    .find(c => c.name === FILTERED_COLLECTION_NAME
               && c.parentID === (parentCollectionID || null));
  if (existing) return existing;

  const col = new Zotero.Collection();
  col.libraryID = libraryID;
  col.name = FILTERED_COLLECTION_NAME;
  if (parentCollectionID) col.parentID = parentCollectionID;
  await col.saveTx();
  return col;
}

// ── Remove old PRanker tags from an item ──────────────────────────────────────

function removePrankerTags(item) {
  const toRemove = item.getTags()
    .filter(t => t.tag.startsWith(TAG_PREFIX))
    .map(t => t.tag);
  for (const tag of toRemove) {
    item.removeTag(tag);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

(async () => {
  // ── Load ranking data ──────────────────────────────────────────────────────
  output("Loading ranking data from GitHub Pages …");
  let coreData, scimagoData;
  try {
    const [coreRes, sciRes] = await Promise.all([
      fetch(`${DATA_BASE}/core.json`),
      fetch(`${DATA_BASE}/scimago.json`),
    ]);
    if (!coreRes.ok) throw new Error(`core.json: HTTP ${coreRes.status}`);
    if (!sciRes.ok)  throw new Error(`scimago.json: HTTP ${sciRes.status}`);
    coreData    = await coreRes.json();
    scimagoData = await sciRes.json();
    output(`  core.json: ${Object.keys(coreData.by_acronym).length} conferences`);
    output(`  scimago.json: ${Object.keys(scimagoData.by_issn).length} journal ISSNs`);
  } catch (e) {
    output(`ERROR loading data: ${e.message}`);
    output("Make sure you have an internet connection and the GitHub Pages site is live.");
    return;
  }

  // ── Get items ──────────────────────────────────────────────────────────────
  const selectedCollection = ZoteroPane.getSelectedCollection();
  const libraryID = ZoteroPane.getSelectedLibraryID();
  let items;

  if (selectedCollection) {
    output(`\nProcessing collection: "${selectedCollection.name}"`);
    items = selectedCollection.getChildItems();
  } else {
    output("\nNo collection selected — processing entire library.");
    items = await Zotero.Items.getAll(libraryID);
  }

  // Only regular items (not notes, attachments, etc.)
  items = items.filter(i => i.isRegularItem());
  output(`Found ${items.length} regular items to process.\n`);

  if (!items.length) {
    output("Nothing to do.");
    return;
  }

  // ── Prepare "Filtered Out" collection ─────────────────────────────────────
  const filteredCol = await getOrCreateFilteredCollection(
    libraryID,
    selectedCollection ? selectedCollection.id : null
  );

  // ── Process items ──────────────────────────────────────────────────────────
  let kept = 0, filtered = 0, unmatched = 0;
  const unmatchedTitles = [];

  for (const item of items) {
    const result = lookupRank(item, coreData, scimagoData);

    // Remove stale PRanker tags from a previous run
    removePrankerTags(item);

    if (!result) {
      // Could not determine rank
      item.addTag(`${TAG_PREFIX}Unranked`);
      await item.saveTx();
      await filteredCol.addItems([item.id]);
      unmatched++;
      unmatchedTitles.push(item.getField("title") || "(no title)");
      continue;
    }

    item.addTag(result.tag);
    await item.saveTx();

    if (KEEP_RANKS.has(result.rank)) {
      kept++;
      output(`  KEEP   [${result.rank}] ${(item.getField("title") || "").slice(0, 70)}`);
    } else {
      await filteredCol.addItems([item.id]);
      filtered++;
      output(`  FILTER [${result.rank}] ${(item.getField("title") || "").slice(0, 70)}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  output("\n══════════════════════════════════════════");
  output(`  Total processed : ${items.length}`);
  output(`  Kept (≥ threshold) : ${kept}`);
  output(`  Filtered out    : ${filtered}`);
  output(`  Venue not found : ${unmatched}`);
  output("══════════════════════════════════════════");
  if (filtered + unmatched > 0) {
    output(`\nReview "${FILTERED_COLLECTION_NAME}" — delete items there as desired.`);
    output("Tags can be removed via the tag selector (right-click → Delete Tag).");
  }
  if (unmatched > 0) {
    output(`\nUnmatched items (venue not found in ranking data):`);
    for (const t of unmatchedTitles.slice(0, 20)) {
      output(`  • ${t.slice(0, 80)}`);
    }
    if (unmatchedTitles.length > 20) {
      output(`  … and ${unmatchedTitles.length - 20} more (tagged "PRanker: Unranked")`);
    }
  }
})();
