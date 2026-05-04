-- Apply schema changes for storage paths
ALTER TABLE public.employees 
ADD COLUMN IF NOT EXISTS photo_path TEXT;

ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS logo_path TEXT;

ALTER TABLE public.employee_documents 
ADD COLUMN IF NOT EXISTS file_path TEXT;

ALTER TABLE public.employee_documents
ALTER COLUMN file_url DROP NOT NULL;

UPDATE public.employee_documents 
SET file_path = file_url 
WHERE file_path IS NULL AND file_url IS NOT NULL;
