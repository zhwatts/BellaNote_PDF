-- Public bucket for slide PNGs (optional; also applied via dashboard / MCP).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'bella-note-slides',
    'bella-note-slides',
    true,
    52428800,
    ARRAY['image/png']::text[]
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
