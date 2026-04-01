# P Ranker — Paper Ranking Lookup Tool

Determine the ranking of scientific paper sources at a glance. Paste DOIs or upload a CSV, and instantly see whether each paper's journal or conference is ranked Q1–Q4 (SCImago) or A\*–C (CORE).

## Live Demo

> _Deployed at GitHub Pages — URL will appear here once the repo is pushed._

## How It Works

1. **Enter DOIs** — paste them in the text box (one per line) or upload a CSV file with a `doi` column.
2. **Click "Rank Papers"** — the app resolves each DOI via the [CrossRef API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), identifies the source journal or conference, and looks up its ranking.
3. **View results** — a color-coded table shows each paper's title, source, and ranking.
4. **Export** — download the results as a CSV file.

### Ranking Sources

| Source Type | Ranking System | Tiers |
|-------------|---------------|-------|
| Journals | [SCImago (SJR)](https://www.scimagojr.com/) | Q1, Q2, Q3, Q4 |
| Conferences | [CORE Rankings](https://portal.core.edu.au/conf-ranks/) | A\*, A, B, C |

## Local Development

No build step required. Just serve the files:

```bash
python -m http.server 8000
# Open http://localhost:8000
```

### Refreshing Ranking Data

The `data/` JSON files are pre-built. To rebuild **SCImago** (`data/scimago.json`):

1. Download the journal CSV from [SCImago Journal Rank](https://www.scimagojr.com/journalrank.php) (export as CSV), **or** save it as `data/scimago_raw.csv` or `data/scimagojr YYYY.csv`.
2. Run:

```bash
pip install -r scripts/requirements.txt
python scripts/build_scimago.py   # uses local CSV if present; otherwise tries download
python scripts/build_core.py
```

Commit the updated `data/scimago.json` (and optionally the raw CSV). A weekly GitHub Actions job can refresh **CORE** data; SCImago automated download often fails with 403 — use a manual CSV when needed.

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no framework)
- **DOI Resolution**: CrossRef REST API (called from browser)
- **Ranking Data**: Pre-processed JSON files from SCImago and CORE
- **Hosting**: GitHub Pages
- **CI/CD**: GitHub Actions

## License

MIT
