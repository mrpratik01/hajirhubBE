# HajirHub Backend — Build Progress

> Last updated: 2026-05-04  
> Stack: Node.js + Express + Supabase (PostgreSQL + Storage)  
> Auth: Supabase JWT — verified server-side via `requireSupabaseUser` middleware

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Built, wired, tested |
| 🔧 | Stub exists / partially built |
| ⏳ | Planned, not started |
| ❌ | Explicitly deferred |

---

## Section A — Authentication

> Auth is handled entirely by Supabase client SDK (React Native / Web).  
> Backend only verifies the JWT — no login/signup endpoints needed.

| What | Status | Notes |
|------|--------|-------|
| JWT verification middleware (`requireSupabaseUser`) | ✅ | `src/middleware/auth.js` |
| Role guard — owner/super_admin (`requireOwnerRole`) | ✅ | `src/middleware/requireOwnerRole.js` |
| Role guard — owner/hr/super_admin (`requireStaffRole`) | ✅ | `src/middleware/requireStaffRole.js` |
| Role guard — admin/super_admin (`requireAdminPlanRole`) | ✅ | `src/middleware/requireAdminRole.js` |

---

## Section B — Users

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/users/me` | Any | ✅ |
| PUT | `/api/users/me` | Any | ✅ |
| GET | `/api/users` | owner, hr_manager, super_admin | ✅ |

**Files:** `src/routes/users.routes.js` · `src/controllers/users.controller.js` · `src/services/users.service.js`

---

## Section C — Organizations

| Method | Route | Role | Status |
|--------|-------|------|--------|
| POST | `/api/organizations` | Any (becomes owner) | ✅ |
| GET | `/api/organizations/me` | owner, hr_manager | ✅ |
| PUT | `/api/organizations/me` | owner | ✅ |
| POST | `/api/organizations/me/logo` | owner | ✅ |
| GET | `/api/organizations/me/subscription` | owner | ✅ |

**Files:** `src/routes/organizations.routes.js` · `src/controllers/organizations.controller.js` · `src/services/organizations.service.js`

**Side effects on create:**
- ✅ Auto-subscribes to `pro` plan (`status = active`)
- ✅ Links creator user to org (`users.org_id`)
- ⏳ Seed default department "General"
- ⏳ Seed default shift "Day Shift" 09:00–17:00

---

## Section D — Departments

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/departments` | owner, hr_manager | ✅ |
| POST | `/api/departments` | owner | ✅ |
| PUT | `/api/departments/:id` | owner | ✅ |
| DELETE | `/api/departments/:id` | owner | ✅ |

**Files:** `src/routes/departments.routes.js` · `src/controllers/departments.controller.js` · `src/services/departments.service.js`

**Notes:**
- ✅ `sort_order` auto-assigned (MAX + 1 per org) — FE never sends it
- ✅ Resequences on delete (no gaps)
- ✅ Org-scoped — cross-tenant writes impossible

---

## Section E — Shifts

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/shifts` | owner, hr_manager | ✅ |
| POST | `/api/shifts` | owner | ✅ |
| PUT | `/api/shifts/:id` | owner | ✅ |
| DELETE | `/api/shifts/:id` | owner | ✅ |

**Files:** `src/routes/shifts.routes.js` · `src/controllers/shifts.controller.js` · `src/services/shifts.service.js`

**Notes:**
- ✅ `is_default` enforced as one-per-org (auto-clears previous default)
- ✅ `working_days` bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64

---

## Section F — Workplaces & Geofence

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/workplaces` | owner, hr_manager | ✅ |
| POST | `/api/workplaces` | owner | ✅ |
| GET | `/api/workplaces/:id` | owner, hr_manager | ✅ |
| PUT | `/api/workplaces/:id` | owner | ✅ |
| PUT | `/api/workplaces/:id/geofence` | owner | ✅ |
| GET | `/api/workplaces/:id/qr-token` | owner, hr_manager | ✅ |
| POST | `/api/workplaces/:id/rotate-qr` | owner | ✅ |

**Files:** `src/routes/workplaces.routes.js` · `src/controllers/workplaces.controller.js` · `src/services/workplaces.service.js` · `src/utils/haversine.js`

**Notes:**
- ✅ QR tokens stored in `qr_tokens` table (separate from workplaces)
- ✅ Auto-generates QR token on first GET if none exists
- ✅ Rotate invalidates all existing tokens, increments version
- ✅ `radius_meters` validated 10–500 before DB
- ✅ `haversineDistanceM(lat1, lng1, lat2, lng2)` — returns metres, used in attendance

---

## Section G — Employees

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/employees` | owner, hr_manager | ✅ |
| POST | `/api/employees` | owner | ✅ |
| GET | `/api/employees/me` | Any (employee self-service) | ✅ |
| GET | `/api/employees/:id` | owner, hr_manager | ✅ |
| PUT | `/api/employees/:id` | owner | ✅ |
| PUT | `/api/employees/:id/deactivate` | owner | ✅ |
| PUT | `/api/employees/:id/salary` | owner | ✅ |
| PUT | `/api/employees/:id/shift` | owner | ✅ |
| PUT | `/api/employees/:id/workplace` | owner | ✅ |
| POST | `/api/employees/:id/invite` | owner | ✅ |
| GET | `/api/employees/:id/documents` | owner, hr_manager | ✅ |
| POST | `/api/employees/:id/documents` | owner, hr_manager | ✅ |
| DELETE | `/api/employees/:id/documents/:docId` | owner | ✅ |

**Files:** `src/routes/employees.routes.js` · `src/controllers/employees.controller.js` · `src/services/employees.service.js`

**Notes:**
- ✅ Employee code auto-generated via `fn_next_employee_code(org_id)` → HH-001 format
- ✅ Plan limit validated before create (checks `subscriptions → plans.max_employees`)
- ✅ Leave balances auto-initialized on create (per active `leave_types` for join BS year)
- ✅ Salary updates write to `salary_revisions` table before updating employee snapshot
- ✅ Documents stored in Supabase Storage bucket `employee-docs`
- ✅ Deactivate = soft delete (`status = terminated`, `app_access_status = suspended`)
- ⏳ `POST /api/employees/:id/photo` — profile photo upload (separate from documents)
- ⏳ SMS invite via Sparrow on `invite` endpoint (currently sets status only)

---

## Section H — Subscriptions (Owner-facing)

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/organizations/me/subscription` | owner | ✅ |

**Admin-facing:**

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/admin/subscriptions` | admin, super_admin | ✅ |
| GET | `/api/admin/subscriptions/:id` | admin, super_admin | ✅ |

**Files:** `src/routes/admin.subscriptions.routes.js` · `src/controllers/subscriptions.controller.js` · `src/services/subscriptions.service.js`

---

## Section I — Admin — Plans

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/admin/plans` | admin, super_admin | ✅ |
| POST | `/api/admin/plans` | admin, super_admin | ✅ |
| PUT | `/api/admin/plans/:id` | admin, super_admin | ✅ |
| PATCH | `/api/admin/plans/:id/toggle` | admin, super_admin | ✅ |

**Files:** `src/routes/admin.plans.routes.js` · `src/controllers/plans.controller.js` · `src/services/plans.service.js`

---

## Section J — Admin — Organizations

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/admin/organizations` | admin, super_admin | ✅ |
| GET | `/api/admin/organizations/:id` | admin, super_admin | ✅ |
| PUT | `/api/admin/organizations/:id` | admin, super_admin | ✅ |
| PATCH | `/api/admin/organizations/:id/toggle` | admin, super_admin | ✅ |

**Files:** `src/routes/admin.organizations.routes.js` · `src/controllers/admin.organizations.controller.js`

---

---

## ⏳ Section K — Attendance (Next to Build)

> Most complex section. React Native handles GPS + selfie capture. Backend validates and stores.

| Method | Route | Role | Status |
|--------|-------|------|--------|
| POST | `/api/attendance/checkin` | employee | ⏳ |
| POST | `/api/attendance/checkout` | employee | ⏳ |
| POST | `/api/attendance/qr-checkin` | employee | ⏳ |
| POST | `/api/attendance/sync` | employee | ⏳ |
| GET | `/api/attendance/today` | owner, hr_manager | ⏳ |
| GET | `/api/attendance/monthly` | owner, hr_manager | ⏳ |
| GET | `/api/attendance/employee/:id` | owner, hr_manager | ⏳ |
| PUT | `/api/attendance/:id/manual` | owner | ⏳ |
| GET | `/api/attendance/offline/pending` | owner | ⏳ |
| PUT | `/api/attendance/offline/:logId/approve` | owner | ⏳ |
| PUT | `/api/attendance/offline/:logId/reject` | owner | ⏳ |

**Key logic to build:**
- Haversine geofence check (util already done ✅)
- Selfie upload → Supabase Storage `selfies/{org_id}/{employee_id}/{date_ad}.jpg`
- Late/half-day status calculation using shift times + `org.late_grace_minutes`
- Offline sync dedup via `offline_sync_log.client_record_id`
- 24h offline rejection → owner approval queue

---

## ⏳ Section L — Leave Management

| Method | Route | Role | Status |
|--------|-------|------|--------|
| POST | `/api/leaves/apply` | employee | ⏳ |
| GET | `/api/leaves` | owner, hr_manager | ⏳ |
| GET | `/api/leaves/my` | employee | ⏳ |
| PUT | `/api/leaves/:id/approve` | owner, hr_manager | ⏳ |
| PUT | `/api/leaves/:id/reject` | owner, hr_manager | ⏳ |
| PUT | `/api/leaves/:id/cancel` | employee | ⏳ |
| GET | `/api/leaves/balances/:empId` | owner, hr_manager | ⏳ |
| GET | `/api/leaves/balances/my` | employee | ⏳ |
| GET | `/api/leaves/calendar` | owner, hr_manager | ⏳ |

---

## ⏳ Section M — Notifications

> Internal service, not HTTP endpoints. Called by other services.

| Function | Status |
|----------|--------|
| `sendSMS(phone, message)` — Sparrow SMS | ⏳ |
| `sendWhatsApp(phone, message)` — Twilio | ⏳ |
| `sendPush(expoToken, title, body)` — Expo Push | ⏳ |
| `notify(orgId, employeeId, type, data)` — master dispatcher | ⏳ |
| Morning report (Supabase Edge Function, 10:30 AM NPT) | ⏳ |

---

## ⏳ Section N — Payroll Engine

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/payroll/config` | owner | ⏳ |
| GET | `/api/payroll/tds-slabs` | owner | ⏳ |
| POST | `/api/payroll/run` | owner | ⏳ |
| GET | `/api/payroll/:month` | owner | ⏳ |
| POST | `/api/payroll/:id/finalize` | owner | ⏳ |
| GET | `/api/payroll/:id/payslip/:empId` | owner, employee | ⏳ |
| POST | `/api/advances` | owner | ⏳ |
| GET | `/api/advances/:employeeId` | owner | ⏳ |
| PUT | `/api/advances/:id/repaid` | owner | ⏳ |
| POST | `/api/payroll/festival-bonus/:bsYear` | owner | ⏳ |

---

## ⏳ Section O — Reports

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/reports/ssf-csv` | owner | ⏳ |
| GET | `/api/reports/attendance-excel` | owner | ⏳ |
| GET | `/api/reports/payroll-excel` | owner | ⏳ |
| GET | `/api/reports/tds-annual` | owner | ⏳ |
| GET | `/api/reports/advance-ledger` | owner | ⏳ |
| GET | `/api/reports/leave-balance` | owner | ⏳ |

---

## 🔧 Section P — Hardware (Stubs)

| Method | Route | Role | Status |
|--------|-------|------|--------|
| GET | `/api/hardware/devices` | owner | 🔧 stub |
| POST | `/api/hardware/devices` | owner | 🔧 stub |
| PUT | `/api/hardware/devices/:id` | owner | 🔧 stub |
| POST | `/api/hardware/devices/:id/test` | owner | 🔧 stub |
| POST | `/api/hardware/devices/:id/sync` | owner | 🔧 stub |
| POST | `/api/hardware/hikvision/event` | — | 🔧 stub |

---

---

## Pending Small Tasks

| Task | Status |
|------|--------|
| Seed default department "General" on org create | ⏳ |
| Seed default shift "Day Shift" on org create | ⏳ |
| Seed Nepal leave types on org create | ⏳ |
| `PUT /api/users/me/push-token` — Expo push token update | ⏳ |
| `POST /api/employees/:id/photo` — profile photo upload | ⏳ |
| Supabase Storage bucket policies (selfies = private, logos = public) | ⏳ |
| Seed Nepal public holidays BS 2082 | ⏳ |
| `.env.example` with all required keys | ⏳ |
| CORS config: localhost:3000 + Vercel URL + Expo Go | ⏳ |
| `face_embedding JSONB` column on employees (Phase 2 prep) | ⏳ |
| Rate limiter middleware (`express-rate-limit`) | ⏳ |
| Helmet security headers | ⏳ |
| Morgan HTTP logging | ⏳ |

---

## Route Registration in `app.js`

```
/api/users                    ✅
/api/organizations            ✅
/api/admin/organizations      ✅
/api/admin/plans              ✅
/api/admin/subscriptions      ✅
/api/departments              ✅
/api/shifts                   ✅
/api/workplaces               ✅
/api/employees                ✅
/api/attendance               ⏳
/api/leaves                   ⏳
/api/payroll                  ⏳
/api/advances                 ⏳
/api/reports                  ⏳
/api/hardware                 ⏳
```

---

## Total Endpoint Count

| Status | Count |
|--------|-------|
| ✅ Built | 47 |
| 🔧 Stub | 6 |
| ⏳ Planned | ~40 |
| **Total planned** | **~93** |
