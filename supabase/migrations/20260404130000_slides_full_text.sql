-- Full page text per slide (PyMuPDF extraction) for client-side search filtering.
ALTER TABLE public.slides
ADD COLUMN IF NOT EXISTS full_text TEXT;
