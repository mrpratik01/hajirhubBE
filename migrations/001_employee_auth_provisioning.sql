-- =============================================================================
-- Migration: Employee Auth Provisioning
-- Run this in Supabase SQL Editor before deploying the feature.
-- Safe to re-run — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- 1. Add password_changed column to public.users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Create employee_credentials table
CREATE TABLE IF NOT EXISTS public.employee_credentials (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  email           TEXT        NOT NULL,
  password_hash   TEXT        NOT NULL,   -- bcrypt hash of temporaryPassword, NOT plain text
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  -- is_active = false once employee successfully changes their password
  provisioned_by  UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_emp_creds_employee
  ON public.employee_credentials(employee_id);

CREATE INDEX IF NOT EXISTS idx_emp_creds_org
  ON public.employee_credentials(org_id);

CREATE INDEX IF NOT EXISTS idx_emp_creds_active
  ON public.employee_credentials(employee_id, is_active);

-- 4. updated_at trigger
SELECT fn_attach_updated_at('employee_credentials');
