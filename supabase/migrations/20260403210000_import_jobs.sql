-- Background PDF import jobs (HTTP returns before ingest finishes; client polls GET /import/jobs/:id)

CREATE TABLE IF NOT EXISTS public.import_jobs (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    temp_pdf_path TEXT NOT NULL,
    status TEXT NOT NULL,
    document_id BIGINT REFERENCES public.documents (id) ON DELETE SET NULL,
    error_message TEXT,
    result_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON public.import_jobs (status);
