<!-- @format -->

# Master prompt: Bella Note (PDF highlight review)

## Overview

Build a **local-first** macOS-friendly web application for reviewing PDF files (often exported from PowerPoint). The app extracts highlighted text and related annotations from PDFs, renders each page as a PNG slide, and shows **slide image + editable notes** in a study workflow. All state lives in **SQLite** on disk. The product name in the UI is **Bella Note**.

No external APIs or cloud services. Everything runs on the developer’s machine (localhost).

## Engineering discipline

- Act as a professional software engineer: clear module boundaries, single responsibility, and reusable pieces on both API and UI.
- Prefer modern 2026 practices: typed frontend (TypeScript), linting in CI, and consistent formatting.
- Match existing patterns when extending code; avoid drive-by refactors.

## Tech stack

| Layer | Technology |
|--------|------------|
| API | Python 3.11+ with **FastAPI**, **Uvicorn** |
| PDF | **PyMuPDF (fitz)**, **pdfplumber**, **pdf2image** (requires **Poppler**), **Pillow** |
| DB | **SQLite** via `sqlite3` (WAL mode, foreign keys) |
| UI | **React 19**, **Vite**, **TypeScript**, **Ant Design**, **TipTap** (WYSIWYG notes), **@dnd-kit** (sortable sidebar) |
| HTTP multipart | `python-multipart` |

Python dependencies live in `apps/api/requirements.txt`; dev tooling (Ruff) in `apps/api/requirements-dev.txt`. Node dependencies are managed with **npm workspaces** from the **repository root** (`package.json` + `package-lock.json`).

## Monorepo layout (single Git repository)

Organize the project as a **monorepo**:

- **`apps/api/`** — FastAPI entrypoint (`main.py`), `database/` package (`sqlite_impl` / `postgres_impl`), `pdf_processor.py`, Python requirements. **Run the API with current working directory `apps/api`** so `import database` / `import pdf_processor` resolve.
- **`frontend/`** — Vite + React app (npm workspace package named `frontend`).
- **Repository root** — shared runtime and tooling:
  - **`data/`** — SQLite DB, rendered slide PNGs, **stored original PDFs** (`data/originals/{doc_id}.pdf`). Gitignore database and binaries; keep `.gitkeep` in empty dirs if useful.
  - **`static/`** — production SPA output from `npm run build` (gitignored as build artifact).
  - **`package.json`** — `"workspaces": ["frontend"]`, scripts: `dev`, `build`, `lint`, `lint:fix` delegating to `-w frontend`.
  - **`pyproject.toml`** — Ruff config for the whole repo; exclude `venv`, `node_modules`, `static`, `data`, etc.

**Path resolution in Python:** `REPO_ROOT` must be the **git repository root** (parent of `apps/`). From files under `apps/api/`, use:

```python
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
```

Use `REPO_ROOT / "data"` and `REPO_ROOT / "static"` for database, originals, slides, and served SPA.

**Vite:** `build.outDir` = `../static` (relative to `frontend/`), `emptyOutDir: true`. Dev server proxies at least: `/upload`, `/documents`, `/slides`, `/highlights`, `/export` to `http://127.0.0.1:8000`.

**FastAPI static mount:** After all API routes, if `STATIC_DIR` exists, mount `StaticFiles(..., html=True)` at `/` so production serves the SPA and API on one port (e.g. 8000).

## Linting and CI

- **Python:** Ruff (`ruff check .`, `ruff format`) from repo root; config in `pyproject.toml` (e.g. target Python 3.11, line length 100, sensible rule set; ignore `B008` for FastAPI defaults).
- **Frontend:** ESLint 9 with TypeScript (`typescript-eslint`), React hooks plugin; `npm run lint` / `npm run lint:fix` from root via workspace.
- **GitHub Actions** (`.github/workflows/lint.yml`): job 1 — checkout, Python 3.12, `pip install ruff`, `ruff check .` and `ruff format --check .`; job 2 — Node 20, `npm ci` at root (`cache-dependency-path: package-lock.json`), `npm run lint`, `npm run build`.

## Database schema

Create tables on startup. Use **WAL** and **foreign keys**.

**`documents`**

- `id`, `filename` (display name; editable), `original_path` (absolute path to stored PDF under `data/originals/` when present), `uploaded_at`, `total_pages`, `slide_image_dir`, `sort_order` (integer, sidebar order; **0 = top**).

**Migration:** If upgrading an older DB without `sort_order`, `ALTER TABLE` add column and backfill order from existing rows (e.g. by `uploaded_at` / `id`).

**`slides`**

- `id`, `document_id` FK, `page_number`, `image_path`, `has_highlights`, `is_hidden`.

**`highlights`**

- `id`, `slide_id` FK, `document_id` FK, `extracted_text` (plain text from PDF extraction **or HTML** from the rich editor), `is_very_important` (boolean; UI labels this **“starred”**), `created_at`.

New documents get `sort_order = MAX(sort_order)+1` on insert. Listing documents orders by `sort_order ASC`, then `id ASC`.

## PDF processing (`pdf_processor.py`)

Implement robust highlight extraction for PowerPoint-style PDFs:

1. **PyMuPDF** — Walk highlight annotations; extract text with word geometry / clips (e.g. `get_text("words", clip=...)`), merge words into readable lines; normalize line breaks (collapse soft breaks; preserve bullet-like lines).
2. **Yellow vector fills** — Detect non-text yellow highlight rectangles via drawing paths / fills; treat as highlights when color matches a yellow heuristic.
3. **Pixmap / image fallback** when vector paths fail.
4. **pdfplumber** — Optional secondary path where it helps; PyMuPDF is the primary engine.

Expose at least: `count_pages(path)`, `extract_highlights(path) -> list[{page_number, text}]`, `render_pdf_pages_to_png(pdf_path, out_dir)` writing `page_{n}.png`.

## Upload and file lifecycle

On **POST /upload**:

- Accept multipart **multiple** PDFs.
- For each `.pdf`: write temp file, run `extract_highlights` + `count_pages`, insert document with new `sort_order`, copy original to **`data/originals/{doc_id}.pdf`**, set `original_path`, render PNGs into `data/slides/{doc_id}/`, insert slides + highlight rows.
- Return JSON: `{ "results": [...], "warnings": [...] }`. If a document has **zero** highlights, include a **warning** (flattened/rasterized PDF explanation). Skip non-PDFs with a warning.
- On failure after DB insert, purge DB rows, slide dir, and original copy.

## API endpoints

Use Pydantic bodies where appropriate. **Register duplicate routes with and without trailing slashes** for POST/PATCH/DELETE that might otherwise fall through to `StaticFiles` and return **405**.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/upload`, `/upload/` | Multipart PDF upload (see above) |
| GET | `/documents` | List documents: `id`, `filename`, `uploaded_at`, `total_pages`, `highlight_count`, `original_stored` |
| POST | `/documents/reorder`, `/documents/reorder/` | Body `{ "document_ids": [int, ...] }` — full permutation of all doc ids; persist `sort_order` |
| PATCH | `/documents/{doc_id}`, `/documents/{doc_id}/` | Rename display `filename` |
| GET | `/documents/{doc_id}/slides` | Slides with nested `highlights`: `id`, `text`, `is_very_important` |
| GET | `/slides/{doc_id}/{page_number}` | PNG `FileResponse` |
| POST | `/slides/{slide_id}/highlights`, `.../` | Body `{ "text": "" }` — **manual note** (same table as extracts); optional initial HTML |
| PATCH | `/slides/{slide_id}/hide`, `.../` | Body `{ "hidden": bool }` |
| PATCH | `/highlights/{highlight_id}/very-important`, `.../` | Body `{ "very_important": bool }` |
| PATCH | `/highlights/{highlight_id}/text`, `.../` | Body `{ "text": str }` — save editor HTML |
| DELETE | `/highlights/{highlight_id}`, `.../` | Delete highlight; recompute slide `has_highlights` |
| GET | `/export` | Plain-text download `study_master.txt`. Query: repeat `document_ids` to filter; omit to export all. Strip HTML to plain text for export. Starred lines: prefix `⭐ STARRED:` |
| POST | `/documents/{doc_id}/rescan`, `.../` | Re-run extraction from **stored** PDF; clear highlights for doc, re-insert; return counts + warnings |
| DELETE | `/documents/{doc_id}`, `.../` | Delete document, slides, highlights, slide images, stored original |

OpenAPI title: **Bella Note**.

## Frontend — UI and behavior

- **Theme:** Ant Design with a cohesive **purple / blue palette** and **mint / cool green** accents; ConfigProvider-based theming; clean, flat 2026 aesthetic.
- **Layout:** No heavy legacy “app chrome”; compact top area with branding **“Bella Note”**, **Upload PDFs**, and **Export** (exports **checked** documents from the sidebar). Main area: **sortable document list** in a sidebar (dnd-kit); selecting a doc loads slides in the main panel.
- **Sidebar rows:** Checkbox for export inclusion, document title (inline rename), highlight count, drag handle, delete document. Clear **selected** row styling.
- **Slide list:** Filter toggles — hide slides with no highlights; **show starred only**. Show count text, e.g. “X of Y slides shown”. Each slide card: **slide image** (click → lightbox), header with slide label and hide control, **notes column** with height/scroll behavior tied to slide image column.
- **Notes:** Each highlight and each **Add note** entry uses **TipTap** (StarterKit + placeholder): bold, lists, etc. Persist with **PATCH** text. **Star** toggle maps to `is_very_important` (UI copy: “starred”, not “very important”). Delete note button. Auto-focus new notes where appropriate. **Consolidated formatting toolbar** shared across editors.
- **Rescan** control when `original_stored` is true; show API error message when no stored PDF exists.
- **Upload:** hidden file input, `.pdf` multiple, loading state, on success refresh list and select new doc; surface **warnings** from API (e.g. zero highlights).
- **Export:** GET `/export` with selected ids as repeated `document_ids` query params; trigger browser download of `study_master.txt`.

## Root `README.md`

Document: monorepo layout, `brew install poppler`, venv at repo root, `pip install -r apps/api/requirements.txt`, `npm install` at root, `npm run build` → `static/`, run `cd apps/api && python main.py`, dev workflow (`uvicorn main:app --reload` from `apps/api` + `npm run dev` at root on port 5173), lint commands, and that `data/` + `static/` are gitignored appropriately.

## Implementation notes

- **CORS:** Not required for same-origin production (`static` + API on :8000). Vite dev proxy covers development.
- **Errors:** Never fail uploads silently when extraction yields zero highlights; use warnings.
- **Security:** Local app only; still validate file types and bound text length on PATCH (e.g. max length for HTML bodies).

If this prompt is executed from scratch, the delivered repository should match: **monorepo with `apps/api` + `frontend` workspace**, **Bella Note** branding, **TipTap** notes, **dnd-kit** ordering, **stored originals + rescan**, **filtered export**, **Ruff + ESLint + GitHub Actions**, and the **API and schema** described above.
