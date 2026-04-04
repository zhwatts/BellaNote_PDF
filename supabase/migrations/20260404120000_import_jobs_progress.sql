-- Progress fields for GET /import/jobs/:id polling during background ingest

ALTER TABLE public.import_jobs
    ADD COLUMN IF NOT EXISTS progress_current BIGINT,
    ADD COLUMN IF NOT EXISTS progress_total BIGINT,
    ADD COLUMN IF NOT EXISTS progress_label TEXT;
