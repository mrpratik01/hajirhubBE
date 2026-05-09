# Implementation Tasks: Employee Auth Provisioning

## Task List

- [x] 1. Run database migrations
  - [x] 1.1 Add `password_changed BOOLEAN NOT NULL DEFAULT FALSE` column to `public.users`
  - [x] 1.2 Create `employee_credentials` table with `id`, `org_id`, `employee_id`, `email`, `password_hash`, `is_active`, `provisioned_by`, `created_at`, `updated_at`
  - [x] 1.3 Add indexes on `employee_credentials(employee_id)` and `employee_credentials(org_id)`

- [x] 2. Install `bcrypt` dependency
  - [x] 2.1 Run `npm install bcrypt`

- [x] 3. Build `provisionAuthAccount` and helpers in `src/services/employees.service.js`
  - [x] 3.1 Implement `generateTempPassword(phone)` — pattern `Hajir@{last4}{rand1000-9999}`
  - [x] 3.2 Implement `provisionAuthAccount(employee, orgId, provisionedBy)` — create auth user, update `public.users`, update `employees.user_id`, store hashed credentials in `employee_credentials`, rollback on failure
  - [x] 3.3 Add rollback logic: on any post-createUser failure call `supabaseAdmin.auth.admin.deleteUser(authUserId)` and emit structured log on rollback failure
  - [x] 3.4 Add structured audit logging: `auth_provisioned`, `auth_provision_failed`, `auth_provision_rollback`

- [x] 4. Update `createEmployee` in `src/services/employees.service.js`
  - [x] 4.1 Make `email` a required field — reject with 422 if missing
  - [x] 4.2 Call `provisionAuthAccount` before inserting the `employees` row (prevents orphaned rows on email conflict)
  - [x] 4.3 Insert `employees` row with `user_id = authUserId` and `app_access_status = 'invited'`
  - [x] 4.4 Back-fill `public.users.employee_id` after employee insert
  - [x] 4.5 Return `{ data: employee, credentials: { email, temporaryPassword } }` from the service

- [x] 5. Update `createEmployee` controller in `src/controllers/employees.controller.js`
  - [x] 5.1 Pass `credentials` through in the `201` response
  - [x] 5.2 Map `EmailConflictError` → 409, `ProvisionError` → 500 with `employee_id` in body

- [x] 6. Implement `provisionExistingEmployee` in `src/services/employees.service.js`
  - [x] 6.1 Guard: `user_id` already set → 409
  - [x] 6.2 Guard: `status === 'terminated'` → 422
  - [x] 6.3 Guard: `app_access_status === 'suspended'` (non-terminated) → un-ban first via `updateUserById({ ban_duration: '0' })`
  - [x] 6.4 Call `provisionAuthAccount` and return `{ email, temporaryPassword }`

- [x] 7. Add `POST /api/employees/:id/provision-auth` endpoint
  - [x] 7.1 Add handler `provisionAuth` to `src/controllers/employees.controller.js`
  - [x] 7.2 Register route in `src/routes/employees.routes.js` — owner only

- [x] 8. Add `GET /api/employees/:id/credentials` endpoint
  - [x] 8.1 Implement `getCredentials(userId, employeeId)` in `src/services/employees.service.js` — queries `employee_credentials`, returns `{ employee_id, email, is_active, provisioned_at }`
  - [x] 8.2 Add handler `getCredentials` to `src/controllers/employees.controller.js`
  - [x] 8.3 Register route in `src/routes/employees.routes.js` — owner + hr_manager

- [x] 9. Build `src/services/auth.service.js`
  - [x] 9.1 Implement `getMe(userId, accessToken)` — look up `public.users` + `employees`, activate `app_access_status` on first call, update `last_login_at`, return profile + `password_changed`
  - [x] 9.2 Implement `changePassword(userId, accessToken, currentPassword, newPassword)` — validate length ≥ 8, re-auth via `signInWithPassword`, update password via admin API, set `password_changed = true`, set `employee_credentials.is_active = false`

- [x] 10. Build `src/controllers/auth.controller.js` and `src/routes/auth.routes.js`
  - [x] 10.1 Add `getMe` handler — `GET /api/auth/me` (any authenticated user)
  - [x] 10.2 Add `changePassword` handler — `PUT /api/auth/change-password` (any authenticated user)
  - [x] 10.3 Register both routes in `src/routes/auth.routes.js` behind `requireSupabaseUser`

- [x] 11. Build `checkSuspension` middleware in `src/middleware/checkSuspension.js`
  - [x] 11.1 Query `employees.app_access_status` by `user_id`
  - [x] 11.2 Return 403 if `suspended`
  - [x] 11.3 Apply middleware to attendance routes and auth routes in respective route files

- [x] 12. Update `deactivateEmployee` in `src/services/employees.service.js`
  - [x] 12.1 After setting `status = 'terminated'` and `app_access_status = 'suspended'`, call `supabaseAdmin.auth.admin.updateUserById(user_id, { ban_duration: 'none' })` if `user_id` is not null

- [x] 13. Back-fill existing employees (migration helper)
  - [x] 13.1 Add a SQL script or endpoint note in `BACKEND_PROGRESS.md` explaining how to run `POST /api/employees/:id/provision-auth` for each existing employee that has no `user_id`
