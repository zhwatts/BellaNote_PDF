"""FastAPI app: Bella Note API + static SPA."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
from collections import defaultdict
from contextlib import suppress
from datetime import UTC, datetime
from html import unescape
from pathlib import Path
from typing import Annotated

import database as db
import slide_storage
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pdf_processor import (
    count_pages,
    extract_highlights,
    render_pdf_pages_to_png,
)
from pydantic import BaseModel, Field

# Monorepo root: apps/api/*.py -> parent.parent.parent
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = REPO_ROOT / "static"

app = FastAPI(title="Bella Note")

log = logging.getLogger("bella_note.upload")


def _slide_render_dpi() -> int:
    """Lower DPI on Render (free tier) speeds rasterization and reduces OOM risk."""
    raw = (os.environ.get("SLIDE_RENDER_DPI") or "").strip()
    if raw.isdigit():
        return max(72, min(300, int(raw)))
    if (os.environ.get("RENDER") or "").lower() == "true":
        return 110
    return 150


def _ingest_single_pdf(tmp_path: str, filename: str) -> tuple[dict, list[dict]]:
    """
    Blocking: extract highlights, render slides, DB rows, optional Storage upload.
    Run via asyncio.to_thread so /health stays reachable on a single worker.
    """
    warnings: list[dict] = []
    log.info("ingest start file=%s", filename)
    raw_highlights = extract_highlights(tmp_path)
    total_pages = count_pages(tmp_path)
    by_page = _group_highlights_by_page(raw_highlights)
    highlights_found = sum(len(v) for v in by_page.values())
    log.info("ingest extracted highlights file=%s pages=%s", filename, total_pages)

    doc_id, slide_dir = db.insert_document_record(
        filename=filename,
        original_path=None,
        total_pages=total_pages,
    )
    dpi = _slide_render_dpi()
    try:
        db.ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
        original_copy = db.ORIGINALS_DIR / f"{doc_id}.pdf"
        shutil.copy2(tmp_path, original_copy)
        db.update_document_original_path(doc_id, str(original_copy))

        log.info(
            "ingest rendering PNGs doc_id=%s dpi=%s dir=%s",
            doc_id,
            dpi,
            slide_dir,
        )
        render_pdf_pages_to_png(tmp_path, slide_dir, dpi=dpi)
        log.info("ingest render done doc_id=%s", doc_id)
        if slide_storage.is_enabled():
            log.info(
                "ingest uploading to storage doc_id=%s pages=%s",
                doc_id,
                total_pages,
            )
            slide_storage.upload_pages_from_dir(doc_id, slide_dir, total_pages)
            shutil.rmtree(slide_dir, ignore_errors=True)
            slide_paths = [
                slide_storage.db_path_for_page(doc_id, p)
                for p in range(1, total_pages + 1)
            ]
        else:
            slide_paths = [
                str(slide_dir / f"page_{p}.png")
                for p in range(1, total_pages + 1)
            ]
        db.insert_slides_and_highlights(doc_id, total_pages, slide_paths, by_page)
        log.info("ingest complete doc_id=%s file=%s", doc_id, filename)
    except Exception:
        log.exception("ingest failed doc_id=%s file=%s", doc_id, filename)
        _purge_document_files(doc_id)
        raise

    result = {
        "document_id": doc_id,
        "filename": filename,
        "total_pages": total_pages,
        "highlights_found": highlights_found,
    }
    if highlights_found == 0:
        warnings.append(
            {
                "document_id": doc_id,
                "filename": filename,
                "message": (
                    "No highlight annotations found. If this PDF was "
                    "flattened or rasterized, highlights may be baked "
                    "into the image and cannot be extracted."
                ),
            }
        )
    return result, warnings


@app.get("/health")
def health_check():
    return {"status": "ok — all systems are operational"}


class SlideHideBody(BaseModel):
    hidden: bool


class HighlightImportantBody(BaseModel):
    very_important: bool


class HighlightTextBody(BaseModel):
    text: str = Field(..., max_length=200_000)


class HighlightCreateBody(BaseModel):
    """Initial text (HTML allowed); empty string is OK for a new note."""

    text: str = Field(default="", max_length=200_000)


class DocumentFilenameBody(BaseModel):
    filename: str = Field(..., min_length=1, max_length=500)


class DocumentsReorderBody(BaseModel):
    document_ids: list[int] = Field(..., min_length=1)


def _html_to_plain(html: str) -> str:
    """Strip HTML for plain-text export."""
    if not html:
        return ""
    t = re.sub(r"(?is)<br\s*/?>", "\n", html)
    t = re.sub(r"(?is)</p\s*>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    t = unescape(t)
    return " ".join(t.split())


@app.on_event("startup")
def _startup() -> None:
    logging.getLogger("bella_note").setLevel(logging.INFO)
    db.init_db()


def _group_highlights_by_page(items: list[dict]) -> dict[int, list[str]]:
    by_page: dict[int, list[str]] = defaultdict(list)
    for item in items:
        by_page[int(item["page_number"])].append(item["text"])
    return dict(by_page)


def _purge_document_files(doc_id: int) -> None:
    """Remove DB rows, slide PNG folder or Supabase objects, and stored original PDF."""
    slide_paths = db.get_slide_image_paths_for_document(doc_id)
    slide_storage.delete_objects_for_paths(slide_paths)
    original_path = db.get_document_original_path(doc_id)
    ok, slide_dir = db.delete_document(doc_id)
    if not ok:
        return
    if original_path:
        Path(original_path).unlink(missing_ok=True)
    (db.ORIGINALS_DIR / f"{doc_id}.pdf").unlink(missing_ok=True)
    if slide_dir and slide_dir != "storage":
        p = Path(slide_dir)
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)


@app.post("/upload")
@app.post("/upload/")
async def upload(files: list[UploadFile] = File(...)) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    results: list[dict] = []
    warnings: list[dict] = []

    for file in files:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            warnings.append(
                {
                    "filename": file.filename or "(unknown)",
                    "message": "Skipped: not a .pdf file",
                }
            )
            continue

        suffix = Path(file.filename).suffix or ".pdf"
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(tmp_fd)
        try:
            data = await file.read()
            Path(tmp_path).write_bytes(data)

            # Run CPU/IO-heavy work off the asyncio event loop so /health and
            # other requests are not blocked (avoids Render marking the instance unhealthy).
            result, file_warnings = await asyncio.to_thread(
                _ingest_single_pdf,
                tmp_path,
                file.filename,
            )
            results.append(result)
            warnings.extend(file_warnings)
        finally:
            with suppress(OSError):
                os.unlink(tmp_path)

    return {"results": results, "warnings": warnings}


@app.get("/documents")
def list_documents() -> list[dict]:
    return db.list_documents()


@app.post("/documents/reorder")
@app.post("/documents/reorder/")
def post_documents_reorder(body: DocumentsReorderBody) -> dict:
    """Persist sidebar order (0 = top). Body must list every document id exactly once.

    Both paths are registered so POST is not misrouted to StaticFiles (405) when a
    proxy or client uses a trailing slash.
    """
    if len(body.document_ids) != len(set(body.document_ids)):
        raise HTTPException(
            status_code=400, detail="document_ids must not contain duplicates"
        )
    ok = db.reorder_documents(body.document_ids)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="document_ids must list every document exactly once",
        )
    return {"ok": True}


@app.patch("/documents/{doc_id}")
@app.patch("/documents/{doc_id}/")
def patch_document(doc_id: int, body: DocumentFilenameBody) -> dict:
    """Rename the document (display name)."""
    if not db.document_exists(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    fn = body.filename.strip()
    if not fn:
        raise HTTPException(status_code=400, detail="Filename cannot be empty")
    ok = db.set_document_filename(doc_id, fn)
    if not ok:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"id": doc_id, "filename": fn}


@app.get("/documents/{doc_id}/slides")
def get_document_slides(doc_id: int) -> list[dict]:
    if not db.document_exists(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return db.get_slides_with_highlights(doc_id)


@app.get("/slides/{doc_id}/{page_number}", response_model=None)
def get_slide_image(doc_id: int, page_number: int) -> FileResponse | RedirectResponse:
    path = db.get_slide_image_path(doc_id, page_number)
    if not path:
        raise HTTPException(status_code=404, detail="Slide image not found")
    if isinstance(path, str) and path.startswith(slide_storage.STORAGE_PREFIX):
        return RedirectResponse(
            url=slide_storage.public_url_from_db_path(path),
            status_code=302,
        )
    p = Path(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Slide image not found")
    return FileResponse(p, media_type="image/png")


@app.post("/slides/{slide_id}/highlights")
@app.post("/slides/{slide_id}/highlights/")
def create_highlight(slide_id: int, body: HighlightCreateBody) -> dict:
    """Add a manual note / highlight on a slide (same storage as extracted highlights)."""
    hid = db.insert_highlight(slide_id, body.text)
    if hid is None:
        raise HTTPException(status_code=404, detail="Slide not found")
    return {"highlight_id": hid, "slide_id": slide_id, "text": body.text}


@app.patch("/slides/{slide_id}/hide")
@app.patch("/slides/{slide_id}/hide/")
def patch_slide_hide(slide_id: int, body: SlideHideBody) -> dict:
    hidden = body.hidden
    ok = db.set_slide_hidden(slide_id, hidden)
    if not ok:
        raise HTTPException(status_code=404, detail="Slide not found")
    return {"slide_id": slide_id, "hidden": hidden}


@app.patch("/highlights/{highlight_id}/very-important")
@app.patch("/highlights/{highlight_id}/very-important/")
def patch_highlight_important(highlight_id: int, body: HighlightImportantBody) -> dict:
    vi = body.very_important
    ok = db.set_highlight_very_important(highlight_id, vi)
    if not ok:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return {"highlight_id": highlight_id, "very_important": vi}


@app.patch("/highlights/{highlight_id}/text")
@app.patch("/highlights/{highlight_id}/text/")
def patch_highlight_text(highlight_id: int, body: HighlightTextBody) -> dict:
    ok = db.set_highlight_text(highlight_id, body.text)
    if not ok:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return {"highlight_id": highlight_id, "text": body.text}


@app.delete("/highlights/{highlight_id}")
@app.delete("/highlights/{highlight_id}/")
def delete_highlight(highlight_id: int) -> dict:
    ok = db.delete_highlight(highlight_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return {"deleted": highlight_id}


@app.get("/export")
def export_all(
    document_ids: Annotated[list[int] | None, Query()] = None,
) -> PlainTextResponse:
    """
    Export highlights. Omit `document_ids` to include all documents; otherwise
    repeat query param: ?document_ids=1&document_ids=2
    """
    if document_ids is not None:
        document_ids = list(dict.fromkeys(document_ids))

    lines: list[str] = []
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines.append("========================================")
    lines.append("STUDY MASTER DOCUMENT")
    lines.append(f"Generated: {now}")
    lines.append("========================================")
    lines.append("")

    current_doc: str | None = None
    for filename, page_num, text, very_important in db.export_highlights_plain(
        document_ids=document_ids,
    ):
        plain = _html_to_plain(text)
        if filename != current_doc:
            if current_doc is not None:
                lines.append("")
            lines.append(f"━━━ DOCUMENT: {filename} ━━━")
            lines.append("")
            current_doc = filename
        lines.append(f"[Slide {page_num}]")
        if very_important:
            lines.append(f"⭐ STARRED: {plain}")
        else:
            lines.append(f"• {plain}")
        lines.append("")

    body = "\n".join(lines).rstrip() + "\n"
    return PlainTextResponse(
        content=body,
        headers={"Content-Disposition": 'attachment; filename="study_master.txt"'},
        media_type="text/plain; charset=utf-8",
    )


@app.post("/documents/{doc_id}/rescan")
@app.post("/documents/{doc_id}/rescan/")
def rescan_document(doc_id: int) -> dict:
    """Re-extract highlights from the stored PDF (e.g. after deleting false positives)."""
    if not db.document_exists(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    pdf_path = db.resolve_original_pdf_path(doc_id)
    if not pdf_path:
        raise HTTPException(
            status_code=400,
            detail=(
                "No stored PDF for this document. Re-upload the file to enable "
                "rescan (documents added before this feature may not have a copy)."
            ),
        )

    raw_highlights = extract_highlights(str(pdf_path))
    by_page = _group_highlights_by_page(raw_highlights)
    highlights_found = sum(len(v) for v in by_page.values())

    db.clear_highlights_for_document(doc_id)
    db.insert_highlights_for_document(doc_id, by_page)

    warnings: list[dict] = []
    if highlights_found == 0:
        warnings.append(
            {
                "message": (
                    "No highlight annotations found. If this PDF was flattened or "
                    "rasterized, highlights may be baked into the image."
                ),
            }
        )

    return {
        "document_id": doc_id,
        "highlights_found": highlights_found,
        "warnings": warnings,
    }


@app.delete("/documents/{doc_id}")
@app.delete("/documents/{doc_id}/")
def delete_document(doc_id: int) -> dict:
    if not db.document_exists(doc_id):
        raise HTTPException(status_code=404, detail="Document not found")
    _purge_document_files(doc_id)
    return {"deleted": doc_id}


# API routes registered above; static SPA last
if STATIC_DIR.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="static",
    )


def main() -> None:
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
    )


if __name__ == "__main__":
    main()
