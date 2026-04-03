"""Data layer: SQLite (local default) or Postgres via DATABASE_URL (e.g. Supabase)."""

from __future__ import annotations

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    # Repo root `.env`, then optional `apps/api/.env` (later does not override existing env).
    load_dotenv(_REPO_ROOT / ".env")
    load_dotenv(_REPO_ROOT / "apps" / "api" / ".env")


_load_dotenv()

if (os.environ.get("DATABASE_URL") or "").strip():
    from .postgres_impl import *  # noqa: F403
else:
    from .sqlite_impl import *  # noqa: F403
