# Bella Note — API

FastAPI service: PDF upload, highlight extraction, SQLite persistence, static SPA from repo root `static/`.

Run from this directory (or use `uvicorn main:app` with `PYTHONPATH` / cwd here):

```bash
cd apps/api
source ../../venv/bin/activate   # or your venv
pip install -r requirements.txt
python main.py
```

Data directory: **`../../data/`** (repo root). Build the UI from repo root: `npm run build`.
