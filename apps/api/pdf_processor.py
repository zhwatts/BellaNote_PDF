"""PDF highlight extraction: annotations, yellow vector fills, pixmap fallback."""

from __future__ import annotations

import re
from pathlib import Path
from typing import TypedDict

import fitz  # pymupdf
import pdfplumber
from pdf2image import convert_from_path
from PIL import Image


class HighlightItem(TypedDict):
    page_number: int
    text: str


# Lines that should stay on their own row (list / outline markers)
_BULLET_LINE = re.compile(
    r"^(?:"
    r"[•·▪▸]\s*|"
    r"[-*]\s+|"
    r"\d{1,3}\s*[.)]\s+|"
    r"[a-zA-Z]\s*[.)]\s+"
    r")"
)


def normalize_extracted_highlight_text(text: str) -> str:
    """
    Collapse PDF/layout line breaks inside a highlight into a single flowing paragraph.
    Keeps lines that look like bullet or numbered list items on separate rows.
    """
    if not text or not text.strip():
        return text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    blocks: list[str] = []
    buf: list[str] = []

    def flush_buf() -> None:
        nonlocal buf
        if not buf:
            return
        merged = " ".join(w for w in " ".join(buf).split() if w)
        if merged:
            blocks.append(merged)
        buf = []

    for raw in lines:
        s = raw.strip()
        if not s:
            flush_buf()
            continue
        if _BULLET_LINE.match(s):
            flush_buf()
            blocks.append(s)
        else:
            buf.append(s)
    flush_buf()
    return "\n".join(blocks).strip()


def _merge_words_to_text(words: list[tuple]) -> str:
    """Merge pymupdf word tuples into readable text (sorted by reading order)."""
    if not words:
        return ""
    sorted_words = sorted(words, key=lambda w: (round(w[1], 2), round(w[0], 2)))
    lines: list[list[str]] = []
    current_line: list[str] = []
    line_y: float | None = None
    y_tol = 3.0

    for w in sorted_words:
        y0 = float(w[1])
        if line_y is None:
            line_y = y0
        if abs(y0 - line_y) > y_tol:
            if current_line:
                lines.append(current_line)
            current_line = [str(w[4])]
            line_y = y0
        else:
            current_line.append(str(w[4]))
    if current_line:
        lines.append(current_line)

    raw = "\n".join(" ".join(line) for line in lines).strip()
    return normalize_extracted_highlight_text(raw)


def _normalize_fill_to_rgb(
    fill: object,
) -> tuple[float, float, float] | None:
    """Convert MuPDF fill to RGB in 0..1 range."""
    if fill is None:
        return None
    if isinstance(fill, (int, float)):
        g = float(fill)
        return g, g, g
    if isinstance(fill, (tuple, list)):
        t = [float(x) for x in fill]
        if len(t) >= 3:
            return t[0], t[1], t[2]
        if len(t) == 4:
            c, m, y, k = t[0], t[1], t[2], t[3]
            r = (1.0 - c) * (1.0 - k)
            g = (1.0 - m) * (1.0 - k)
            b = (1.0 - y) * (1.0 - k)
            return r, g, b
    return None


def _is_yellow_rgb(r: float, g: float, b: float) -> bool:
    """Highlighter yellow: high R/G, lower B (0..1 RGB)."""
    if r < 0.55 or g < 0.45:
        return False
    if b > 0.65:
        return False
    return (r + g - b) > 0.35


def _is_yellow_rgb_byte(r: int, g: int, b: int) -> bool:
    """Same heuristic for 0..255 pixmap samples."""
    if r < 140 or g < 120:
        return False
    if b > 200:
        return False
    return (r + g) > 280 and (r - b) > 35 and (g - b) > 25


def _merge_rects(rects: list[fitz.Rect], pad: float = 1.0) -> list[fitz.Rect]:
    """Merge overlapping / touching rectangles."""
    if not rects:
        return []
    work = [fitz.Rect(r) for r in rects]
    for i, r in enumerate(work):
        work[i] = r + (-pad, -pad, pad, pad)
    changed = True
    while changed:
        changed = False
        out: list[fitz.Rect] = []
        for r in sorted(work, key=lambda x: (x.y0, x.x0)):
            merged = False
            for j, o in enumerate(out):
                if r.intersects(o) or _rects_near(r, o, pad * 2):
                    out[j] = o | r
                    merged = True
                    changed = True
                    break
            if not merged:
                out.append(r)
        work = out
    return work


def _rects_near(a: fitz.Rect, b: fitz.Rect, tol: float) -> bool:
    """True if expanded rects intersect (catch near-miss merges)."""
    aa = a + (-tol, -tol, tol, tol)
    return aa.intersects(b)


def extract_highlights_pymupdf_annots(pdf_path: str | Path) -> list[HighlightItem]:
    """Extract text from Highlight annotations."""
    path = str(pdf_path)
    out: list[HighlightItem] = []
    doc = fitz.open(path)
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            for annot in page.annots() or []:
                try:
                    if annot.type[1] != "Highlight":
                        continue
                    rect = annot.rect
                    words = page.get_text("words", clip=rect)
                    text = _merge_words_to_text(words)
                    if text:
                        out.append({"page_number": page_index + 1, "text": text})
                except (AttributeError, ValueError, RuntimeError):
                    continue
    finally:
        doc.close()
    return out


def extract_highlights_yellow_drawings(pdf_path: str | Path) -> list[HighlightItem]:
    """
    PowerPoint often exports 'highlights' as yellow filled rectangles (vector paths),
    not PDF Highlight annotations. Detect via page.get_drawings().
    """
    path = str(pdf_path)
    out: list[HighlightItem] = []
    doc = fitz.open(path)
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            page_rect = page.rect
            yellow_rects: list[fitz.Rect] = []
            for d in page.get_drawings():
                fill = d.get("fill")
                rgb = _normalize_fill_to_rgb(fill)
                if rgb is None or not _is_yellow_rgb(*rgb):
                    continue
                r = d.get("rect")
                if r is None:
                    continue
                fr = fitz.Rect(r)
                if fr.width < 2 or fr.height < 2:
                    continue
                # Ignore huge accidental fills (whole page background)
                if fr.get_area() > 0.85 * page_rect.get_area():
                    continue
                yellow_rects.append(fr)

            yellow_rects = _merge_rects(yellow_rects, pad=0.5)
            for fr in yellow_rects:
                words = page.get_text("words", clip=fr)
                text = _merge_words_to_text(words)
                if text:
                    out.append({"page_number": page_index + 1, "text": text})
    finally:
        doc.close()
    return out


def _pixmap_yellow_rects(page: fitz.Page, zoom: float = 2.0) -> list[fitz.Rect]:
    """
    Last resort: find yellow-ish pixels in a rasterized page and map boxes to PDF coords.
    Used when highlights are baked into images or unusual constructs.
    """
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    w, h = pix.width, pix.height
    samples = pix.samples
    stride = w * 3

    row_yellow = [False] * h
    for y in range(h):
        row = samples[y * stride : y * stride + stride]
        for x in range(w):
            i = x * 3
            r, g, b = row[i], row[i + 1], row[i + 2]
            if _is_yellow_rgb_byte(r, g, b):
                row_yellow[y] = True
                break

    bands: list[tuple[int, int]] = []
    y = 0
    while y < h:
        if not row_yellow[y]:
            y += 1
            continue
        y0 = y
        while y < h and row_yellow[y]:
            y += 1
        bands.append((y0, y - 1))

    rects_pdf: list[fitz.Rect] = []
    page_w = page.rect.width
    page_h = page.rect.height
    sx = page_w / float(w)
    sy = page_h / float(h)

    for y0, y1 in bands:
        x_min, x_max = w, 0
        for y in range(y0, y1 + 1):
            row = samples[y * stride : y * stride + stride]
            for x in range(w):
                i = x * 3
                r, g, b = row[i], row[i + 1], row[i + 2]
                if _is_yellow_rgb_byte(r, g, b):
                    if x < x_min:
                        x_min = x
                    if x > x_max:
                        x_max = x
        if x_max < x_min:
            continue
        pad = 2
        x0p = max(0, x_min - pad)
        x1p = min(w - 1, x_max + pad)
        y0p = max(0, y0 - pad)
        y1p = min(h - 1, y1 + pad)
        pr = fitz.Rect(
            x0p * sx,
            y0p * sy,
            (x1p + 1) * sx,
            (y1p + 1) * sy,
        )
        if pr.width > 1 and pr.height > 1:
            rects_pdf.append(pr)

    return _merge_rects(rects_pdf, pad=1.0)


def extract_highlights_yellow_pixmap(pdf_path: str | Path) -> list[HighlightItem]:
    """Pixmap-based yellow region detection + text under each region."""
    path = str(pdf_path)
    out: list[HighlightItem] = []
    doc = fitz.open(path)
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            for pr in _pixmap_yellow_rects(page):
                if pr.get_area() > 0.9 * page.rect.get_area():
                    continue
                words = page.get_text("words", clip=pr)
                text = _merge_words_to_text(words)
                if text:
                    out.append({"page_number": page_index + 1, "text": text})
    finally:
        doc.close()
    return out


def extract_highlights_pdfplumber(pdf_path: str | Path) -> list[HighlightItem]:
    """Fallback: parse Highlight annotations with pdfplumber and bbox text."""
    path = str(pdf_path)
    out: list[HighlightItem] = []
    with pdfplumber.open(path) as pdf:
        for page_index, page in enumerate(pdf.pages):
            annots = page.annots or []
            for annot in annots:
                subtype = annot.get("subtype") or ""
                if str(subtype).replace("/", "").lower() != "highlight":
                    continue
                rect = annot.get("rect") or annot.get("bbox")
                if not rect:
                    continue
                try:
                    if isinstance(rect, (list, tuple)) and len(rect) == 4:
                        bbox = tuple(float(x) for x in rect)
                    else:
                        continue
                    cropped = page.within_bbox(bbox)
                    text = (cropped.extract_text() or "").strip()
                except Exception:
                    text = ""
                if text:
                    text = normalize_extracted_highlight_text(text)
                    out.append({"page_number": page_index + 1, "text": text})
    return out


def _dedupe_items(items: list[HighlightItem]) -> list[HighlightItem]:
    seen: set[tuple[int, str]] = set()
    out: list[HighlightItem] = []
    for it in items:
        key = (int(it["page_number"]), it["text"].strip().lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def extract_highlights(pdf_path: str | Path) -> list[HighlightItem]:
    """
    Extraction order:
    1) PDF Highlight annotations (pymupdf)
    2) Yellow vector fills from get_drawings() (common for PowerPoint exports)
    3) pdfplumber Highlight annotations (secondary)
    4) Pixmap yellow-pixel regions (flattened / unusual PDFs)
    """
    ann = extract_highlights_pymupdf_annots(pdf_path)
    if ann:
        return ann

    draw = extract_highlights_yellow_drawings(pdf_path)
    if draw:
        return _dedupe_items(draw)

    plumb = extract_highlights_pdfplumber(pdf_path)
    if plumb:
        return plumb

    pix = extract_highlights_yellow_pixmap(pdf_path)
    return _dedupe_items(pix)


def count_pages(pdf_path: str | Path) -> int:
    doc = fitz.open(str(pdf_path))
    try:
        return len(doc)
    finally:
        doc.close()


def render_pdf_pages_to_png(
    pdf_path: str | Path,
    output_dir: str | Path,
    dpi: int = 150,
) -> int:
    """
    Render each PDF page to PNG. Files: page_1.png, page_2.png, ...
    Returns total page count.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = str(pdf_path)
    images = convert_from_path(path, dpi=dpi)
    for i, pil_image in enumerate(images):
        dest = out / f"page_{i + 1}.png"
        if isinstance(pil_image, Image.Image):
            pil_image.save(dest, "PNG")
        else:
            pil_image.save(str(dest), "PNG")
    return len(images)
