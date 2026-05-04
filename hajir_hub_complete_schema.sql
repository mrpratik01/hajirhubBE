-- =============================================================================
--  HAJIR HUB — Complete Production Database Schema
--  Version    : 2.0
--  Database   : Supabase PostgreSQL
--  Maintainer : Bikal (Backend)
--
--  HOW TO RUN:
--  Paste the entire file into Supabase SQL Editor and execute at once.
--  Safe to re-run — uses IF NOT EXISTS / ON CONFLICT throughout.
--
--  TABLE OF CONTENTS
--  ─────────────────
--  §0   Extensions & Helpers
--  §1   Plans (subscription tiers)
--  §2   Organizations (tenants)
--  §3   Subscriptions & Billing
--  §4   Invoices & Payments
--  §5   Users (extends auth.users)
--  §6   Org Invitations
--  §7   Departments
--  §8   Workplaces & Geofence
--  §9   QR Tokens
--  §10  Shifts
--  §11  Employees
--  §12  Employee Allowances & Documents
--  §13  Attendance
--  §14  Attendance Violations & Offline Sync
--  §15  Public Holidays
--  §16  Leave Types, Balances & Requests
--  §17  Payroll Config & TDS Slabs
--  §18  Salary Advances (Sapathi)
--  §19  Payroll Runs & Items
--  §20  Festival Bonuses
--  §21  Notification Settings & Log
--  §22  Report Exports
--  §23  Audit Logs
--  §24  System Config
--  §25  Sequences & Helper Functions
--  §26  Triggers
--  §27  Row Level Security
--  §28  Seed Data
--  §29  Views
-- =============================================================================


-- =============================================================================
-- §0  EXTENSIONS & HELPERS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Universal updated_at trigger
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Macro to attach the trigger to any table
CREATE OR REPLACE FUNCTION fn_attach_updated_at(tbl TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER trg_%s_updated_at
     BEFORE UPDATE ON public.%s
     FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()',
    tbl, tbl
  );
END;
$$;


-- =============================================================================
-- §1  PLANS
--     Defines subscription tiers, feature flags and hard limits.
--     Super-admin manages these rows — no code change needed to add a tier.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.plans (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT          NOT NULL UNIQUE,   -- 'trial','starter','pro','enterprise'
  display_name            TEXT          NOT NULL,          -- "Starter", "Pro"
  display_name_nepali     TEXT,

  -- Hard limits (-1 = unlimited)
  max_employees           INT           NOT NULL DEFAULT 10,
  max_workplaces          INT           NOT NULL DEFAULT 1,
  max_admin_users         INT           NOT NULL DEFAULT 1,   -- owner + HR managers

  -- Feature flags
  feature_geofence        BOOLEAN       NOT NULL DEFAULT TRUE,
  feature_qr_checkin      BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_offline_sync    BOOLEAN       NOT NULL DEFAULT TRUE,
  feature_payroll         BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_ssf_export      BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_tds_engine      BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_festival_bonus  BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_viber_report    BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_whatsapp_report BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_excel_export    BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_pdf_payslip     BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_multi_branch    BOOLEAN       NOT NULL DEFAULT FALSE,
  feature_api_access      BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Pricing (NPR)
  price_monthly           NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_yearly            NUMERIC(10,2) NOT NULL DEFAULT 0,  -- usually ~15–20% discount
  price_yearly_per_month  NUMERIC(10,2) GENERATED ALWAYS AS (price_yearly / 12) STORED,

  -- Trial
  trial_days              INT           NOT NULL DEFAULT 30,

  is_active               BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order              INT           NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('plans');


-- =============================================================================
-- §2  ORGANIZATIONS
--     One row per business / tenant.  Every other table references org_id.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id                          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Business identity
  name                        TEXT          NOT NULL,
  name_nepali                 TEXT,
  slug                        TEXT          UNIQUE,        -- URL-safe identifier
  pan_no                      CHAR(9),                     -- IRD business PAN
  ssf_reg_no                  TEXT,                        -- SSF employer registration
  ird_reg_no                  TEXT,

  -- Contact
  phone                       TEXT,
  email                       TEXT,
  website                     TEXT,

  -- Address
  address_line1               TEXT,
  address_line2               TEXT,
  ward_no                     INT,
  municipality                TEXT,
  district                    TEXT          NOT NULL DEFAULT 'Kathmandu',
  province                    TEXT          NOT NULL DEFAULT 'Bagmati',

  -- Branding
  logo_url                    TEXT,         -- Supabase Storage: logos/{org_id}/logo.png

  -- Messaging for daily Viber/WhatsApp report
  viber_id                    TEXT,
  whatsapp_no                 TEXT,

  -- Nepal calendar / fiscal config
  fiscal_year_start_month     INT           NOT NULL DEFAULT 4   -- 4 = Shrawan (BS)
                              CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

  -- Attendance defaults (owner can override per org)
  checkin_window_start        TIME          NOT NULL DEFAULT '07:00',
  checkin_window_end          TIME          NOT NULL DEFAULT '11:00',
  late_grace_minutes          INT           NOT NULL DEFAULT 10,
  half_day_threshold_hours    INT           NOT NULL DEFAULT 4,

  -- Security
  geofence_override_pin_hash  TEXT,         -- bcrypt hash of 4-digit PIN
  require_selfie              BOOLEAN       NOT NULL DEFAULT TRUE,

  -- Onboarding
  onboarding_completed        BOOLEAN       NOT NULL DEFAULT FALSE,
  onboarding_step             INT           NOT NULL DEFAULT 1,
  -- Step 1: profile, 2: workplace, 3: first employee, 4: done

  -- Lifecycle
  is_active                   BOOLEAN       NOT NULL DEFAULT TRUE,
  deactivated_at              TIMESTAMPTZ,
  deactivation_reason         TEXT,

  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('organizations');

CREATE INDEX IF NOT EXISTS idx_org_slug     ON public.organizations(slug);
CREATE INDEX IF NOT EXISTS idx_org_pan      ON public.organizations(pan_no);
CREATE INDEX IF NOT EXISTS idx_org_active   ON public.organizations(is_active);


-- =============================================================================
-- §3  SUBSCRIPTIONS
--     One active subscription per organization at a time.
--     History of all past subscriptions preserved in subscription_history.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID          NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id             UUID          NOT NULL REFERENCES public.plans(id),

  -- 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'paused'
  status              TEXT          NOT NULL DEFAULT 'trialing'
                      CHECK (status IN ('trialing','active','past_due','cancelled','expired','paused')),

  -- 'monthly' | 'yearly'
  billing_cycle       TEXT          NOT NULL DEFAULT 'monthly'
                      CHECK (billing_cycle IN ('monthly','yearly')),

  -- Dates
  trial_starts_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  trial_ends_at       TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  current_period_end  TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Price locked at subscription start (NPR)
  locked_price        NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Grace period: days after period_end before features are cut off
  grace_period_days   INT           NOT NULL DEFAULT 7,

  -- Counts at last renewal (for billing audit)
  employee_count_at_renewal INT,

  -- Who did the last action
  last_action         TEXT,         -- 'upgrade','downgrade','cancel','renew'
  last_action_by      UUID,         -- references users
  last_action_at      TIMESTAMPTZ,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('subscriptions');

CREATE INDEX IF NOT EXISTS idx_sub_org    ON public.subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_sub_plan   ON public.subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_sub_status ON public.subscriptions(status);


CREATE TABLE IF NOT EXISTS public.subscription_history (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subscription_id UUID          NOT NULL REFERENCES public.subscriptions(id),
  plan_id         UUID          NOT NULL REFERENCES public.plans(id),
  action          TEXT          NOT NULL,
  -- 'created','upgraded','downgraded','renewed','cancelled','expired','paused','resumed'
  from_plan_id    UUID          REFERENCES public.plans(id),
  from_status     TEXT,
  to_status       TEXT,
  billing_cycle   TEXT,
  price           NUMERIC(10,2),
  notes           TEXT,
  performed_by    UUID,         -- references users
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_history_org ON public.subscription_history(org_id);


-- =============================================================================
-- §4  INVOICES & PAYMENTS
--     Track every billing event and payment attempt.
--     Nepal payment methods: eSewa, Khalti, bank transfer, cash.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subscription_id     UUID          NOT NULL REFERENCES public.subscriptions(id),
  invoice_no          TEXT          NOT NULL UNIQUE,  -- INV-2082-001
  invoice_no_nepali   TEXT,                           -- fiscal year suffix

  -- Billing period this invoice covers
  period_start        TIMESTAMPTZ   NOT NULL,
  period_end          TIMESTAMPTZ   NOT NULL,
  billing_cycle       TEXT          NOT NULL,

  -- Amounts (NPR)
  subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_note       TEXT,
  tax_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,   -- 13% VAT if applicable
  total_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid         NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_due          NUMERIC(10,2)
    GENERATED ALWAYS AS (total_amount - amount_paid) STORED,

  -- Plan snapshot
  plan_name           TEXT          NOT NULL,
  employee_count      INT,

  -- Status
  status              TEXT          NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','paid','partially_paid','overdue','void','waived')),

  issued_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  due_at              TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,

  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('invoices');

CREATE INDEX IF NOT EXISTS idx_invoices_org    ON public.invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due    ON public.invoices(due_at);

-- Invoice line items
CREATE TABLE IF NOT EXISTS public.invoice_items (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id  UUID          NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  description TEXT          NOT NULL,
  quantity    NUMERIC(6,1)  NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL,
  total       NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- Payments: one or more payments can settle an invoice
CREATE TABLE IF NOT EXISTS public.payments (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id        UUID          REFERENCES public.invoices(id),
  subscription_id   UUID          REFERENCES public.subscriptions(id),

  amount            NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency          TEXT          NOT NULL DEFAULT 'NPR',

  -- Payment method: Nepal-specific
  method            TEXT          NOT NULL
    CHECK (method IN ('esewa','khalti','connectips','bank_transfer','cash','free','waived')),

  -- Gateway response fields
  gateway_txn_id    TEXT,         -- eSewa/Khalti transaction ID
  gateway_ref_id    TEXT,         -- our ref sent to gateway
  gateway_response  JSONB,        -- full raw response for audit
  bank_name         TEXT,         -- if bank_transfer
  bank_ref_no       TEXT,

  -- Status
  status            TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','refunded','partially_refunded')),

  paid_at           TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,
  refund_amount     NUMERIC(10,2),
  refund_reason     TEXT,
  failure_reason    TEXT,

  -- Who recorded it (for cash/bank_transfer)
  recorded_by       UUID,
  notes             TEXT,
  receipt_url       TEXT,         -- Supabase Storage

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('payments');

CREATE INDEX IF NOT EXISTS idx_payments_org     ON public.payments(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON public.payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_method  ON public.payments(method);


-- =============================================================================
-- §5  USERS
--     Extends auth.users. Role determines access scope.
--     One user can be owner of one org OR an employee of one org — not both
--     (for MVP; multi-org support would need a separate junction table).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  id                UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  full_name         TEXT        NOT NULL DEFAULT '',
  full_name_nepali  TEXT,
  phone             TEXT        UNIQUE,
  email             TEXT,
  avatar_url        TEXT,

  -- 'super_admin' : HajirHub platform admin
  -- 'owner'       : business owner — full access to their org
  -- 'hr_manager'  : read + approve leaves, generate payslips
  -- 'employee'    : self-service only
  role              TEXT        NOT NULL DEFAULT 'employee'
                    CHECK (role IN ('super_admin','owner','hr_manager','employee')),

  org_id            UUID        REFERENCES public.organizations(id) ON DELETE SET NULL,
  employee_id       UUID,       -- FK set after employees table creation

  -- Push notification
  expo_push_token   TEXT,
  push_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Preferences
  preferred_lang    TEXT        NOT NULL DEFAULT 'en'
                    CHECK (preferred_lang IN ('en','ne')),
  timezone          TEXT        NOT NULL DEFAULT 'Asia/Kathmandu',

  -- Security
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  last_login_ip     INET,
  failed_login_count INT        NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('users');

CREATE INDEX IF NOT EXISTS idx_users_org    ON public.users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_role   ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_users_phone  ON public.users(phone);

-- Auto-create public.users when auth.users is created
CREATE OR REPLACE FUNCTION fn_handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.users (id, full_name, phone, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.phone,
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION fn_handle_new_auth_user();


-- =============================================================================
-- §6  ORG INVITATIONS
--     Owner invites HR managers or pre-registers employees via phone number.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.org_invitations (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invited_by      UUID        NOT NULL REFERENCES public.users(id),
  phone           TEXT        NOT NULL,
  email           TEXT,
  role            TEXT        NOT NULL DEFAULT 'employee'
                  CHECK (role IN ('hr_manager','employee')),
  employee_id     UUID,       -- pre-link to employee record if exists
  token           TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','expired','cancelled')),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at     TIMESTAMPTZ,
  accepted_by     UUID        REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_org   ON public.org_invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON public.org_invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_phone ON public.org_invitations(phone);


-- =============================================================================
-- §7  DEPARTMENTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.departments (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  name_nepali TEXT,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);
SELECT fn_attach_updated_at('departments');
CREATE INDEX IF NOT EXISTS idx_departments_org ON public.departments(org_id);


-- =============================================================================
-- §8  WORKPLACES & GEOFENCE
--     Requires plan.feature_multi_branch for more than 1 workplace.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.workplaces (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name              TEXT          NOT NULL,
  name_nepali       TEXT,
  address           TEXT,
  ward_no           INT,
  municipality      TEXT,
  district          TEXT,
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  radius_meters     INT           NOT NULL DEFAULT 50
                    CHECK (radius_meters BETWEEN 10 AND 500),
  geofence_enabled  BOOLEAN       NOT NULL DEFAULT TRUE,
  qr_enabled        BOOLEAN       NOT NULL DEFAULT FALSE,
  is_primary        BOOLEAN       NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('workplaces');
CREATE INDEX IF NOT EXISTS idx_workplaces_org ON public.workplaces(org_id);


-- =============================================================================
-- §9  QR TOKENS
--     One active token per workplace. Rotated every 90 days.
--     Requires plan.feature_qr_checkin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.qr_tokens (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workplace_id  UUID        NOT NULL REFERENCES public.workplaces(id) ON DELETE CASCADE,
  token         TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  version       INT         NOT NULL DEFAULT 1,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  last_used_at  TIMESTAMPTZ,
  use_count     INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_tokens_workplace ON public.qr_tokens(workplace_id);
CREATE INDEX IF NOT EXISTS idx_qr_tokens_token     ON public.qr_tokens(token);
CREATE INDEX IF NOT EXISTS idx_qr_tokens_active    ON public.qr_tokens(is_active, expires_at);


-- =============================================================================
-- §10  SHIFTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.shifts (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  name_nepali   TEXT,
  start_time    TIME        NOT NULL,
  end_time      TIME        NOT NULL,
  -- Bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64
  -- Default: Mon-Fri = 2+4+8+16+32 = 62
  working_days  INT         NOT NULL DEFAULT 62,
  is_default    BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);
SELECT fn_attach_updated_at('shifts');
CREATE INDEX IF NOT EXISTS idx_shifts_org ON public.shifts(org_id);


-- =============================================================================
-- §11  EMPLOYEES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.employees (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id             UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  employee_code       TEXT          NOT NULL,       -- HH-001, HH-002 ...

  -- Identity
  full_name           TEXT          NOT NULL,
  full_name_nepali    TEXT,
  phone               TEXT          NOT NULL,
  email               TEXT,
  gender              TEXT          CHECK (gender IN ('male','female','other')),
  date_of_birth_bs    TEXT,
  date_of_birth_ad    DATE,

  -- Nepal legal IDs
  citizenship_no      TEXT,
  pan_no              CHAR(9),
  ssf_id              TEXT,
  ssf_enrolled        BOOLEAN       NOT NULL DEFAULT TRUE,

  -- Organization
  department_id       UUID          REFERENCES public.departments(id) ON DELETE SET NULL,
  designation         TEXT,
  shift_id            UUID          REFERENCES public.shifts(id) ON DELETE SET NULL,
  workplace_id        UUID          REFERENCES public.workplaces(id) ON DELETE SET NULL,

  -- Employment dates (BS and AD both stored)
  join_date_bs        TEXT          NOT NULL,
  join_date_ad        DATE          NOT NULL,
  exit_date_bs        TEXT,
  exit_date_ad        DATE,
  termination_reason  TEXT,

  -- Salary (NPR) — snapshot at time of record; payroll uses these values
  basic_salary        NUMERIC(10,2) NOT NULL CHECK (basic_salary >= 0),
  hra                 NUMERIC(10,2) NOT NULL DEFAULT 0,
  travel_allowance    NUMERIC(10,2) NOT NULL DEFAULT 0,
  medical_allowance   NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Tax
  marital_status      TEXT          NOT NULL DEFAULT 'single'
                      CHECK (marital_status IN ('single','couple')),

  -- Bank
  bank_name           TEXT,
  bank_account_no     TEXT,
  bank_branch         TEXT,
  bank_ifsc           TEXT,

  -- Profile photo
  photo_url           TEXT,

  -- Status
  status              TEXT          NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','inactive','terminated')),

  -- App access: invited → pending → active
  app_access_status   TEXT          NOT NULL DEFAULT 'not_invited'
                      CHECK (app_access_status IN ('not_invited','invited','active','suspended')),

  notes               TEXT,
  created_by          UUID          REFERENCES public.users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (org_id, employee_code),
  UNIQUE (org_id, phone)
);
SELECT fn_attach_updated_at('employees');

CREATE INDEX IF NOT EXISTS idx_employees_org    ON public.employees(org_id);
CREATE INDEX IF NOT EXISTS idx_employees_user   ON public.employees(user_id);
CREATE INDEX IF NOT EXISTS idx_employees_dept   ON public.employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON public.employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_shift  ON public.employees(shift_id);

-- Back-fill FK on users → employees
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS fk_users_employee;
ALTER TABLE public.users
  ADD CONSTRAINT fk_users_employee
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;

-- Back-fill FK on users → organizations
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS fk_users_org;
ALTER TABLE public.users
  ADD CONSTRAINT fk_users_org
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

-- Back-fill FK on subscriptions last_action_by
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS fk_sub_action_by;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT fk_sub_action_by
  FOREIGN KEY (last_action_by) REFERENCES public.users(id);


-- Employee auto-increment per org
CREATE TABLE IF NOT EXISTS public.employee_sequences (
  org_id    UUID  PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_seq  INT   NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION fn_next_employee_code(p_org_id UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_seq INT;
BEGIN
  INSERT INTO public.employee_sequences (org_id, last_seq)
  VALUES (p_org_id, 1)
  ON CONFLICT (org_id) DO UPDATE
    SET last_seq = employee_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN 'HH-' || LPAD(v_seq::TEXT, 3, '0');
END;
$$;


-- =============================================================================
-- §12  EMPLOYEE ALLOWANCES & DOCUMENTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.employee_allowances (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  label           TEXT          NOT NULL,
  amount          NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  is_taxable      BOOLEAN       NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  effective_from  DATE,
  effective_to    DATE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('employee_allowances');
CREATE INDEX IF NOT EXISTS idx_emp_allowances_emp ON public.employee_allowances(employee_id);

-- Employee documents (citizenship scan, contract, etc.)
CREATE TABLE IF NOT EXISTS public.employee_documents (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  -- 'citizenship','pan_card','contract','photo','certificate','other'
  doc_type        TEXT        NOT NULL,
  label           TEXT,
  file_url        TEXT        NOT NULL,   -- Supabase Storage
  file_name       TEXT,
  file_size_bytes INT,
  uploaded_by     UUID        REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_emp_docs_employee ON public.employee_documents(employee_id);


-- Salary revision history
CREATE TABLE IF NOT EXISTS public.salary_revisions (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_date_bs TEXT        NOT NULL,
  effective_date_ad DATE        NOT NULL,
  old_basic       NUMERIC(10,2) NOT NULL,
  new_basic       NUMERIC(10,2) NOT NULL,
  old_hra         NUMERIC(10,2),
  new_hra         NUMERIC(10,2),
  reason          TEXT,
  revised_by      UUID          REFERENCES public.users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_salary_rev_employee ON public.salary_revisions(employee_id);


-- =============================================================================
-- §13  ATTENDANCE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.attendance (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id             UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  workplace_id            UUID          REFERENCES public.workplaces(id),
  shift_id                UUID          REFERENCES public.shifts(id),

  -- Date keys (BS primary)
  date_bs                 TEXT          NOT NULL,   -- "2082-01-10"
  date_ad                 DATE          NOT NULL,

  -- Check-in
  check_in_time           TIMESTAMPTZ,
  check_in_lat            DOUBLE PRECISION,
  check_in_lng            DOUBLE PRECISION,
  check_in_accuracy_m     DOUBLE PRECISION,         -- GPS accuracy in metres
  check_in_selfie_url     TEXT,                     -- Supabase Storage
  check_in_device_info    JSONB,                    -- {os, model, appVersion}

  -- Check-out
  check_out_time          TIMESTAMPTZ,
  check_out_lat           DOUBLE PRECISION,
  check_out_lng           DOUBLE PRECISION,
  check_out_selfie_url    TEXT,

  -- Computed
  working_minutes         INT,

  -- Status
  -- present | late | absent | half_day | leave | holiday | weekend | manual
  status                  TEXT          NOT NULL DEFAULT 'absent'
                          CHECK (status IN (
                            'present','late','absent','half_day',
                            'leave','holiday','weekend','manual'
                          )),

  -- Offline
  is_offline_record       BOOLEAN       NOT NULL DEFAULT FALSE,
  offline_created_at      TIMESTAMPTZ,
  client_record_id        TEXT,                     -- device-generated UUID
  synced_at               TIMESTAMPTZ,

  -- Geofence
  geofence_status         TEXT
                          CHECK (geofence_status IN ('inside','outside','skipped','qr')),
  geofence_distance_m     INT,
  geofence_override       BOOLEAN       NOT NULL DEFAULT FALSE,
  override_reason         TEXT,
  override_approved_by    UUID          REFERENCES public.users(id),

  -- QR check-in
  qr_token_id             UUID          REFERENCES public.qr_tokens(id),

  -- Manual correction
  is_manual_correction    BOOLEAN       NOT NULL DEFAULT FALSE,
  correction_by           UUID          REFERENCES public.users(id),
  correction_note         TEXT,
  original_status         TEXT,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (employee_id, date_bs)
);
SELECT fn_attach_updated_at('attendance');

CREATE INDEX IF NOT EXISTS idx_att_org         ON public.attendance(org_id);
CREATE INDEX IF NOT EXISTS idx_att_employee    ON public.attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_att_date_bs     ON public.attendance(date_bs);
CREATE INDEX IF NOT EXISTS idx_att_date_ad     ON public.attendance(date_ad);
CREATE INDEX IF NOT EXISTS idx_att_status      ON public.attendance(status);
CREATE INDEX IF NOT EXISTS idx_att_org_date    ON public.attendance(org_id, date_bs);
CREATE INDEX IF NOT EXISTS idx_att_org_date_ad ON public.attendance(org_id, date_ad);


-- =============================================================================
-- §14  ATTENDANCE VIOLATIONS & OFFLINE SYNC LOG
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.attendance_violations (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id     UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  attendance_id   UUID        REFERENCES public.attendance(id),
  -- 'outside_geofence' | 'offline_too_old' | 'duplicate_checkin' | 'override_used'
  violation_type  TEXT        NOT NULL,
  distance_m      INT,
  allowed_radius_m INT,
  device_lat      DOUBLE PRECISION,
  device_lng      DOUBLE PRECISION,
  resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by     UUID        REFERENCES public.users(id),
  resolved_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_violations_org      ON public.attendance_violations(org_id);
CREATE INDEX IF NOT EXISTS idx_violations_employee ON public.attendance_violations(employee_id);


CREATE TABLE IF NOT EXISTS public.offline_sync_log (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id       UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  client_record_id  TEXT        NOT NULL,
  record_type       TEXT        NOT NULL CHECK (record_type IN ('checkin','checkout')),
  payload           JSONB       NOT NULL,
  offline_timestamp TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 'pending' | 'accepted' | 'rejected' | 'duplicate'
  status            TEXT        NOT NULL DEFAULT 'pending',
  rejection_reason  TEXT,
  attendance_id     UUID        REFERENCES public.attendance(id),
  UNIQUE (employee_id, client_record_id)
);
CREATE INDEX IF NOT EXISTS idx_offline_org    ON public.offline_sync_log(org_id);
CREATE INDEX IF NOT EXISTS idx_offline_status ON public.offline_sync_log(status);


-- =============================================================================
-- §15  PUBLIC HOLIDAYS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.public_holidays (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID        REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- NULL org_id = Nepal national holiday (applies to all orgs)
  date_bs       TEXT        NOT NULL,
  date_ad       DATE        NOT NULL,
  name          TEXT        NOT NULL,
  name_nepali   TEXT,
  is_national   BOOLEAN     NOT NULL DEFAULT TRUE,
  bs_year       INT         NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_holidays_date_bs ON public.public_holidays(date_bs);
CREATE INDEX IF NOT EXISTS idx_holidays_bs_year ON public.public_holidays(bs_year);
CREATE INDEX IF NOT EXISTS idx_holidays_org     ON public.public_holidays(org_id);


-- =============================================================================
-- §16  LEAVE TYPES, BALANCES & REQUESTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.leave_types (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code                    TEXT        NOT NULL,
  -- ANNUAL | SICK | MATERNITY | PATERNITY | MOURNING | UNPAID | CUSTOM
  name                    TEXT        NOT NULL,
  name_nepali             TEXT,
  default_days_per_year   NUMERIC(5,1) NOT NULL DEFAULT 0,
  is_paid                 BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_doc_after_days INT,
  is_carry_forward        BOOLEAN     NOT NULL DEFAULT FALSE,
  max_carry_forward_days  NUMERIC(5,1),
  gender_restriction      TEXT        CHECK (gender_restriction IN ('male','female',NULL)),
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order              INT         NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, code)
);
SELECT fn_attach_updated_at('leave_types');
CREATE INDEX IF NOT EXISTS idx_leave_types_org ON public.leave_types(org_id);


CREATE TABLE IF NOT EXISTS public.leave_balances (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id       UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id     UUID          NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
  bs_year           INT           NOT NULL,
  allocated_days    NUMERIC(5,1)  NOT NULL DEFAULT 0,
  used_days         NUMERIC(5,1)  NOT NULL DEFAULT 0,
  carried_forward   NUMERIC(5,1)  NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_type_id, bs_year)
);
SELECT fn_attach_updated_at('leave_balances');
CREATE INDEX IF NOT EXISTS idx_leave_bal_employee ON public.leave_balances(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_bal_year     ON public.leave_balances(bs_year);


CREATE TABLE IF NOT EXISTS public.leave_requests (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id           UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id         UUID          NOT NULL REFERENCES public.leave_types(id),
  from_date_bs          TEXT          NOT NULL,
  from_date_ad          DATE          NOT NULL,
  to_date_bs            TEXT          NOT NULL,
  to_date_ad            DATE          NOT NULL,
  total_days            NUMERIC(5,1)  NOT NULL,
  reason                TEXT,
  supporting_doc_url    TEXT,
  -- 'pending' | 'approved' | 'rejected' | 'cancelled'
  status                TEXT          NOT NULL DEFAULT 'pending',
  reviewed_by           UUID          REFERENCES public.users(id),
  reviewed_at           TIMESTAMPTZ,
  review_note           TEXT,
  attendance_conflict   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('leave_requests');
CREATE INDEX IF NOT EXISTS idx_leave_req_org      ON public.leave_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_leave_req_employee ON public.leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_req_status   ON public.leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_leave_req_dates    ON public.leave_requests(from_date_ad, to_date_ad);


-- =============================================================================
-- §17  PAYROLL CONFIG & TDS SLABS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payroll_config (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID          REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- NULL = system default; org row overrides it
  ssf_employee_rate       NUMERIC(5,4)  NOT NULL DEFAULT 0.11,
  ssf_employer_rate       NUMERIC(5,4)  NOT NULL DEFAULT 0.20,
  sst_rate                NUMERIC(5,4)  NOT NULL DEFAULT 0.01,
  festival_bonus_months   NUMERIC(4,2)  NOT NULL DEFAULT 1.00,
  effective_from_bs_year  INT           NOT NULL,
  effective_to_bs_year    INT,
  is_active               BOOLEAN       NOT NULL DEFAULT TRUE,
  updated_by              UUID          REFERENCES public.users(id),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, effective_from_bs_year)
);
SELECT fn_attach_updated_at('payroll_config');


CREATE TABLE IF NOT EXISTS public.tds_slabs (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bs_year         INT           NOT NULL,
  marital_status  TEXT          NOT NULL CHECK (marital_status IN ('single','couple')),
  slab_order      INT           NOT NULL,
  income_from     NUMERIC(12,2) NOT NULL,
  income_to       NUMERIC(12,2),           -- NULL = unlimited
  rate            NUMERIC(5,4)  NOT NULL,
  slab_label      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (bs_year, marital_status, slab_order)
);
CREATE INDEX IF NOT EXISTS idx_tds_year ON public.tds_slabs(bs_year, marital_status);


-- =============================================================================
-- §18  SALARY ADVANCES (SAPATHI)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.salary_advances (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id             UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  advance_date_bs         TEXT          NOT NULL,
  advance_date_ad         DATE          NOT NULL,
  reason                  TEXT,
  -- 'pending' | 'deducted' | 'repaid_cash' | 'waived'
  status                  TEXT          NOT NULL DEFAULT 'pending',
  deducted_in_payroll_id  UUID,         -- FK added after payroll_runs
  repaid_at               TIMESTAMPTZ,
  repaid_note             TEXT,
  created_by              UUID          NOT NULL REFERENCES public.users(id),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('salary_advances');
CREATE INDEX IF NOT EXISTS idx_advances_employee ON public.salary_advances(employee_id);
CREATE INDEX IF NOT EXISTS idx_advances_status   ON public.salary_advances(status);
CREATE INDEX IF NOT EXISTS idx_advances_org      ON public.salary_advances(org_id);


-- =============================================================================
-- §19  PAYROLL RUNS & ITEMS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  month_bs              TEXT          NOT NULL,   -- "2082-08"
  month_ad              TEXT          NOT NULL,   -- "2025-11"
  bs_year               INT           NOT NULL,
  bs_month              INT           NOT NULL CHECK (bs_month BETWEEN 1 AND 12),
  -- 'draft' | 'finalized' | 'cancelled'
  status                TEXT          NOT NULL DEFAULT 'draft',
  employee_count        INT           NOT NULL DEFAULT 0,
  -- NPR aggregates
  total_gross           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_basic           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_allowances      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_ssf_employee    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_ssf_employer    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_sst             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tds             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_advances        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net             NUMERIC(14,2) NOT NULL DEFAULT 0,
  payroll_config_id     UUID          REFERENCES public.payroll_config(id),
  run_by                UUID          NOT NULL REFERENCES public.users(id),
  finalized_at          TIMESTAMPTZ,
  finalized_by          UUID          REFERENCES public.users(id),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID          REFERENCES public.users(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, month_bs)
);
SELECT fn_attach_updated_at('payroll_runs');
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org    ON public.payroll_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON public.payroll_runs(status);

-- Now add FK on salary_advances → payroll_runs
ALTER TABLE public.salary_advances
  DROP CONSTRAINT IF EXISTS fk_advances_payroll;
ALTER TABLE public.salary_advances
  ADD CONSTRAINT fk_advances_payroll
  FOREIGN KEY (deducted_in_payroll_id) REFERENCES public.payroll_runs(id);


CREATE TABLE IF NOT EXISTS public.payroll_items (
  id                        UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  payroll_run_id            UUID          NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  org_id                    UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id               UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  -- Attendance summary for the month
  working_days              INT           NOT NULL DEFAULT 0,
  present_days              NUMERIC(5,1)  NOT NULL DEFAULT 0,
  absent_days               NUMERIC(5,1)  NOT NULL DEFAULT 0,
  late_days                 INT           NOT NULL DEFAULT 0,
  half_days                 NUMERIC(5,1)  NOT NULL DEFAULT 0,
  leave_days                NUMERIC(5,1)  NOT NULL DEFAULT 0,
  -- Earnings snapshot
  basic_salary              NUMERIC(10,2) NOT NULL DEFAULT 0,
  hra                       NUMERIC(10,2) NOT NULL DEFAULT 0,
  travel_allowance          NUMERIC(10,2) NOT NULL DEFAULT 0,
  medical_allowance         NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_allowances          NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Prorated earnings
  payable_basic             NUMERIC(10,2) NOT NULL DEFAULT 0,
  payable_allowances        NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross_salary              NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- SSF / SST
  ssf_enrolled              BOOLEAN       NOT NULL DEFAULT TRUE,
  ssf_employee_deduction    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ssf_employer_contribution NUMERIC(10,2) NOT NULL DEFAULT 0,
  sst_deduction             NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- TDS
  annual_taxable_income     NUMERIC(12,2) NOT NULL DEFAULT 0,
  tds_deduction             NUMERIC(10,2) NOT NULL DEFAULT 0,
  tds_slab_applied          TEXT,
  -- Deductions
  advance_deduction         NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_deductions          NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_deductions_note     TEXT,
  total_deductions          NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_salary                NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Payslip delivery
  payslip_pdf_url           TEXT,
  payslip_sent_at           TIMESTAMPTZ,
  payslip_sent_via          TEXT,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (payroll_run_id, employee_id)
);
SELECT fn_attach_updated_at('payroll_items');
CREATE INDEX IF NOT EXISTS idx_payroll_items_run  ON public.payroll_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_emp  ON public.payroll_items(employee_id);


-- =============================================================================
-- §20  FESTIVAL BONUSES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.festival_bonuses (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID          NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id           UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  festival_name         TEXT          NOT NULL,   -- "Dashain 2082"
  bs_year               INT           NOT NULL,
  months_worked         NUMERIC(4,1),
  basic_salary_at_bonus NUMERIC(10,2) NOT NULL,
  calculated_bonus      NUMERIC(10,2) NOT NULL,
  override_amount       NUMERIC(10,2),
  final_bonus           NUMERIC(10,2) NOT NULL,
  tds_on_bonus          NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_bonus             NUMERIC(10,2) NOT NULL,
  -- 'standalone' | 'included_in_payroll'
  payment_mode          TEXT          NOT NULL DEFAULT 'standalone',
  payroll_run_id        UUID          REFERENCES public.payroll_runs(id),
  -- 'draft' | 'finalized' | 'paid'
  status                TEXT          NOT NULL DEFAULT 'draft',
  finalized_by          UUID          REFERENCES public.users(id),
  finalized_at          TIMESTAMPTZ,
  payslip_url           TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, employee_id, festival_name)
);
SELECT fn_attach_updated_at('festival_bonuses');
CREATE INDEX IF NOT EXISTS idx_festival_org ON public.festival_bonuses(org_id);
CREATE INDEX IF NOT EXISTS idx_festival_emp ON public.festival_bonuses(employee_id);


-- =============================================================================
-- §21  NOTIFICATION SETTINGS & LOG
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id                        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                    UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  morning_report_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  morning_report_time       TIME        NOT NULL DEFAULT '10:30',  -- NPT
  viber_enabled             BOOLEAN     NOT NULL DEFAULT FALSE,
  viber_account_id          TEXT,
  whatsapp_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  whatsapp_number           TEXT,
  push_leave_approval       BOOLEAN     NOT NULL DEFAULT TRUE,
  push_payslip_ready        BOOLEAN     NOT NULL DEFAULT TRUE,
  push_late_alert           BOOLEAN     NOT NULL DEFAULT FALSE,
  push_absent_alert         BOOLEAN     NOT NULL DEFAULT FALSE,
  qr_rotation_warning_days  INT         NOT NULL DEFAULT 7,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT fn_attach_updated_at('notification_settings');


CREATE TABLE IF NOT EXISTS public.notification_log (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id         UUID        REFERENCES public.employees(id) ON DELETE SET NULL,
  -- 'viber' | 'whatsapp' | 'push' | 'sms'
  channel             TEXT        NOT NULL,
  notification_type   TEXT        NOT NULL,
  recipient           TEXT        NOT NULL,
  message_preview     TEXT,
  -- 'sent' | 'delivered' | 'failed'
  status              TEXT        NOT NULL DEFAULT 'sent',
  error_message       TEXT,
  provider_message_id TEXT,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_log_org  ON public.notification_log(org_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_sent ON public.notification_log(sent_at DESC);


-- =============================================================================
-- §22  REPORT EXPORTS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.report_exports (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  generated_by    UUID        NOT NULL REFERENCES public.users(id),
  -- 'ssf_csv' | 'attendance_excel' | 'payroll_excel' | 'tds_87k'
  -- 'advance_ledger' | 'leave_balance' | 'late_report' | 'payroll_pdf'
  report_type     TEXT        NOT NULL,
  parameters      JSONB,                  -- {month, year, employee_id, ...}
  file_url        TEXT,
  file_name       TEXT,
  file_size_bytes INT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);
CREATE INDEX IF NOT EXISTS idx_report_exports_org  ON public.report_exports(org_id);
CREATE INDEX IF NOT EXISTS idx_report_exports_type ON public.report_exports(report_type);


-- =============================================================================
-- §23  AUDIT LOGS  (append-only — no update/delete policies)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID        REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id     UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  -- e.g. 'employee.create', 'payroll.finalize', 'subscription.upgrade'
  action      TEXT        NOT NULL,
  table_name  TEXT,
  record_id   UUID,
  old_values  JSONB,
  new_values  JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_org    ON public.audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_table  ON public.audit_logs(table_name, record_id);


-- =============================================================================
-- §24  SYSTEM CONFIG
--     Global key-value store for super-admin runtime config.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.system_config (
  key         TEXT  PRIMARY KEY,
  value       TEXT  NOT NULL,
  description TEXT,
  updated_by  UUID  REFERENCES public.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================================================
-- §25  HELPER FUNCTIONS
-- =============================================================================

-- Get the active plan for a given org
CREATE OR REPLACE FUNCTION fn_get_org_plan(p_org_id UUID)
RETURNS TABLE (
  plan_name TEXT, max_employees INT, max_workplaces INT,
  feature_payroll BOOLEAN, feature_ssf_export BOOLEAN,
  feature_qr_checkin BOOLEAN, feature_viber_report BOOLEAN,
  feature_multi_branch BOOLEAN, feature_excel_export BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.name, p.max_employees, p.max_workplaces,
    p.feature_payroll, p.feature_ssf_export,
    p.feature_qr_checkin, p.feature_viber_report,
    p.feature_multi_branch, p.feature_excel_export
  FROM public.subscriptions s
  JOIN public.plans p ON p.id = s.plan_id
  WHERE s.org_id = p_org_id
    AND s.status IN ('trialing','active','past_due')
  LIMIT 1;
$$;

-- Check if org has access to a specific feature
CREATE OR REPLACE FUNCTION fn_org_has_feature(p_org_id UUID, p_feature TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_val BOOLEAN;
BEGIN
  EXECUTE format(
    'SELECT p.%I FROM public.subscriptions s
     JOIN public.plans p ON p.id = s.plan_id
     WHERE s.org_id = $1 AND s.status IN (''trialing'',''active'',''past_due'')
     LIMIT 1', p_feature
  ) INTO v_val USING p_org_id;
  RETURN COALESCE(v_val, FALSE);
END;
$$;

-- Get current user's org_id (used in RLS)
CREATE OR REPLACE FUNCTION fn_my_org_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT org_id FROM public.users WHERE id = auth.uid();
$$;

-- Get current user's role
CREATE OR REPLACE FUNCTION fn_my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.users WHERE id = auth.uid();
$$;

-- Is current user an owner or HR manager?
CREATE OR REPLACE FUNCTION fn_is_manager()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role IN ('owner','hr_manager','super_admin')
  FROM public.users WHERE id = auth.uid();
$$;

-- Generate invoice number: INV-2082-001
CREATE OR REPLACE FUNCTION fn_next_invoice_no(p_bs_year INT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*)+1 INTO v_count
  FROM public.invoices
  WHERE EXTRACT(YEAR FROM issued_at) = EXTRACT(YEAR FROM NOW());
  RETURN 'INV-' || p_bs_year || '-' || LPAD(v_count::TEXT, 4, '0');
END;
$$;


-- =============================================================================
-- §26  TRIGGERS
-- =============================================================================

-- Auto-create notification_settings row when an org is created
CREATE OR REPLACE FUNCTION fn_init_org_defaults()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Notification settings
  INSERT INTO public.notification_settings (org_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;

  -- Employee sequence
  INSERT INTO public.employee_sequences (org_id, last_seq)
  VALUES (NEW.id, 0)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_init ON public.organizations;
CREATE TRIGGER trg_org_init
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION fn_init_org_defaults();


-- Auto-deduct approved leave from leave_balances
CREATE OR REPLACE FUNCTION fn_update_leave_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Approval: deduct days
  IF NEW.status = 'approved' AND OLD.status = 'pending' THEN
    UPDATE public.leave_balances
    SET used_days  = used_days + NEW.total_days,
        updated_at = NOW()
    WHERE employee_id   = NEW.employee_id
      AND leave_type_id = NEW.leave_type_id
      AND bs_year = EXTRACT(YEAR FROM NEW.from_date_ad)::INT;

  -- Cancellation after approval: refund days
  ELSIF NEW.status = 'cancelled' AND OLD.status = 'approved' THEN
    UPDATE public.leave_balances
    SET used_days  = GREATEST(0, used_days - NEW.total_days),
        updated_at = NOW()
    WHERE employee_id   = NEW.employee_id
      AND leave_type_id = NEW.leave_type_id
      AND bs_year = EXTRACT(YEAR FROM NEW.from_date_ad)::INT;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_balance ON public.leave_requests;
CREATE TRIGGER trg_leave_balance
  AFTER UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION fn_update_leave_balance();


-- Increment QR token use_count on attendance insert via QR
CREATE OR REPLACE FUNCTION fn_increment_qr_use()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qr_token_id IS NOT NULL THEN
    UPDATE public.qr_tokens
    SET use_count    = use_count + 1,
        last_used_at = NOW()
    WHERE id = NEW.qr_token_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qr_use ON public.attendance;
CREATE TRIGGER trg_qr_use
  AFTER INSERT ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION fn_increment_qr_use();


-- =============================================================================
-- §27  ROW LEVEL SECURITY
-- =============================================================================

DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plans','organizations','subscriptions','subscription_history',
    'invoices','invoice_items','payments',
    'users','org_invitations',
    'departments','workplaces','qr_tokens','shifts',
    'employees','employee_sequences','employee_allowances',
    'employee_documents','salary_revisions',
    'attendance','attendance_violations','offline_sync_log',
    'public_holidays',
    'leave_types','leave_balances','leave_requests',
    'payroll_config','tds_slabs',
    'salary_advances','payroll_runs','payroll_items','festival_bonuses',
    'notification_settings','notification_log',
    'report_exports','audit_logs','system_config'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── plans: read-only for all authenticated users ──────────────────────────
CREATE POLICY plans_read ON public.plans
  FOR SELECT USING (is_active = TRUE);

-- ── system_config: super_admin only ──────────────────────────────────────
CREATE POLICY syscfg_read  ON public.system_config FOR SELECT USING (fn_my_role() = 'super_admin');
CREATE POLICY syscfg_write ON public.system_config FOR ALL    USING (fn_my_role() = 'super_admin');

-- ── organizations ─────────────────────────────────────────────────────────
CREATE POLICY orgs_own      ON public.organizations FOR ALL    USING (id = fn_my_org_id());
CREATE POLICY orgs_superadmin ON public.organizations FOR ALL USING (fn_my_role() = 'super_admin');

-- ── subscriptions ─────────────────────────────────────────────────────────
CREATE POLICY subs_own      ON public.subscriptions FOR SELECT USING (org_id = fn_my_org_id());
CREATE POLICY subs_superadmin ON public.subscriptions FOR ALL USING (fn_my_role() = 'super_admin');

-- ── subscription_history ──────────────────────────────────────────────────
CREATE POLICY sub_hist_own  ON public.subscription_history FOR SELECT USING (org_id = fn_my_org_id());

-- ── invoices ─────────────────────────────────────────────────────────────
CREATE POLICY inv_own       ON public.invoices FOR SELECT USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY inv_superadmin ON public.invoices FOR ALL  USING (fn_my_role() = 'super_admin');

-- ── invoice_items ─────────────────────────────────────────────────────────
CREATE POLICY inv_items_own ON public.invoice_items FOR SELECT
  USING (invoice_id IN (SELECT id FROM public.invoices WHERE org_id = fn_my_org_id()));

-- ── payments ──────────────────────────────────────────────────────────────
CREATE POLICY pmts_own      ON public.payments FOR SELECT USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY pmts_superadmin ON public.payments FOR ALL USING (fn_my_role() = 'super_admin');

-- ── users ─────────────────────────────────────────────────────────────────
CREATE POLICY users_self    ON public.users FOR SELECT USING (id = auth.uid());
CREATE POLICY users_update  ON public.users FOR UPDATE USING (id = auth.uid());
CREATE POLICY users_manager ON public.users FOR SELECT
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY users_superadmin ON public.users FOR ALL USING (fn_my_role() = 'super_admin');

-- ── org_invitations ───────────────────────────────────────────────────────
CREATE POLICY inv_own_select ON public.org_invitations FOR SELECT USING (org_id = fn_my_org_id());
CREATE POLICY inv_own_insert ON public.org_invitations FOR INSERT WITH CHECK (org_id = fn_my_org_id() AND fn_is_manager());

-- ── departments ───────────────────────────────────────────────────────────
CREATE POLICY depts_all ON public.departments FOR ALL USING (org_id = fn_my_org_id());

-- ── workplaces ────────────────────────────────────────────────────────────
CREATE POLICY wp_all    ON public.workplaces FOR ALL USING (org_id = fn_my_org_id());

-- ── qr_tokens ─────────────────────────────────────────────────────────────
CREATE POLICY qr_all    ON public.qr_tokens  FOR ALL USING (org_id = fn_my_org_id());

-- ── shifts ────────────────────────────────────────────────────────────────
CREATE POLICY shifts_all ON public.shifts    FOR ALL USING (org_id = fn_my_org_id());

-- ── employees ─────────────────────────────────────────────────────────────
CREATE POLICY emp_manager ON public.employees FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY emp_self    ON public.employees FOR SELECT
  USING (user_id = auth.uid());

-- ── employee_allowances ───────────────────────────────────────────────────
CREATE POLICY emp_allow_manager ON public.employee_allowances FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY emp_allow_self    ON public.employee_allowances FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── employee_documents ────────────────────────────────────────────────────
CREATE POLICY emp_docs_manager ON public.employee_documents FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY emp_docs_self    ON public.employee_documents FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── salary_revisions ──────────────────────────────────────────────────────
CREATE POLICY sal_rev_manager ON public.salary_revisions FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── attendance ────────────────────────────────────────────────────────────
CREATE POLICY att_manager   ON public.attendance FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY att_self_sel  ON public.attendance FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));
CREATE POLICY att_self_ins  ON public.attendance FOR INSERT
  WITH CHECK (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── attendance_violations ─────────────────────────────────────────────────
CREATE POLICY viol_manager  ON public.attendance_violations FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── offline_sync_log ──────────────────────────────────────────────────────
CREATE POLICY offline_org   ON public.offline_sync_log FOR ALL USING (org_id = fn_my_org_id());

-- ── public_holidays ───────────────────────────────────────────────────────
CREATE POLICY holidays_read ON public.public_holidays
  FOR SELECT USING (org_id = fn_my_org_id() OR org_id IS NULL);

-- ── leave_types ───────────────────────────────────────────────────────────
CREATE POLICY lt_all        ON public.leave_types FOR ALL USING (org_id = fn_my_org_id());

-- ── leave_balances ────────────────────────────────────────────────────────
CREATE POLICY lb_manager    ON public.leave_balances FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY lb_self       ON public.leave_balances FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── leave_requests ────────────────────────────────────────────────────────
CREATE POLICY lr_manager    ON public.leave_requests FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY lr_self_sel   ON public.leave_requests FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));
CREATE POLICY lr_self_ins   ON public.leave_requests FOR INSERT
  WITH CHECK (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));
CREATE POLICY lr_self_cancel ON public.leave_requests FOR UPDATE
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
         AND status = 'pending');

-- ── payroll_config ────────────────────────────────────────────────────────
CREATE POLICY pc_read       ON public.payroll_config FOR SELECT
  USING (org_id = fn_my_org_id() OR org_id IS NULL);
CREATE POLICY pc_write      ON public.payroll_config FOR ALL
  USING (org_id = fn_my_org_id() AND fn_my_role() IN ('owner','super_admin'));

-- ── tds_slabs ─────────────────────────────────────────────────────────────
CREATE POLICY tds_read      ON public.tds_slabs FOR SELECT USING (TRUE);
CREATE POLICY tds_write     ON public.tds_slabs FOR ALL   USING (fn_my_role() = 'super_admin');

-- ── salary_advances ───────────────────────────────────────────────────────
CREATE POLICY adv_manager   ON public.salary_advances FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY adv_self      ON public.salary_advances FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── payroll_runs ──────────────────────────────────────────────────────────
CREATE POLICY pr_manager    ON public.payroll_runs FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── payroll_items ─────────────────────────────────────────────────────────
CREATE POLICY pi_manager    ON public.payroll_items FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY pi_self       ON public.payroll_items FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── festival_bonuses ──────────────────────────────────────────────────────
CREATE POLICY fb_manager    ON public.festival_bonuses FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());
CREATE POLICY fb_self       ON public.festival_bonuses FOR SELECT
  USING (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()));

-- ── notification_settings ─────────────────────────────────────────────────
CREATE POLICY ns_manager    ON public.notification_settings FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── notification_log ──────────────────────────────────────────────────────
CREATE POLICY nl_manager    ON public.notification_log FOR SELECT
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── report_exports ────────────────────────────────────────────────────────
CREATE POLICY re_manager    ON public.report_exports FOR ALL
  USING (org_id = fn_my_org_id() AND fn_is_manager());

-- ── audit_logs (select only, no delete) ──────────────────────────────────
CREATE POLICY al_owner      ON public.audit_logs FOR SELECT
  USING (org_id = fn_my_org_id() AND fn_my_role() IN ('owner','super_admin'));


-- =============================================================================
-- §28  SEED DATA
-- =============================================================================

-- Plans
INSERT INTO public.plans (name, display_name, display_name_nepali,
  max_employees, max_workplaces, max_admin_users,
  feature_geofence, feature_qr_checkin, feature_offline_sync,
  feature_payroll, feature_ssf_export, feature_tds_engine,
  feature_festival_bonus, feature_viber_report, feature_whatsapp_report,
  feature_excel_export, feature_pdf_payslip, feature_multi_branch,
  feature_api_access,
  price_monthly, price_yearly, trial_days, sort_order)
VALUES
  -- Free trial: 30 days, attendance only
  ('trial','Free Trial','नि:शुल्क परीक्षण',
   10, 1, 1,
   TRUE,FALSE,TRUE,
   FALSE,FALSE,FALSE,
   FALSE,FALSE,FALSE,
   FALSE,FALSE,FALSE,FALSE,
   0, 0, 30, 0),

  -- Starter: attendance + basic leave
  ('starter','Starter','स्टार्टर',
   25, 1, 2,
   TRUE,TRUE,TRUE,
   FALSE,FALSE,FALSE,
   FALSE,FALSE,FALSE,
   TRUE,FALSE,FALSE,FALSE,
   999, 9990, 0, 1),

  -- Pro: full payroll + SSF + notifications
  ('pro','Pro','प्रो',
   100, 3, 5,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,FALSE,
   2499, 24990, 0, 2),

  -- Enterprise: unlimited
  ('enterprise','Enterprise','इन्टरप्राइज',
   -1, -1, -1,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,
   TRUE,TRUE,TRUE,TRUE,
   4999, 49990, 0, 3)
ON CONFLICT (name) DO NOTHING;


-- TDS Slabs FY 2082/83 (2025/26)
INSERT INTO public.tds_slabs
  (bs_year, marital_status, slab_order, income_from, income_to, rate, slab_label)
VALUES
  (2082,'single',1,       0,  500000, 0.0100,'Up to 5,00,000'),
  (2082,'single',2,  500001,  700000, 0.1000,'5,00,001 – 7,00,000'),
  (2082,'single',3,  700001, 1000000, 0.2000,'7,00,001 – 10,00,000'),
  (2082,'single',4, 1000001, 2000000, 0.3000,'10,00,001 – 20,00,000'),
  (2082,'single',5, 2000001,    NULL, 0.3600,'Above 20,00,000'),
  (2082,'couple',1,       0,  500000, 0.0100,'Up to 5,00,000'),
  (2082,'couple',2,  500001,  700000, 0.1000,'5,00,001 – 7,00,000'),
  (2082,'couple',3,  700001, 1000000, 0.2000,'7,00,001 – 10,00,000'),
  (2082,'couple',4, 1000001, 2000000, 0.3000,'10,00,001 – 20,00,000'),
  (2082,'couple',5, 2000001,    NULL, 0.3600,'Above 20,00,000')
ON CONFLICT DO NOTHING;


-- System default payroll config
INSERT INTO public.payroll_config
  (org_id, ssf_employee_rate, ssf_employer_rate, sst_rate,
   festival_bonus_months, effective_from_bs_year, is_active)
VALUES (NULL, 0.11, 0.20, 0.01, 1.00, 2082, TRUE)
ON CONFLICT DO NOTHING;


-- System config defaults
INSERT INTO public.system_config (key, value, description) VALUES
  ('app_version_min_android', '1.0.0', 'Minimum supported Android app version'),
  ('app_version_min_ios',     '1.0.0', 'Minimum supported iOS app version'),
  ('qr_token_expiry_days',    '90',    'Default QR token validity in days'),
  ('offline_record_max_age_hours', '24', 'Max age of offline attendance records accepted'),
  ('selfie_retention_days',   '90',    'Days to keep selfie images in storage'),
  ('invoice_due_days',        '7',     'Days until invoice is overdue'),
  ('grace_period_days',       '7',     'Days after subscription expiry before access cut'),
  ('nepal_country_code',      '+977',  'Nepal phone country code'),
  ('default_timezone',        'Asia/Kathmandu', 'Default app timezone'),
  ('ssf_portal_url',          'https://sosys.ssf.gov.np', 'SSF portal URL for exports')
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- §29  VIEWS
-- =============================================================================

-- Active subscription with plan details per org
CREATE OR REPLACE VIEW public.v_org_subscription AS
SELECT
  o.id          AS org_id,
  o.name        AS org_name,
  p.name        AS plan_name,
  p.display_name,
  s.status      AS sub_status,
  s.billing_cycle,
  s.trial_ends_at,
  s.current_period_end,
  s.locked_price,
  p.max_employees,
  p.feature_payroll,
  p.feature_ssf_export,
  p.feature_qr_checkin,
  p.feature_viber_report,
  p.feature_excel_export
FROM public.organizations o
LEFT JOIN public.subscriptions s ON s.org_id = o.id
LEFT JOIN public.plans p         ON p.id = s.plan_id;

-- Today's attendance summary (pass org_id in where clause)
CREATE OR REPLACE VIEW public.v_today_attendance AS
SELECT
  a.id, a.org_id, a.employee_id,
  e.employee_code, e.full_name, e.photo_url,
  d.name  AS department,
  e.designation,
  a.date_bs, a.check_in_time, a.check_out_time,
  a.status, a.working_minutes,
  a.geofence_override, a.is_offline_record
FROM public.attendance a
JOIN public.employees   e ON e.id = a.employee_id
LEFT JOIN public.departments d ON d.id = e.department_id;

-- Payslip summary
CREATE OR REPLACE VIEW public.v_payslip_summary AS
SELECT
  pi.id, pi.payroll_run_id, pi.org_id, pi.employee_id,
  e.employee_code, e.full_name, e.pan_no, e.ssf_id,
  pr.month_bs, pr.month_ad, pr.status AS payroll_status,
  pi.gross_salary, pi.ssf_employee_deduction, pi.tds_deduction,
  pi.advance_deduction, pi.total_deductions, pi.net_salary,
  pi.payslip_pdf_url, pi.payslip_sent_at
FROM public.payroll_items pi
JOIN public.employees   e  ON e.id = pi.employee_id
JOIN public.payroll_runs pr ON pr.id = pi.payroll_run_id;

-- Leave balances with names
CREATE OR REPLACE VIEW public.v_leave_balances AS
SELECT
  lb.id, lb.org_id, lb.employee_id,
  e.full_name, e.employee_code,
  lt.name AS leave_type, lt.code AS leave_code,
  lb.bs_year, lb.allocated_days, lb.used_days,
  lb.carried_forward,
  (lb.allocated_days + lb.carried_forward - lb.used_days) AS remaining_days
FROM public.leave_balances lb
JOIN public.employees   e  ON e.id = lb.employee_id
JOIN public.leave_types lt ON lt.id = lb.leave_type_id;

-- Overdue invoices (for super-admin billing dashboard)
CREATE OR REPLACE VIEW public.v_overdue_invoices AS
SELECT
  i.id, i.org_id, o.name AS org_name,
  i.invoice_no, i.total_amount, i.amount_paid, i.amount_due,
  i.due_at, (NOW() - i.due_at) AS overdue_by
FROM public.invoices i
JOIN public.organizations o ON o.id = i.org_id
WHERE i.status IN ('sent','partially_paid')
  AND i.due_at < NOW();


-- =============================================================================
-- FINAL CHECK
-- =============================================================================

SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
