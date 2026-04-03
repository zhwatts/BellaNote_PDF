-- Bella Note: documents, slides, highlights (Postgres / Supabase).
-- Applied on project via Supabase MCP; kept here for version control and CLI workflows.

CREATE TABLE IF NOT EXISTS public.documents (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    original_path TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_pages INTEGER,
    slide_image_dir TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.slides (
    id BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    image_path TEXT,
    has_highlights BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.highlights (
    id BIGSERIAL PRIMARY KEY,
    slide_id BIGINT NOT NULL REFERENCES public.slides (id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
    extracted_text TEXT NOT NULL,
    is_very_important BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slides_document_id ON public.slides (document_id);
CREATE INDEX IF NOT EXISTS idx_highlights_document_id ON public.highlights (document_id);
CREATE INDEX IF NOT EXISTS idx_highlights_slide_id ON public.highlights (slide_id);
