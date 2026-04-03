# Deployment Setup Guide

This app is hosted on Render and deploys automatically via GitHub Actions on every merge to `main`.

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
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `cd apps/api && uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan:** Free
6. Click **"Create Web Service"**
7. Wait for the first deploy to complete (takes 2-4 minutes)

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
5. Visit your Render service URL + `/health` to confirm it's live:
   `https://highlight-reviewer-api.onrender.com/health`
   Expected response: `{"status": "ok"}`

---

## Important Notes on the Free Tier

- **Render free tier spins down** after 15 minutes of inactivity. The first request after spin-down takes ~30 seconds to respond. This is normal.
- **Ephemeral filesystem:** Render's free tier does NOT persist files between deploys or restarts. This means:
  - Your SQLite database (`data/db.sqlite`) will be wiped on every deploy
  - Rendered slide images (`data/slides/`) will be wiped on every deploy
  - **This app is designed for local use.** For persistent cloud hosting, a database migration to PostgreSQL + cloud file storage (e.g. Supabase + Cloudflare R2) would be required.
- For personal/demo use, the free tier works fine as long as you are aware of this limitation.

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
Render runs: pip install -r requirements.txt
       ↓
Render starts: cd apps/api && uvicorn main:app --host 0.0.0.0 --port $PORT
       ↓
Render hits /health to confirm success
       ↓
New version is live
```
