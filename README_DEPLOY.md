<!-- @format -->

# Deployment Setup Guide Instructions

This app is hosted on Render and deploys automatically via GitHub Actions on every merge to `main`.

The **UI and API share one URL**: the build runs `npm run build`, which outputs the Vite app to `static/` at the repo root; FastAPI then serves those files at `/` while API routes (`/documents`, `/upload`, etc.) stay on the same host. Open your Render service base URL (no path) for the Bella Note UI.

**Monorepo note:** The FastAPI app lives in `apps/api/`. The included `render.yaml` and `Procfile` use `cd apps/api && uvicorn main:app ...` so Python imports (`database`, `pdf_processor`) resolve the same way as local development from `apps/api`. If you configure the service manually in the Render dashboard, use that start command (or set **Root Directory** to `apps/api` and use `uvicorn main:app --host 0.0.0.0 --port $PORT`).

---

## One-Time Setup (do this once, in order)

### 1. Push this branch to GitHub

Make sure all the new config files are committed and pushed to your GitHub repo's `main` branch.

### 2. Create the Render Service

1. Go to https://dashboard.render.com
2. Click **"New"** → **"Web Service"**
3. Connect your GitHub account if not already connected
4. Select your repository
5. Render will auto-detect the `render.yaml` — confirm these settings:
   - **Name:** highlight-reviewer-api
   - **Runtime:** Python
   - **Build Command:** `bash scripts/render-build.sh`  
     (runs `npm ci` + `npm run build` → `static/`, then `pip install -r requirements.txt`. Render supplies Node from `package.json` `engines`; do not use `apt-get` in the build — the image is read-only.)
   - **Start Command:** `cd apps/api && uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan:** Free
6. Click **"Create Web Service"**
7. Wait for the first deploy to complete (takes 2-4 minutes)

### 2b. Database on Render (Supabase Postgres)

The API uses **SQLite only when `DATABASE_URL` is unset**. On Render, set a **secret** environment variable:

- **`DATABASE_URL`** — Postgres URI from Supabase (**Settings → Database → Connection string** → **URI**).

**Important (Render / IPv4):** Use **Session pooler** (Session mode), **not** “Direct connection.” The direct host (`db.*.supabase.co` on port **5432**) often resolves to **IPv6**; Render’s network often cannot reach IPv6 (`Network is unreachable`). The **Session pooler** uses a `*.pooler.supabase.com` host and port **6543** (see Supabase UI) and works over **IPv4**. Paste your DB password into the template; keep `?sslmode=require` if shown.

**Slide images (recommended on Render):** Set **`SUPABASE_URL`** (project URL, `https://…supabase.co`) and **`SUPABASE_SERVICE_ROLE_KEY`** (Dashboard → **Project Settings → API**). The app uploads PNGs to the **`bella-note-slides`** bucket and serves them via redirect to a public URL. Create the bucket once in Supabase (or rely on the migration in-repo / dashboard) so uploads succeed.

**PDF uploads “hang” or 503 while uploading:** Render’s free tier has **512 MB RAM** and a **single worker** by default. Heavy PDF processing used to **block the event loop**, so **`/health` failed** during upload and Render returned **503**. The API now runs ingestion in a **background thread** so health checks stay green. If uploads are still slow or time out, set **`SLIDE_RENDER_DPI=100`** (or `96`) in the environment to rasterize faster, or use a smaller PDF / paid instance with more RAM and CPU.

**Local / non-Render:** put variables in a **`.env` file at the repo root** (see `.env.example`); the API loads it automatically via `python-dotenv` when the `database` package imports.

Slide images and uploaded PDFs still live on the service **disk** (ephemeral on the free tier); only **metadata** is in Supabase.

### 3. Get Your Render Deploy Hook URL

1. In your Render service dashboard, go to **Settings**
2. Scroll down to **"Deploy Hooks"**
3. Click **"Add Deploy Hook"**, name it `github-actions`
4. Copy the full URL (it looks like `https://api.render.com/deploy/srv-xxxxx?key=yyyyy`)

### 4. Add the Secret to GitHub

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"**
3. Name: `RENDER_DEPLOY_HOOK_URL`
4. Value: paste the Render deploy hook URL from the previous step
5. Click **"Add secret"**

### 5. Test the Pipeline

1. Make any small change (e.g. add a comment to `main.py`)
2. Commit and push to `main`
3. Go to your GitHub repo → **Actions** tab — you should see the workflow running
4. Once it completes, go to your Render dashboard — a new deploy should be triggered
5. Visit your Render service **root URL** for the UI (e.g. `https://your-service.onrender.com/`).
6. Visit `/health` to confirm the API is live: `https://your-service.onrender.com/health` — expected: `{"status": "ok"}`

---

## Important Notes on the Free Tier

- **Render free tier spins down** after 15 minutes of inactivity. The first request after spin-down takes ~30 seconds to respond. This is normal.
- **Ephemeral filesystem:** Render's free tier does NOT persist files between deploys or restarts. This means:
  - Your SQLite database (`data/db.sqlite`) will be wiped on every deploy
  - Rendered slide images (`data/slides/`) will be wiped on every deploy
  - **This app is designed for local use.** For persistent cloud hosting, a database migration to PostgreSQL + cloud file storage (e.g. Supabase + Cloudflare R2) would be required.
- For personal/demo use, the free tier works fine as long as you are aware of this limitation.
- **Poppler (`pdf2image`):** Native Render Python services do not allow installing system packages during build. If page rendering fails at runtime with errors about `pdftoppm` / Poppler, switch to a **Docker**-based deploy that installs `poppler-utils`, or rely on code paths that use PyMuPDF only.

---

## Deployment Flow (after setup is complete)

```
You push to main
       ↓
GitHub Actions triggers (.github/workflows/deploy.yml)
       ↓
Workflow sends POST to Render Deploy Hook URL
       ↓
Render pulls latest code from GitHub
       ↓
Render runs: bash scripts/render-build.sh (frontend → static/, Python deps)
       ↓
Render starts: cd apps/api && uvicorn main:app --host 0.0.0.0 --port $PORT
       ↓
Render hits /health to confirm success
       ↓
New version is live
```
