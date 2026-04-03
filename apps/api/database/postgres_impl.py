"""Postgres backend (e.g. Supabase) when DATABASE_URL is set. Uses direct TCP, not PostgREST."""

from __future__ import annotations

import os
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"
SLIDES_ROOT = DATA_DIR / "slides"
ORIGINALS_DIR = DATA_DIR / "originals"


def _dsn() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    return url


def _serializable_uploaded_at(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def ensure_data_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SLIDES_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)


def init_db() -> None:
    """Verify DB connectivity; schema is applied via Supabase migrations."""
    ensure_data_dirs()
    with psycopg.connect(_dsn()) as conn:
        conn.execute("SELECT 1")


@contextmanager
def get_connection() -> Generator[psycopg.Connection, None, None]:
    ensure_data_dirs()
    conn = psycopg.connect(_dsn(), row_factory=dict_row)
    try:
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
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO documents (
                    filename, original_path, total_pages, slide_image_dir, sort_order
                )
                VALUES (
                    %s, %s, %s, NULL,
                    (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM documents)
                )
                RETURNING id
                """,
                (filename, original_path, total_pages),
            )
            row = cur.fetchone()
            assert row is not None
            doc_id = int(row["id"])
        slide_dir = SLIDES_ROOT / str(doc_id)
        slide_dir.mkdir(parents=True, exist_ok=True)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET slide_image_dir = %s WHERE id = %s",
                (str(slide_dir), doc_id),
            )
        return doc_id, slide_dir


def update_document_original_path(doc_id: int, path: str) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET original_path = %s WHERE id = %s",
                (path, doc_id),
            )


def get_document_original_path(doc_id: int) -> str | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT original_path FROM documents WHERE id = %s",
                (doc_id,),
            )
            row = cur.fetchone()
            if not row or not row["original_path"]:
                return None
            return str(row["original_path"])


def resolve_original_pdf_path(doc_id: int) -> Path | None:
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
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM highlights WHERE document_id = %s", (doc_id,))
            cur.execute(
                "UPDATE slides SET has_highlights = FALSE WHERE document_id = %s",
                (doc_id,),
            )


def insert_highlights_for_document(doc_id: int, highlights_by_page: dict[int, list[str]]) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, page_number FROM slides
                WHERE document_id = %s
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
                        VALUES (%s, %s, %s)
                        """,
                        (slide_id, doc_id, text),
                    )
                cur.execute(
                    "UPDATE slides SET has_highlights = %s WHERE id = %s",
                    (bool(texts), slide_id),
                )


def insert_slides_and_highlights(
    doc_id: int,
    total_pages: int,
    slide_dir: Path,
    highlights_by_page: dict[int, list[str]],
) -> None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            for page_num in range(1, total_pages + 1):
                texts = highlights_by_page.get(page_num, [])
                has_h = bool(texts)
                image_path = str(slide_dir / f"page_{page_num}.png")
                cur.execute(
                    """
                    INSERT INTO slides (document_id, page_number, image_path, has_highlights)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                    """,
                    (doc_id, page_num, image_path, has_h),
                )
                row = cur.fetchone()
                assert row is not None
                slide_id = int(row["id"])
                for text in texts:
                    cur.execute(
                        """
                        INSERT INTO highlights (slide_id, document_id, extracted_text)
                        VALUES (%s, %s, %s)
                        """,
                        (slide_id, doc_id, text),
                    )


def document_exists(doc_id: int) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 AS x FROM documents WHERE id = %s", (doc_id,))
            return cur.fetchone() is not None


def reorder_documents(ordered_ids: list[int]) -> bool:
    if not ordered_ids:
        return False
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM documents")
            existing = {int(r["id"]) for r in cur.fetchall()}
            if set(ordered_ids) != existing or len(ordered_ids) != len(existing):
                return False
            for i, doc_id in enumerate(ordered_ids):
                cur.execute(
                    "UPDATE documents SET sort_order = %s WHERE id = %s",
                    (i, doc_id),
                )
            return True


def set_document_filename(doc_id: int, filename: str) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET filename = %s WHERE id = %s",
                (filename, doc_id),
            )
            return cur.rowcount > 0


def list_documents() -> list[dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.filename, d.uploaded_at, d.total_pages,
                       d.original_path,
                       COUNT(h.id) AS highlight_count
                FROM documents d
                LEFT JOIN highlights h ON h.document_id = d.id
                GROUP BY d.id, d.filename, d.uploaded_at, d.total_pages,
                         d.original_path, d.sort_order
                ORDER BY d.sort_order ASC, d.id ASC
                """
            )
            rows = cur.fetchall()
            return [
                {
                    "id": r["id"],
                    "filename": r["filename"],
                    "uploaded_at": _serializable_uploaded_at(r["uploaded_at"]),
                    "total_pages": r["total_pages"],
                    "highlight_count": int(r["highlight_count"]),
                    "original_stored": r["original_path"] is not None,
                }
                for r in rows
            ]


def get_slides_with_highlights(doc_id: int) -> list[dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, page_number, image_path, has_highlights, is_hidden
                FROM slides
                WHERE document_id = %s
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
                    WHERE slide_id = %s
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
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT image_path FROM slides
                WHERE document_id = %s AND page_number = %s
                """,
                (doc_id, page_number),
            )
            row = cur.fetchone()
            return str(row["image_path"]) if row else None


def set_slide_hidden(slide_id: int, hidden: bool) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE slides SET is_hidden = %s WHERE id = %s",
                (hidden, slide_id),
            )
            return cur.rowcount > 0


def insert_highlight(slide_id: int, text: str) -> int | None:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, document_id FROM slides WHERE id = %s",
                (slide_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            doc_id = int(row["document_id"])
            cur.execute(
                """
                INSERT INTO highlights (slide_id, document_id, extracted_text)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                (slide_id, doc_id, text),
            )
            hid_row = cur.fetchone()
            assert hid_row is not None
            hid = int(hid_row["id"])
            cur.execute(
                "UPDATE slides SET has_highlights = TRUE WHERE id = %s",
                (slide_id,),
            )
            return hid


def set_highlight_very_important(highlight_id: int, very_important: bool) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE highlights SET is_very_important = %s WHERE id = %s",
                (very_important, highlight_id),
            )
            return cur.rowcount > 0


def set_highlight_text(highlight_id: int, text: str) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE highlights SET extracted_text = %s WHERE id = %s",
                (text, highlight_id),
            )
            return cur.rowcount > 0


def delete_highlight(highlight_id: int) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT slide_id FROM highlights WHERE id = %s",
                (highlight_id,),
            )
            row = cur.fetchone()
            if not row:
                return False
            slide_id = row["slide_id"]
            cur.execute("DELETE FROM highlights WHERE id = %s", (highlight_id,))
            cur.execute(
                "SELECT COUNT(*) AS c FROM highlights WHERE slide_id = %s",
                (slide_id,),
            )
            count = int(cur.fetchone()["c"])
            cur.execute(
                "UPDATE slides SET has_highlights = %s WHERE id = %s",
                (count > 0, slide_id),
            )
            return True


def delete_document(doc_id: int) -> tuple[bool, str | None]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT slide_image_dir FROM documents WHERE id = %s",
                (doc_id,),
            )
            row = cur.fetchone()
            if not row:
                return False, None
            slide_dir = row["slide_image_dir"]
            cur.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
            return True, slide_dir


def export_highlights_plain(
    document_ids: list[int] | None = None,
) -> Iterator[tuple[str, int, str, bool]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            if document_ids is not None:
                if not document_ids:
                    return
                placeholders = ",".join(["%s"] * len(document_ids))
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
