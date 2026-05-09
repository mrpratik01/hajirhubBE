-- Employee Credentials Table
-- Stores login credentials for employees with secure password management

CREATE TABLE IF NOT EXISTS public.employee_credentials (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id         UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  user_id             UUID          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  
  -- Login Information
  username            TEXT          NOT NULL,
  email               TEXT          NOT NULL,
  password_hash       TEXT          NOT NULL,           -- SHA-256 hash for verification
  
  -- Temporary Password Management
  temporary_password  TEXT,                              -- Plain text for initial handover
  expires_at          TIMESTAMPTZ,                      -- When temporary password expires
  
  -- Status and Audit
  status              TEXT          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'expired', 'reset')),
  created_by          UUID          REFERENCES public.users(id),
  updated_by          UUID          REFERENCES public.users(id),
  deactivated_at      TIMESTAMPTZ,
  
  -- Timestamps
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_employee_credentials_employee_id ON public.employee_credentials(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_user_id ON public.employee_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_email ON public.employee_credentials(email);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_status ON public.employee_credentials(status);
CREATE INDEX IF NOT EXISTS idx_employee_credentials_expires_at ON public.employee_credentials(expires_at);

-- Unique constraint: one credential set per employee
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_credentials_unique_employee 
ON public.employee_credentials(employee_id) WHERE status = 'active';

-- Unique constraint: unique username per organization
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_credentials_unique_username 
ON public.employee_credentials(username);

-- RLS Policy
ALTER TABLE public.employee_credentials ENABLE ROW LEVEL SECURITY;

-- Policy: Only owners and HR can read credentials
CREATE POLICY "Owners and HR can read employee credentials" ON public.employee_credentials
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users u
      JOIN public.organizations o ON o.id = u.org_id
      WHERE u.id = auth.uid()
      AND (u.role = 'owner' OR u.role = 'hr')
      AND o.id = (
        SELECT e.org_id FROM public.employees e
        WHERE e.id = employee_credentials.employee_id
      )
    )
  );

-- Policy: Only owners and HR can manage credentials
CREATE POLICY "Owners and HR can manage employee credentials" ON public.employee_credentials
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      JOIN public.organizations o ON o.id = u.org_id
      WHERE u.id = auth.uid()
      AND (u.role = 'owner' OR u.role = 'hr')
      AND o.id = (
        SELECT e.org_id FROM public.employees e
        WHERE e.id = employee_credentials.employee_id
      )
    )
  );

-- Function to automatically clean up expired temporary passwords
CREATE OR REPLACE FUNCTION public.cleanup_expired_temp_passwords()
RETURNS INTEGER AS $$
DECLARE
  cleaned_count INTEGER;
BEGIN
  UPDATE public.employee_credentials
  SET 
    temporary_password = NULL,
    updated_at = NOW()
  WHERE 
    expires_at IS NOT NULL 
    AND expires_at < NOW()
    AND temporary_password IS NOT NULL;
  
  GET DIAGNOSTICS cleaned_count = ROW_COUNT;
  
  RETURN cleaned_count;
END;
$$ LANGUAGE plpgsql;

-- Comment
COMMENT ON TABLE public.employee_credentials IS 'Stores secure login credentials for employees with temporary password management';
COMMENT ON COLUMN public.employee_credentials.password_hash IS 'SHA-256 hash of the password for verification';
COMMENT ON COLUMN public.employee_credentials.temporary_password IS 'Plain text temporary password for initial handover, automatically cleared after expiration';
COMMENT ON COLUMN public.employee_credentials.expires_at IS 'When the temporary password expires (typically 7 days for new accounts, 3 days for resets)';
