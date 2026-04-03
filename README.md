# Bella Note

A **local-first** web app for reviewing PDFs (often exported from PowerPoint): it extracts highlighted regions and annotations, shows each page as a slide image next to editable notes, and keeps everything in **SQLite** on your machine.

This repository is a **monorepo** (single Git repo):

| Package | Path | Role |
|--------|------|------|
| **API** | `apps/api/` | FastAPI, PDF processing, SQLite (`data/` at repo root) |
| **Web** | `frontend/` | React + Vite (npm workspace) |

Shared at repo root: **`data/`** (runtime), **`static/`** (production UI build output), **`pyproject.toml`** (Ruff), **`package.json`** (npm workspaces).

## Stack

| Layer | Technology |
|--------|------------|
| API | [FastAPI](https://fastapi.tiangolo.com/), Uvicorn |
| PDF / slides | PyMuPDF, pdfplumber, pdf2image (Poppler), Pillow |
| DB | SQLite (`data/db.sqlite`, WAL mode) |
| UI | React 19, Vite, Ant Design, [TipTap](https://tiptap.dev/) (WYSIWYG notes), dnd-kit (sidebar order) |

## Features

- **Import PDFs** — Upload one or more PDFs; pages are rendered to PNGs under `data/slides/`.
- **Highlight extraction** — Standard annotations, yellow vector fills (common in PowerPoint PDFs), and pixmap fallback when needed.
- **Sidebar** — Drag to reorder documents; rename titles; delete documents; export selected docs to a plain-text study file.
- **Slides** — Filter by “no highlights”, “starred only”; hide slides; rescan from the **stored** PDF copy (`data/originals/`).
- **Notes** — Each highlight or **Add note** entry uses a rich editor (bold, lists, etc.); text is stored as HTML; **star** a note to mark it; delete per note.
- **Single-server deploy** — `npm run build` writes the SPA into `static/`; FastAPI serves the UI and API on one port.

## Requirements

- **Python** 3.11+ (3.13 works with the pinned stack)
- **Node.js** 20+ (for the frontend)
- **Poppler** — required by `pdf2image` to rasterize pages:

  ```bash
  brew install poppler
  ```

  On Linux, install the `poppler-utils` (or equivalent) package for your distribution.

## Setup

1. **Clone** the repository and enter the project directory.

2. **Python virtual environment** (recommended at repo root)

   ```bash
   python3 -m venv venv
   source venv/bin/activate   # Windows: venv\Scripts\activate
   pip install -r apps/api/requirements.txt
   ```

3. **Install frontend dependencies** (npm workspaces — run once from **repo root**)

   ```bash
   npm install
   ```

4. **Production UI build** (writes to `static/`)

   ```bash
   npm run build
   ```

5. **Run the API** (serves API + `static/` SPA)

   ```bash
   source venv/bin/activate
   cd apps/api
   python main.py
   ```

6. Open **http://localhost:8000** in your browser.

### API documentation

With the server running, interactive docs are at **http://localhost:8000/docs** (OpenAPI).

## Development

Terminal 1 — API with auto-reload (working directory must be `apps/api` so imports resolve):

```bash
source venv/bin/activate
cd apps/api
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2 — Vite dev server (from **repo root**; proxies API routes to port 8000):

```bash
npm run dev
```

Use **http://localhost:5173** during UI work.

## Linting

Install Python dev tools:

```bash
source venv/bin/activate
pip install -r apps/api/requirements-dev.txt
```

**Python** — from the repository root:

```bash
ruff check .
ruff format --check .    # or `ruff format .` to apply
```

**Frontend** — from **repo root**:

```bash
npm run lint
npm run lint:fix
```

`npm run build` runs `tsc -b` in the workspace.

GitHub Actions (`.github/workflows/lint.yml`) runs Ruff, ESLint, and the production build on push and pull requests.

## Project layout

```text
.
├── package.json           # npm workspaces (includes frontend)
├── package-lock.json      # after npm install at root
├── pyproject.toml         # Ruff (repo-wide)
├── apps/
│   └── api/               # FastAPI backend
│       ├── main.py
│       ├── database.py
│       ├── pdf_processor.py
│       ├── requirements.txt
│       └── requirements-dev.txt
├── frontend/              # React + Vite (workspace package)
│   ├── src/
│   └── package.json
├── data/                  # Runtime (gitignored except .gitkeep)
│   ├── db.sqlite
│   ├── slides/
│   └── originals/
└── static/                # Built SPA (gitignored; from npm run build)
```

## Usage tips

- **Export** — Use the export control in the sidebar to include checked documents in `study_master.txt` (plain text; HTML in notes is stripped for export).
- **Rescan** — Only works when a stored original exists. Older uploads without a copy must be re-imported once.
- **Flattened PDFs** — If highlights are baked into a flat image with no vectors or annotations, extraction may find nothing; the app will warn after upload or rescan.

## Git and data

- **`static/`** is ignored so the repo stays free of build artifacts; CI or deploy steps should run `npm run build`.
- **`data/`** (database, slides, originals) is ignored except optional `.gitkeep` placeholders—**do not commit** personal PDFs or databases unless you intend to.

## License

No license file is included in this repository; add one if you distribute the project.
