"""Optional Supabase Storage for slide PNGs (deployments without persistent local disk)."""

from __future__ import annotations

import os
from pathlib import Path

STORAGE_PREFIX = "storage:"

_bucket_name = "bella-note-slides"


def _bucket() -> str:
    return (os.environ.get("SUPABASE_STORAGE_BUCKET") or _bucket_name).strip()


def is_enabled() -> bool:
    return bool(
        (os.environ.get("SUPABASE_URL") or "").strip()
        and (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    )


_supabase = None


def _client():
    global _supabase
    if _supabase is None:
        from supabase import create_client

        url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        _supabase = create_client(url, key)
    return _supabase


def object_key(doc_id: int, page_number: int) -> str:
    return f"{doc_id}/page_{page_number}.png"


def db_path_for_page(doc_id: int, page_number: int) -> str:
    """Value stored in slides.image_path when using remote storage."""
    return f"{STORAGE_PREFIX}{object_key(doc_id, page_number)}"


def public_url_from_db_path(image_path: str) -> str:
    """HTTPS URL for a public bucket object."""
    if not image_path.startswith(STORAGE_PREFIX):
        raise ValueError("not a storage path")
    key = image_path[len(STORAGE_PREFIX) :]
    return _client().storage.from_(_bucket()).get_public_url(key)


def upload_pages_from_dir(doc_id: int, slide_dir: Path, total_pages: int) -> None:
    """Upload page_1.png … from slide_dir to Supabase Storage; overwrites if present."""
    sb = _client().storage.from_(_bucket())
    for page in range(1, total_pages + 1):
        local = slide_dir / f"page_{page}.png"
        data = local.read_bytes()
        key = object_key(doc_id, page)
        sb.upload(
            key,
            data,
            file_options={
                "content-type": "image/png",
                "upsert": "true",
            },
        )


def delete_objects_for_paths(image_paths: list[str]) -> None:
    """Remove objects whose DB paths use the storage: prefix."""
    keys = []
    for p in image_paths:
        if p.startswith(STORAGE_PREFIX):
            keys.append(p[len(STORAGE_PREFIX) :])
    if not keys:
        return
    sb = _client().storage.from_(_bucket())
    sb.remove(keys)
