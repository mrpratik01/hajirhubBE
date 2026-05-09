# Requirements Document

## Introduction

When an owner or HR manager creates an employee via `POST /api/employees`, the employee currently has no Supabase Auth account and cannot log in to the HajirHub mobile app. This feature introduces universal auth provisioning: every new employee automatically gets a Supabase Auth account with auto-generated email+password credentials at creation time. It is up to the employee whether they use the mobile app — the owner does not need to decide upfront. A separate on-demand endpoint allows back-filling existing employees who were created before this feature. The feature also covers the first-login flow, forced password change, and access suspension.

---

## Glossary

- **Provisioner**: The backend service layer responsible for creating and managing Supabase Auth accounts for employees.
- **Auth_Account**: A row in `auth.users` managed by Supabase Auth, identified by a UUID, email, and password hash.
- **Public_User**: A row in `public.users` that extends `auth.users` with `role`, `org_id`, `employee_id`, and `password_changed`.
- **Employee**: A row in `public.employees` representing a staff member within an organization.
- **Owner**: A user with `role = 'owner'` who manages an organization and its employees.
- **HR_Manager**: A user with `role = 'hr_manager'` who can create and manage employees.
- **Temporary_Password**: An auto-generated password returned once in the API response for the owner to share with the employee. Never stored in the application database.
- **app_access_status**: A field on `public.employees` tracking mobile app access state. Valid transitions: `not_invited` → `invited` → `active` → `suspended`.
- **password_changed**: A boolean field on `public.users` indicating whether the employee has changed their temporary password. Default `false`.
- **fn_handle_new_auth_user**: A Supabase database trigger that auto-creates a `public.users` row when a new `auth.users` row is inserted.
- **supabaseAdmin**: The Supabase service-role client used server-side to bypass RLS and call `auth.admin` APIs.
- **Org**: Short for organization — a tenant in the HajirHub multi-tenant system.

---

## Requirements

### Requirement 1: Universal Auth Provisioning on Employee Creation

**User Story:** As an owner or HR manager, I want every new employee to automatically receive a Supabase Auth account at creation time, so that all employees can use the mobile app without any extra provisioning step.

#### Acceptance Criteria

1. WHEN an owner or HR_Manager calls `POST /api/employees` without an `email` field, THE Provisioner SHALL reject the request with HTTP 422 and the message: `"Email is required to create an employee account"`.
2. WHEN an owner or HR_Manager calls `POST /api/employees` with a valid `email`, THE Provisioner SHALL create both the `employees` row and a Supabase Auth_Account in the same operation.
3. WHEN creating the Auth_Account, THE Provisioner SHALL call `supabaseAdmin.auth.admin.createUser()` with `email`, the generated Temporary_Password, `email_confirm: true`, and `raw_user_meta_data` containing `full_name`, `org_id`, and `role: 'employee'`.
4. WHEN the Auth_Account is created, THE Provisioner SHALL update the `public.users` row (created by `fn_handle_new_auth_user`) to set `org_id`, `role = 'employee'`, `employee_id`, and `password_changed = false`.
5. WHEN the `public.users` row is linked, THE Provisioner SHALL update `employees.user_id` to the new Auth_Account UUID and set `employees.app_access_status` to `'invited'`.
6. WHEN all provisioning steps succeed, THE Provisioner SHALL return the full employee record plus a `credentials` object containing `email` and `temporaryPassword` in plain text — this is the only time the plain-text password is returned.

---

### Requirement 2: Temporary Password Generation

**User Story:** As an owner, I want the auto-generated password to be memorable enough to share verbally with an employee, so that onboarding is fast even without email delivery.

#### Acceptance Criteria

1. THE Provisioner SHALL generate the Temporary_Password using the pattern: `Hajir@{phone_last4}{randomInt}` where `phone_last4` is the last 4 digits of the employee's phone number and `randomInt` is a random integer between 1000 and 9999 (inclusive).
2. THE Provisioner SHALL NOT store the plain-text Temporary_Password in any application database table, log file, or audit record.
3. THE Provisioner SHALL NOT include the Temporary_Password in any log entry — log entries related to provisioning MUST mask the password field entirely.
4. WHEN the Temporary_Password is generated, THE Provisioner SHALL verify it meets Supabase's minimum password requirements (at least 6 characters) before calling `createUser`.

---

### Requirement 3: Atomic Failure Handling

**User Story:** As a system operator, I want partial provisioning failures to be rolled back cleanly, so that orphaned auth accounts do not accumulate in Supabase Auth.

#### Acceptance Criteria

1. IF the Auth_Account is created successfully but the subsequent `public.users` update fails, THEN THE Provisioner SHALL attempt to delete the newly created Auth_Account via `supabaseAdmin.auth.admin.deleteUser()` before returning an error.
2. IF the Auth_Account is created successfully but `employees.user_id` update fails, THEN THE Provisioner SHALL attempt to delete the newly created Auth_Account before returning an error.
3. IF the rollback deletion also fails, THEN THE Provisioner SHALL log a structured error entry containing: `event: 'auth_provision_rollback_failed'`, `orphaned_auth_user_id`, `employee_id`, `org_id`, and `timestamp` — so the orphaned account can be cleaned up manually.
4. WHEN a rollback is triggered, THE Provisioner SHALL return HTTP 500 with the message: `"Employee created but auth provisioning failed. Please contact support."` and include `employee_id` in the response body.
5. THE Provisioner SHALL NOT leave `employees.user_id` pointing to a UUID that does not correspond to a valid, linked `public.users` row.

---

### Requirement 4: Email Uniqueness Conflict Handling

**User Story:** As a system operator, I want the provisioning step to handle duplicate email conflicts gracefully, so that the owner receives a clear error instead of a cryptic 500.

#### Acceptance Criteria

1. WHEN `supabaseAdmin.auth.admin.createUser()` returns an error indicating the email already exists in `auth.users`, THE Provisioner SHALL return HTTP 409 with the message: `"An account with this email already exists. Use a different email for this employee."`.
2. WHEN a duplicate email conflict occurs, THE Provisioner SHALL NOT create the `employees` row — the entire request SHALL be rejected atomically.
3. THE Provisioner SHALL check for email uniqueness before inserting the `employees` row when possible, to avoid creating an employee record that cannot be provisioned.

---

### Requirement 5: On-Demand Auth Provisioning for Existing Employees

**User Story:** As an owner, I want to provision a Supabase Auth account for an existing employee who was created without one, so that I can grant app access to legacy employees or employees whose provisioning previously failed.

#### Acceptance Criteria

1. WHEN an owner or HR_Manager calls `POST /api/employees/:id/provision-auth` with a valid `email` in the request body, THE Provisioner SHALL create a new Auth_Account for that Employee and link it to `public.users` and `employees.user_id`.
2. WHEN provisioning succeeds, THE Provisioner SHALL set `employees.app_access_status` to `'invited'` and return `{ email, temporaryPassword }`.
3. WHEN an owner calls `POST /api/employees/:id/provision-auth` for an Employee whose `user_id` is already set (already provisioned), THE Provisioner SHALL return HTTP 409 with the message: `"This employee already has an auth account"`.
4. WHEN an owner calls `POST /api/employees/:id/provision-auth` for an Employee with `status = 'terminated'`, THE Provisioner SHALL return HTTP 422 with the message: `"Cannot provision access for a terminated employee"`.
5. IF the email provided already exists in `auth.users`, THE Provisioner SHALL return HTTP 409 with the message: `"An account with this email already exists. Use a different email for this employee."`.
6. THE Provisioner SHALL apply the same atomic failure handling (Requirement 3) to on-demand provisioning as to creation-time provisioning.

---

### Requirement 6: First Login and app_access_status Activation

**User Story:** As a system operator, I want the employee's app access status to automatically transition to 'active' on first login, so that the owner can see which employees have successfully onboarded.

#### Acceptance Criteria

1. WHEN an authenticated employee calls `GET /api/auth/me`, THE System SHALL check whether `employees.app_access_status` is `'invited'`.
2. WHEN `app_access_status` is `'invited'`, THE System SHALL update it to `'active'` and set `public.users.last_login_at` to the current timestamp.
3. WHEN `app_access_status` is already `'active'`, THE System SHALL update only `public.users.last_login_at` — no status change is needed.
4. WHEN `GET /api/auth/me` is called, THE System SHALL include `password_changed` in the response so the mobile app can determine whether to show the forced password change screen.
5. WHILE `public.users.password_changed` is `false`, THE mobile app SHALL redirect the employee to the change-password screen before allowing access to any other feature — this is enforced client-side based on the `password_changed` field returned by `GET /api/auth/me`.

---

### Requirement 7: Forced Password Change

**User Story:** As an employee, I want to change my temporary password on first login, so that my account is secure and only I know my password.

#### Acceptance Criteria

1. WHEN an employee calls `PUT /api/auth/change-password` with `{ currentPassword, newPassword }`, THE System SHALL verify the current password is correct by re-authenticating via Supabase before updating.
2. WHEN the password change succeeds, THE System SHALL update `public.users.password_changed` to `true`.
3. WHEN the password change succeeds, THE System SHALL return HTTP 200 with the message: `"Password changed successfully"`.
4. IF the `newPassword` is fewer than 8 characters, THEN THE System SHALL return HTTP 422 with the message: `"Password must be at least 8 characters"`.
5. IF the `currentPassword` is incorrect, THEN THE System SHALL return HTTP 401 with the message: `"Current password is incorrect"`.

---

### Requirement 8: Access Suspension

**User Story:** As an owner, I want to suspend an employee's mobile app access when they are terminated or disciplined, so that they cannot check in after their employment ends.

#### Acceptance Criteria

1. WHEN an owner calls the employee termination endpoint, THE Provisioner SHALL set `employees.app_access_status` to `'suspended'`.
2. WHEN `app_access_status` is set to `'suspended'` and `employees.user_id` is not null, THE Provisioner SHALL call `supabaseAdmin.auth.admin.updateUserById(user_id, { ban_duration: 'none' })` to ban the Supabase Auth user, preventing new sessions.
3. WHEN a suspended employee attempts to call any authenticated API endpoint, THE System SHALL return HTTP 403 with the message: `"Your account access has been suspended. Contact your organization admin."`.
4. WHILE an Employee's `status` is `'terminated'`, THE Provisioner SHALL NOT allow `app_access_status` to be set to any value other than `'suspended'`.
5. WHEN an owner calls `POST /api/employees/:id/provision-auth` for a suspended employee who is not terminated, THE Provisioner SHALL first un-ban the Supabase Auth user via `supabaseAdmin.auth.admin.updateUserById(user_id, { ban_duration: '0' })` and set `app_access_status` to `'invited'`.

---

### Requirement 9: Schema Changes

**User Story:** As a developer, I want the database schema to support the new auth provisioning fields, so that the feature can be implemented without data inconsistencies.

#### Acceptance Criteria

1. THE System SHALL add a `password_changed BOOLEAN NOT NULL DEFAULT FALSE` column to `public.users` if it does not already exist.
2. THE System SHALL ensure `employees.app_access_status` has the constraint: `CHECK (app_access_status IN ('not_invited', 'invited', 'active', 'suspended'))` — this already exists in the schema and MUST NOT be changed.
3. THE System SHALL ensure `employees.user_id` is nullable (FK to `public.users`, `ON DELETE SET NULL`) — this already exists and MUST NOT be changed.

---

### Requirement 10: Audit Logging

**User Story:** As a system operator, I want all auth provisioning events to be logged in a structured format, so that I can diagnose failures and audit account creation history.

#### Acceptance Criteria

1. WHEN the Provisioner successfully creates an Auth_Account, THE Provisioner SHALL write a structured log entry containing: `event: 'auth_provisioned'`, `employee_id`, `auth_user_id`, `org_id`, `email` (domain only, not full address), and `timestamp`.
2. WHEN the Provisioner fails to create an Auth_Account, THE Provisioner SHALL write a structured log entry containing: `event: 'auth_provision_failed'`, `employee_id`, `org_id`, `error_code`, `error_message`, and `timestamp`.
3. WHEN a rollback is triggered, THE Provisioner SHALL write a structured log entry containing: `event: 'auth_provision_rollback'`, `auth_user_id`, `rollback_success` (boolean), and `timestamp`.
4. THE Provisioner SHALL NOT log plain-text passwords, full email addresses, or any Supabase session tokens in any log entry.
