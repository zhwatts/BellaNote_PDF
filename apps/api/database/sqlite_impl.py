"""SQLite schema and helpers (WAL mode). Local default when DATABASE_URL is unset."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

# Monorepo root: apps/api/database/*.py -> parents[3]
REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"
DB_PATH = DATA_DIR / "db.sqlite"
SLIDES_ROOT = DATA_DIR / "slides"
ORIGINALS_DIR = DATA_DIR / "originals"
IMPORT_PENDING_DIR = DATA_DIR / "import_pending"

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_path TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_pages INTEGER,
    slide_image_dir TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER REFERENCES documents(id),
    page_number INTEGER NOT NULL,
    image_path TEXT,
    has_highlights BOOLEAN DEFAULT 0,
    is_hidden BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slide_id INTEGER REFERENCES slides(id),
    document_id INTEGER REFERENCES documents(id),
    extracted_text TEXT NOT NULL,
    is_very_important BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    temp_pdf_path TEXT NOT NULL,
    status TEXT NOT NULL,
    document_id INTEGER REFERENCES documents(id),
    error_message TEXT,
    result_json TEXT,
    progress_current INTEGER,
    progress_total INTEGER,
    progress_label TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


def ensure_data_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SLIDES_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
    IMPORT_PENDING_DIR.mkdir(parents=True, exist_ok=True)


def _migrate_import_jobs_progress(conn: sqlite3.Connection) -> None:
    cur = conn.execute("PRAGMA table_info(import_jobs)")
    cols = [row[1] for row in cur.fetchall()]
    if "progress_current" in cols:
        return
    conn.execute("ALTER TABLE import_jobs ADD COLUMN progress_current INTEGER")
    conn.execute("ALTER TABLE import_jobs ADD COLUMN progress_total INTEGER")
    conn.execute("ALTER TABLE import_jobs ADD COLUMN progress_label TEXT")


def _migrate_documents_sort_order(conn: sqlite3.Connection) -> None:
    cur = conn.execute("PRAGMA table_info(documents)")
    cols = [row[1] for row in cur.fetchall()]
    if "sort_order" in cols:
        return
    conn.execute("ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    cur = conn.execute("SELECT id FROM documents ORDER BY uploaded_at DESC, id DESC")
    ids = [int(r[0]) for r in cur.fetchall()]
    for i, doc_id in enumerate(ids):
        conn.execute(
            "UPDATE documents SET sort_order = ? WHERE id = ?",
            (i, doc_id),
        )


def init_db() -> None:
    ensure_data_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(SCHEMA)
        _migrate_documents_sort_order(conn)
        _migrate_import_jobs_progress(conn)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def get_connection() -> Generator[sqlite3.Connection, None, None]:
    ensure_data_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def insert_document_record(
    filename: str,
    original_path: str | None,
    total_pages: int,
) -> tuple[int, Path]:
    """
    Insert documents row, create data/slides/{id}/ (or temp dir for Supabase upload).
    Call render_pdf_pages_to_png into slide_dir, then insert_slides_and_highlights.
    """
    import tempfile

    from slide_storage import is_enabled as _slides_remote

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO documents (
                filename, original_path, total_pages, slide_image_dir, sort_order
            )
            VALUES (
                ?, ?, ?, ?,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM documents)
            )
            """,
            (filename, original_path, total_pages, None),
        )
        doc_id = int(cur.lastrowid)
        if _slides_remote():
            slide_dir = Path(
                tempfile.mkdtemp(prefix=f"bella_slides_{doc_id}_"),
            )
            cur.execute(
                "UPDATE documents SET slide_image_dir = ? WHERE id = ?",
                ("storage", doc_id),
            )
        else:
            slide_dir = SLIDES_ROOT / str(doc_id)
            slide_dir.mkdir(parents=True, exist_ok=True)
            cur.execute(
                "UPDATE documents SET slide_image_dir = ? WHERE id = ?",
                (str(slide_dir), doc_id),
            )
        return doc_id, slide_dir


def update_document_original_path(doc_id: int, path: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE documents SET original_path = ? WHERE id = ?",
            (path, doc_id),
        )


def get_document_original_path(doc_id: int) -> str | None:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT original_path FROM documents WHERE id = ?", (doc_id,))
        row = cur.fetchone()
        if not row or not row["original_path"]:
            return None
        return str(row["original_path"])


def resolve_original_pdf_path(doc_id: int) -> Path | None:
    """Return path to stored PDF if it exists on disk."""
    stored = get_document_original_path(doc_id)
    if stored:
        p = Path(stored)
        if p.is_file():
            return p
    fallback = ORIGINALS_DIR / f"{doc_id}.pdf"
    if fallback.is_file():
        return fallback
    return None


def clear_highlights_for_document(doc_id: int) -> None:
    """Remove all highlight rows and reset has_highlights on slides for a document."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM highlights WHERE document_id = ?", (doc_id,))
        cur.execute(
            "UPDATE slides SET has_highlights = 0 WHERE document_id = ?",
            (doc_id,),
        )


def insert_highlights_for_document(doc_id: int, highlights_by_page: dict[int, list[str]]) -> None:
    """Insert highlights for existing slides (used after rescan)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, page_number FROM slides
            WHERE document_id = ?
            ORDER BY page_number
            """,
            (doc_id,),
        )
        for row in cur.fetchall():
            slide_id = int(row["id"])
            page_num = int(row["page_number"])
            texts = highlights_by_page.get(page_num, [])
            for text in texts:
                cur.execute(
                    """
                    INSERT INTO highlights (slide_id, document_id, extracted_text)
                    VALUES (?, ?, ?)
                    """,
                    (slide_id, doc_id, text),
                )
            cur.execute(
                "UPDATE slides SET has_highlights = ? WHERE id = ?",
                (1 if texts else 0, slide_id),
            )


def insert_slides_and_highlights(
    doc_id: int,
    total_pages: int,
    slide_paths: list[str],
    highlights_by_page: dict[int, list[str]],
) -> None:
    """Insert slide rows and highlights; slide_paths[i] is image for page i+1."""
    if len(slide_paths) != total_pages:
        raise ValueError("slide_paths length must match total_pages")
    with get_connection() as conn:
        cur = conn.cursor()
        for page_num in range(1, total_pages + 1):
            texts = highlights_by_page.get(page_num, [])
            has_h = 1 if texts else 0
            image_path = slide_paths[page_num - 1]
            cur.execute(
                """
                INSERT INTO slides (document_id, page_number, image_path, has_highlights)
                VALUES (?, ?, ?, ?)
                """,
                (doc_id, page_num, image_path, has_h),
            )
            slide_id = int(cur.lastrowid)
            for text in texts:
                cur.execute(
                    """
                    INSERT INTO highlights (slide_id, document_id, extracted_text)
                    VALUES (?, ?, ?)
                    """,
                    (slide_id, doc_id, text),
                )


def get_slide_image_paths_for_document(doc_id: int) -> list[str]:
    """All slides.image_path values for a document (for storage cleanup)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT image_path FROM slides
            WHERE document_id = ?
            ORDER BY page_number
            """,
            (doc_id,),
        )
        return [str(r["image_path"]) for r in cur.fetchall()]


def document_exists(doc_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,))
        return cur.fetchone() is not None


def reorder_documents(ordered_ids: list[int]) -> bool:
    """Set sort_order from the given full list of document ids (0 = top)."""
    if not ordered_ids:
        return False
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM documents")
        existing = {int(r["id"]) for r in cur.fetchall()}
        if set(ordered_ids) != existing or len(ordered_ids) != len(existing):
            return False
        for i, doc_id in enumerate(ordered_ids):
            cur.execute(
                "UPDATE documents SET sort_order = ? WHERE id = ?",
                (i, doc_id),
            )
        return True


def set_document_filename(doc_id: int, filename: str) -> bool:
    """Update the display name (stored in filename column)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE documents SET filename = ? WHERE id = ?",
            (filename, doc_id),
        )
        return cur.rowcount > 0


def list_documents() -> list[dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT d.id, d.filename, d.uploaded_at, d.total_pages,
                   d.original_path,
                   COUNT(h.id) AS highlight_count
            FROM documents d
            LEFT JOIN highlights h ON h.document_id = d.id
            GROUP BY d.id
            ORDER BY d.sort_order ASC, d.id ASC
            """
        )
        rows = cur.fetchall()
        return [
            {
                "id": r["id"],
                "filename": r["filename"],
                "uploaded_at": r["uploaded_at"],
                "total_pages": r["total_pages"],
                "highlight_count": r["highlight_count"],
                "original_stored": r["original_path"] is not None,
            }
            for r in rows
        ]


def get_slides_with_highlights(doc_id: int) -> list[dict[str, Any]]:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, page_number, image_path, has_highlights, is_hidden
            FROM slides
            WHERE document_id = ?
            ORDER BY page_number
            """,
            (doc_id,),
        )
        slides = cur.fetchall()
        out: list[dict[str, Any]] = []
        for s in slides:
            cur.execute(
                """
                SELECT id, extracted_text, is_very_important
                FROM highlights
                WHERE slide_id = ?
                ORDER BY id
                """,
                (s["id"],),
            )
            hl_rows = cur.fetchall()
            highlights = [
                {
                    "id": h["id"],
                    "text": h["extracted_text"],
                    "is_very_important": bool(h["is_very_important"]),
                }
                for h in hl_rows
            ]
            out.append(
                {
                    "slide_id": s["id"],
                    "page_number": s["page_number"],
                    "image_url": f"/slides/{doc_id}/{s['page_number']}",
                    "has_highlights": bool(s["has_highlights"]),
                    "is_hidden": bool(s["is_hidden"]),
                    "highlights": highlights,
                }
            )
        return out


def get_slide_image_path(doc_id: int, page_number: int) -> str | None:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT image_path FROM slides
            WHERE document_id = ? AND page_number = ?
            """,
            (doc_id, page_number),
        )
        row = cur.fetchone()
        return str(row["image_path"]) if row else None


def set_slide_hidden(slide_id: int, hidden: bool) -> bool:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE slides SET is_hidden = ? WHERE id = ?",
            (1 if hidden else 0, slide_id),
        )
        return cur.rowcount > 0


def insert_highlight(slide_id: int, text: str) -> int | None:
    """Insert a highlight row (manual note or future use). Sets slide has_highlights."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, document_id FROM slides WHERE id = ?",
            (slide_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        doc_id = int(row["document_id"])
        cur.execute(
            """
            INSERT INTO highlights (slide_id, document_id, extracted_text)
            VALUES (?, ?, ?)
            """,
            (slide_id, doc_id, text),
        )
        hid = int(cur.lastrowid)
        cur.execute(
            "UPDATE slides SET has_highlights = 1 WHERE id = ?",
            (slide_id,),
        )
        return hid


def set_highlight_very_important(highlight_id: int, very_important: bool) -> bool:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE highlights SET is_very_important = ? WHERE id = ?",
            (1 if very_important else 0, highlight_id),
        )
        return cur.rowcount > 0


def set_highlight_text(highlight_id: int, text: str) -> bool:
    """Update extracted_text (may contain HTML from the rich-text editor)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE highlights SET extracted_text = ? WHERE id = ?",
            (text, highlight_id),
        )
        return cur.rowcount > 0


def delete_highlight(highlight_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT slide_id FROM highlights WHERE id = ?", (highlight_id,))
        row = cur.fetchone()
        if not row:
            return False
        slide_id = row["slide_id"]
        cur.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        cur.execute("SELECT COUNT(*) AS c FROM highlights WHERE slide_id = ?", (slide_id,))
        count = int(cur.fetchone()["c"])
        cur.execute(
            "UPDATE slides SET has_highlights = ? WHERE id = ?",
            (1 if count > 0 else 0, slide_id),
        )
        return True


def delete_document(doc_id: int) -> tuple[bool, str | None]:
    """Delete document rows and return (success, slide_image_dir or None)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT slide_image_dir FROM documents WHERE id = ?", (doc_id,))
        row = cur.fetchone()
        if not row:
            return False, None
        slide_dir = row["slide_image_dir"]
        cur.execute("DELETE FROM highlights WHERE document_id = ?", (doc_id,))
        cur.execute("DELETE FROM slides WHERE document_id = ?", (doc_id,))
        cur.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        return True, slide_dir


def export_highlights_plain(
    document_ids: list[int] | None = None,
) -> Iterator[tuple[str, int, str, bool]]:
    """
    Yield rows: (filename, page_number, text, is_very_important)
    Ordered by sort order, page number, highlight id.
    If document_ids is set, only those documents (empty list yields nothing).
    """
    with get_connection() as conn:
        cur = conn.cursor()
        if document_ids is not None:
            if not document_ids:
                return
            placeholders = ",".join("?" * len(document_ids))
            cur.execute(
                f"""
                SELECT d.filename, s.page_number, h.extracted_text, h.is_very_important
                FROM highlights h
                JOIN documents d ON d.id = h.document_id
                JOIN slides s ON s.id = h.slide_id
                WHERE d.id IN ({placeholders})
                ORDER BY d.sort_order ASC, d.id ASC, s.page_number, h.id
                """,
                document_ids,
            )
        else:
            cur.execute(
                """
                SELECT d.filename, s.page_number, h.extracted_text, h.is_very_important
                FROM highlights h
                JOIN documents d ON d.id = h.document_id
                JOIN slides s ON s.id = h.slide_id
                ORDER BY d.sort_order ASC, d.id ASC, s.page_number, h.id
                """
            )
        for r in cur.fetchall():
            yield (
                r["filename"],
                int(r["page_number"]),
                r["extracted_text"],
                bool(r["is_very_important"]),
            )


def create_import_job(filename: str, temp_pdf_path: str) -> int:
    ensure_data_dirs()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO import_jobs (filename, temp_pdf_path, status)
            VALUES (?, ?, 'pending')
            """,
            (filename, temp_pdf_path),
        )
        return int(cur.lastrowid)


def update_import_job_status(job_id: int, status: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE import_jobs SET status = ? WHERE id = ?",
            (status, job_id),
        )


def update_import_job_document_id(job_id: int, document_id: int) -> None:
    """Link job to documents row as soon as it exists (client hides sidebar dup)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE import_jobs SET document_id = ? WHERE id = ?",
            (document_id, job_id),
        )


def update_import_job_progress(
    job_id: int,
    progress_current: int | None,
    progress_total: int | None,
    progress_label: str | None,
) -> None:
    """Update coarse progress for polling clients (pages, phases)."""
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE import_jobs
            SET progress_current = ?, progress_total = ?, progress_label = ?
            WHERE id = ?
            """,
            (progress_current, progress_total, progress_label, job_id),
        )


def complete_import_job(
    job_id: int,
    document_id: int,
    result: dict[str, Any],
    warnings: list[dict[str, Any]],
) -> None:
    payload = json.dumps({"result": result, "warnings": warnings})
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE import_jobs
            SET status = 'completed', document_id = ?, error_message = NULL, result_json = ?,
                progress_current = NULL, progress_total = NULL, progress_label = NULL
            WHERE id = ?
            """,
            (document_id, payload, job_id),
        )


def fail_import_job(job_id: int, error_message: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE import_jobs
            SET status = 'failed', error_message = ?,
                progress_current = NULL, progress_total = NULL, progress_label = NULL
            WHERE id = ?
            """,
            (error_message[:8000], job_id),
        )


def _import_job_row_to_public(row: sqlite3.Row) -> dict[str, Any]:
    """Map import_jobs row to API shape (shared by get + list)."""
    pc = row["progress_current"]
    pt = row["progress_total"]
    pct: int | None = None
    if pc is not None and pt is not None:
        try:
            c, t = int(pc), int(pt)
            if t > 0:
                pct = min(100, max(0, int(round(100.0 * c / t))))
        except (TypeError, ValueError):
            pass
    out: dict[str, Any] = {
        "job_id": int(row["id"]),
        "filename": row["filename"],
        "status": row["status"],
        "document_id": int(row["document_id"])
        if row["document_id"] is not None
        else None,
        "error_message": row["error_message"],
        "progress_current": int(pc) if pc is not None else None,
        "progress_total": int(pt) if pt is not None else None,
        "progress_label": row["progress_label"],
        "progress_percent": pct,
    }
    if row["result_json"]:
        data = json.loads(row["result_json"])
        out["result"] = data.get("result")
        out["warnings"] = data.get("warnings", [])
    else:
        out["result"] = None
        out["warnings"] = []
    return out


def get_import_job_public(job_id: int) -> dict[str, Any] | None:
    """API-safe job row (no temp path)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, filename, status, document_id, error_message, result_json,
                   progress_current, progress_total, progress_label
            FROM import_jobs WHERE id = ?
            """,
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return _import_job_row_to_public(row)


def list_active_import_jobs() -> list[dict[str, Any]]:
    """Jobs still queued or running (for UI recovery after refresh)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, filename, status, document_id, error_message, result_json,
                   progress_current, progress_total, progress_label
            FROM import_jobs
            WHERE status IN ('pending', 'processing')
            ORDER BY created_at ASC
            """
        )
        return [_import_job_row_to_public(row) for row in cur.fetchall()]


def get_import_job_temp_path(job_id: int) -> tuple[str, str] | None:
    """Return (temp_pdf_path, filename) for worker, or None."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT temp_pdf_path, filename, status FROM import_jobs WHERE id = ?",
            (job_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return (str(row["temp_pdf_path"]), str(row["filename"]))
