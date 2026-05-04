# HajirHub API Guide

**Base URL:** `https://<your-domain>/api`  
**Auth:** Every request (except `/health`) requires a Supabase JWT in the header:
```
Authorization: Bearer <supabase_access_token>
```
All responses are `application/json` unless noted otherwise.

---

## Roles

| Role | Description |
|------|-------------|
| `owner` | Business owner — full access to their org |
| `hr_manager` | Read + approve leaves, manage employees |
| `employee` | Self-service only |
| `admin` / `super_admin` | HajirHub platform admins |

---

## Response Conventions

**Success (single object)**
```json
{ "data": { ... } }
```

**Success (list)**
```json
{ "data": [ ... ] }
```

**Success (paginated)**
```json
{
  "data": [ ... ],
  "meta": { "total": 100, "page": 1, "limit": 20, "pages": 5 }
}
```

**Error**
```json
{ "error": "Human-readable message" }
```

**Common HTTP status codes**

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 204 | No Content (DELETE success) |
| 400 | Bad Request — missing/invalid fields |
| 401 | Unauthorized — missing or expired token |
| 402 | Plan limit reached |
| 403 | Forbidden — wrong role |
| 404 | Not Found |
| 409 | Conflict — duplicate record |
| 422 | Unprocessable — business rule violation |
| 500 | Server Error |

---

## Health

```
GET /health
```
No auth required.

**Response**
```json
{ "ok": true }
```

---

---

# 1. Users

## Get own user profile
```
GET /api/users/me
```
**Roles:** Any authenticated user

**Response**
```json
{
  "auth": { "id": "uuid", "email": "user@example.com" },
  "profile": {
    "id": "uuid",
    "full_name": "Ram Bahadur",
    "full_name_nepali": "राम बहादुर",
    "phone": "9841000000",
    "email": "ram@example.com",
    "role": "owner",
    "org_id": "uuid",
    "employee_id": null,
    "preferred_lang": "en",
    "timezone": "Asia/Kathmandu",
    "is_active": true,
    "created_at": "2026-01-01T00:00:00Z"
  }
}
```

---

## Update own user profile
```
PUT /api/users/me
```
**Roles:** Any authenticated user  
**Content-Type:** `application/json`

**Body** (all fields optional)
```json
{
  "full_name": "Ram Bahadur",
  "full_name_nepali": "राम बहादुर",
  "phone": "9841000000",
  "email": "ram@example.com",
  "preferred_lang": "en",
  "timezone": "Asia/Kathmandu",
  "expo_push_token": "ExponentPushToken[...]",
  "push_enabled": true
}
```

**Response**
```json
{ "profile": { ... } }
```

---

## List all users
```
GET /api/users?limit=50&offset=0&org_id=<uuid>
```
**Roles:** `owner`, `hr_manager`, `super_admin`

| Query Param | Type | Description |
|-------------|------|-------------|
| `limit` | number | Max 100, default 50 |
| `offset` | number | Default 0 |
| `org_id` | uuid | Filter by organization |

**Response**
```json
{
  "data": [ ... ],
  "count": 42,
  "limit": 50,
  "offset": 0
}
```

---

---

# 2. Organizations

## Create organization
```
POST /api/organizations
```
**Roles:** Any authenticated user (becomes the `owner`)  
**Note:** Auto-subscribes to the Pro plan and links the user to the org.

**Body** (only `name` is required)
```json
{
  "name": "Sunrise Tech Pvt. Ltd.",
  "name_nepali": "सनराइज टेक प्रा. लि.",
  "slug": "sunrise-tech",
  "pan_no": "123456789",
  "ssf_reg_no": "SSF-2024-001",
  "ird_reg_no": "IRD-98765",
  "phone": "01-4567890",
  "email": "info@sunrisetech.com.np",
  "website": "https://sunrisetech.com.np",
  "address_line1": "Putalisadak, Kathmandu",
  "address_line2": "Near Ratna Park",
  "ward_no": 4,
  "municipality": "Kathmandu Metropolitan City",
  "district": "Kathmandu",
  "province": "Bagmati",
  "viber_id": "9841234567",
  "whatsapp_no": "9841234567",
  "fiscal_year_start_month": 4,
  "checkin_window_start": "09:00:00",
  "checkin_window_end": "10:00:00",
  "late_grace_minutes": 15,
  "half_day_threshold_hours": 4,
  "require_selfie": true
}
```

**Response `201`**
```json
{ "data": { "id": "uuid", "name": "Sunrise Tech Pvt. Ltd.", ... } }
```

---

## Get own organization
```
GET /api/organizations/me
```
**Roles:** `owner`, `hr_manager`

**Response**
```json
{ "data": { "id": "uuid", "name": "...", "logo_url": null, ... } }
```

---

## Update own organization
```
PUT /api/organizations/me
```
**Roles:** `owner`  
**Body:** Same fields as create (all optional, send only what changes)

---

## Upload organization logo
```
POST /api/organizations/me/logo
```
**Roles:** `owner`  
**Content-Type:** `image/png` or `image/jpeg` (raw binary body, max 5 MB)

```
Content-Type: image/png
Body: <raw image bytes>
```

**Response**
```json
{ "data": { "logo_url": "https://..." } }
```

---

## Get own subscription
```
GET /api/organizations/me/subscription
```
**Roles:** `owner`

**Response**
```json
{
  "data": {
    "id": "uuid",
    "org_id": "uuid",
    "status": "active",
    "billing_cycle": "monthly",
    "trial_ends_at": null,
    "current_period_start": "2026-01-01T00:00:00Z",
    "current_period_end": "2026-02-01T00:00:00Z",
    "plan": {
      "id": "uuid",
      "name": "pro",
      "display_name": "Pro",
      "max_employees": 50,
      "max_workplaces": 5,
      "price_monthly": 2999.00,
      "feature_geofence": true,
      "feature_payroll": true,
      ...
    }
  }
}
```

---

---

# 3. Departments

## List departments
```
GET /api/departments
```
**Roles:** `owner`, `hr_manager`

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "org_id": "uuid",
      "name": "Engineering",
      "name_nepali": "इन्जिनियरिङ",
      "description": "Software development team",
      "is_active": true,
      "sort_order": 1,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

## Create department
```
POST /api/departments
```
**Roles:** `owner`

**Body**
```json
{
  "name": "Engineering",
  "name_nepali": "इन्जिनियरिङ",
  "description": "Software development team",
  "is_active": true
}
```
> `sort_order` is auto-assigned — do not send it.

**Response `201`**
```json
{ "data": { "id": "uuid", "name": "Engineering", "sort_order": 1, ... } }
```

**Errors**
- `409` — Department name already exists in this org

---

## Update department
```
PUT /api/departments/:id
```
**Roles:** `owner`

**Body** (all optional)
```json
{
  "name": "Engineering & Product",
  "name_nepali": "इन्जिनियरिङ",
  "description": "Updated description",
  "is_active": true
}
```

**Errors**
- `404` — Department not found
- `409` — Name already taken

---

## Delete department
```
DELETE /api/departments/:id
```
**Roles:** `owner`  
**Response:** `204 No Content`  
> Remaining departments are automatically resequenced.

---

---

# 4. Shifts

## List shifts
```
GET /api/shifts
```
**Roles:** `owner`, `hr_manager`

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "org_id": "uuid",
      "name": "Morning Shift",
      "name_nepali": "बिहान पाली",
      "start_time": "09:00:00",
      "end_time": "17:00:00",
      "working_days": 62,
      "is_default": true,
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

> **`working_days` bitmask:** Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64  
> Mon–Fri = 2+4+8+16+32 = **62** (default)  
> Mon–Sat = 2+4+8+16+32+64 = **126**  
> All 7 days = **127**

---

## Create shift
```
POST /api/shifts
```
**Roles:** `owner`

**Body**
```json
{
  "name": "Morning Shift",
  "name_nepali": "बिहान पाली",
  "start_time": "09:00:00",
  "end_time": "17:00:00",
  "working_days": 62,
  "is_default": true,
  "is_active": true
}
```
> Setting `is_default: true` automatically clears the previous default shift.

**Response `201`**
```json
{ "data": { "id": "uuid", ... } }
```

---

## Update shift
```
PUT /api/shifts/:id
```
**Roles:** `owner`  
**Body:** Same fields as create (all optional)

---

## Delete shift
```
DELETE /api/shifts/:id
```
**Roles:** `owner`  
**Response:** `204 No Content`

---

---

# 5. Workplaces

## List workplaces
```
GET /api/workplaces
```
**Roles:** `owner`, `hr_manager`

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "org_id": "uuid",
      "name": "Head Office",
      "name_nepali": "प्रधान कार्यालय",
      "address": "Putalisadak, Kathmandu",
      "ward_no": 4,
      "municipality": "Kathmandu Metropolitan City",
      "district": "Kathmandu",
      "latitude": 27.7172,
      "longitude": 85.3240,
      "radius_meters": 100,
      "geofence_enabled": true,
      "qr_enabled": false,
      "is_primary": true,
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

## Create workplace
```
POST /api/workplaces
```
**Roles:** `owner`

**Body**
```json
{
  "name": "Head Office",
  "name_nepali": "प्रधान कार्यालय",
  "address": "Putalisadak, Kathmandu",
  "ward_no": 4,
  "municipality": "Kathmandu Metropolitan City",
  "district": "Kathmandu",
  "latitude": 27.7172,
  "longitude": 85.3240,
  "radius_meters": 100,
  "geofence_enabled": true,
  "qr_enabled": false,
  "is_primary": true
}
```

**Required:** `name`, `latitude`, `longitude`  
**Constraint:** `radius_meters` must be between 10 and 500 (default: 50)

**Response `201`**
```json
{ "data": { "id": "uuid", ... } }
```

---

## Get workplace
```
GET /api/workplaces/:id
```
**Roles:** `owner`, `hr_manager`

---

## Update workplace (general info)
```
PUT /api/workplaces/:id
```
**Roles:** `owner`  
**Body:** Any subset of create fields

---

## Update workplace geofence only
```
PUT /api/workplaces/:id/geofence
```
**Roles:** `owner`

**Body**
```json
{
  "latitude": 27.7200,
  "longitude": 85.3250,
  "radius_meters": 150,
  "geofence_enabled": true
}
```

---

## Get QR token
```
GET /api/workplaces/:id/qr-token
```
**Roles:** `owner`, `hr_manager`  
**Note:** Auto-generates a token if none exists. Requires `qr_enabled: true` on the workplace.

**Response**
```json
{
  "data": {
    "id": "uuid",
    "org_id": "uuid",
    "workplace_id": "uuid",
    "token": "a3f8c2...",
    "version": 1,
    "is_active": true,
    "issued_at": "2026-01-01T00:00:00Z",
    "expires_at": "2026-04-01T00:00:00Z",
    "last_used_at": null,
    "use_count": 0
  }
}
```

**Errors**
- `400` — QR check-in is not enabled for this workplace

---

## Rotate QR token
```
POST /api/workplaces/:id/rotate-qr
```
**Roles:** `owner`  
**Body:** None  
Invalidates the current token and issues a new one with an incremented version.

**Response:** Same shape as Get QR token

---

---

# 6. Employees

## List employees
```
GET /api/employees?search=ram&department_id=<uuid>&status=active&page=1&limit=20
```
**Roles:** `owner`, `hr_manager`

| Query Param | Type | Description |
|-------------|------|-------------|
| `search` | string | Searches `full_name`, `employee_code`, `phone` |
| `department_id` | uuid | Filter by department |
| `status` | string | `active` \| `inactive` \| `terminated` |
| `page` | number | Default 1 |
| `limit` | number | Default 20, max 100 |

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "employee_code": "HH-001",
      "full_name": "Ram Bahadur Thapa",
      "full_name_nepali": "राम बहादुर थापा",
      "phone": "9841000001",
      "email": "ram@example.com",
      "gender": "male",
      "designation": "Software Engineer",
      "status": "active",
      "app_access_status": "active",
      "join_date_bs": "2081-01-15",
      "join_date_ad": "2024-04-28",
      "photo_url": null,
      "department": { "id": "uuid", "name": "Engineering" },
      "shift": { "id": "uuid", "name": "Morning Shift" },
      "workplace": { "id": "uuid", "name": "Head Office" }
    }
  ],
  "meta": { "total": 45, "page": 1, "limit": 20, "pages": 3 }
}
```

---

## Create employee
```
POST /api/employees
```
**Roles:** `owner`

**Body**
```json
{
  "full_name": "Ram Bahadur Thapa",
  "full_name_nepali": "राम बहादुर थापा",
  "phone": "9841000001",
  "email": "ram@example.com",
  "gender": "male",
  "date_of_birth_bs": "2055-06-15",
  "date_of_birth_ad": "1998-09-30",
  "citizenship_no": "12-34-56-78901",
  "pan_no": "123456789",
  "ssf_id": "SSF123456",
  "ssf_enrolled": true,
  "department_id": "uuid",
  "designation": "Software Engineer",
  "shift_id": "uuid",
  "workplace_id": "uuid",
  "join_date_bs": "2081-01-15",
  "join_date_ad": "2024-04-28",
  "basic_salary": 50000,
  "hra": 5000,
  "travel_allowance": 2000,
  "medical_allowance": 1000,
  "marital_status": "single",
  "bank_name": "Nabil Bank",
  "bank_account_no": "1234567890123",
  "bank_branch": "Kathmandu",
  "bank_ifsc": "NABIL0001",
  "notes": "Probation period 3 months"
}
```

**Required:** `full_name`, `phone`, `join_date_bs`, `join_date_ad`, `basic_salary`

> `employee_code` is auto-generated (HH-001, HH-002 …) — do not send it.  
> Leave balances are auto-initialized from the org's active leave types.

**Response `201`**
```json
{ "data": { "id": "uuid", "employee_code": "HH-001", ... } }
```

**Errors**
- `400` — Required field missing
- `402` — Employee limit reached for current plan
- `409` — Phone number already registered in this org

---

## Get own employee profile
```
GET /api/employees/me
```
**Roles:** Any authenticated user with a linked employee record

**Response**
```json
{
  "data": {
    "id": "uuid",
    "employee_code": "HH-001",
    "full_name": "Ram Bahadur Thapa",
    "phone": "9841000001",
    "designation": "Software Engineer",
    "status": "active",
    "app_access_status": "active",
    "join_date_bs": "2081-01-15",
    "join_date_ad": "2024-04-28",
    "photo_url": null,
    "department": { "id": "uuid", "name": "Engineering" },
    "shift": { "id": "uuid", "name": "Morning Shift", "start_time": "09:00:00", "end_time": "17:00:00" },
    "workplace": { "id": "uuid", "name": "Head Office", "address": "Putalisadak" }
  }
}
```

---

## Get employee by ID
```
GET /api/employees/:id
```
**Roles:** `owner`, `hr_manager`  
Returns full profile including salary, bank details, legal IDs.

---

## Update employee profile
```
PUT /api/employees/:id
```
**Roles:** `owner`

**Allowed fields** (all optional)
```json
{
  "full_name": "Ram B. Thapa",
  "full_name_nepali": "राम ब. थापा",
  "phone": "9841000002",
  "email": "ram.new@example.com",
  "gender": "male",
  "date_of_birth_bs": "2055-06-15",
  "date_of_birth_ad": "1998-09-30",
  "citizenship_no": "12-34-56-78901",
  "pan_no": "123456789",
  "ssf_id": "SSF123456",
  "ssf_enrolled": true,
  "department_id": "uuid",
  "designation": "Senior Engineer",
  "join_date_bs": "2081-01-15",
  "join_date_ad": "2024-04-28",
  "marital_status": "couple",
  "bank_name": "Nabil Bank",
  "bank_account_no": "1234567890123",
  "bank_branch": "Kathmandu",
  "bank_ifsc": "NABIL0001",
  "notes": "Updated notes"
}
```

> Salary fields (`basic_salary`, `hra`, etc.) are **not** accepted here — use `/salary` endpoint.

---

## Terminate employee
```
PUT /api/employees/:id/deactivate
```
**Roles:** `owner`

**Body**
```json
{
  "exit_date_bs": "2082-03-15",
  "exit_date_ad": "2025-06-28",
  "termination_reason": "Resignation"
}
```

Sets `status = terminated` and `app_access_status = suspended`. Soft delete — record is preserved.

---

## Update salary
```
PUT /api/employees/:id/salary
```
**Roles:** `owner`

**Body**
```json
{
  "basic_salary": 60000,
  "hra": 6000,
  "travel_allowance": 2500,
  "medical_allowance": 1500,
  "effective_date_bs": "2082-01-01",
  "effective_date_ad": "2025-04-14",
  "reason": "Annual increment"
}
```

**Required:** `effective_date_bs`, `effective_date_ad`, and at least one salary field  
> Automatically logs a revision entry in `salary_revisions` with old and new values.

---

## Assign shift
```
PUT /api/employees/:id/shift
```
**Roles:** `owner`

**Body**
```json
{ "shift_id": "uuid" }
```
> Pass `"shift_id": null` to unassign.

---

## Assign workplace
```
PUT /api/employees/:id/workplace
```
**Roles:** `owner`

**Body**
```json
{ "workplace_id": "uuid" }
```
> Pass `"workplace_id": null` to unassign.

---

## Send app invite
```
POST /api/employees/:id/invite
```
**Roles:** `owner`  
**Body:** None  
Sets `app_access_status = invited`.

**Response**
```json
{
  "data": { "id": "uuid", "app_access_status": "invited", ... },
  "message": "Invite sent successfully"
}
```

**Errors**
- `422` — Employee already has active app access
- `422` — Cannot invite a terminated employee

---

## List employee documents
```
GET /api/employees/:id/documents
```
**Roles:** `owner`, `hr_manager`

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "employee_id": "uuid",
      "doc_type": "citizenship",
      "label": "Front Side",
      "file_url": "https://...",
      "file_name": "citizenship_front.jpg",
      "file_size_bytes": 204800,
      "uploaded_by": "uuid",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

## Upload employee document
```
POST /api/employees/:id/documents?doc_type=citizenship&label=Front+Side&original_name=file.jpg
```
**Roles:** `owner`, `hr_manager`  
**Content-Type:** `image/jpeg`, `image/png`, `image/webp`, or `application/pdf`  
**Body:** Raw binary file (max 10 MB)

| Query Param | Required | Description |
|-------------|----------|-------------|
| `doc_type` | ✅ | `citizenship` \| `pan_card` \| `contract` \| `photo` \| `certificate` \| `other` |
| `label` | ❌ | Human-readable label e.g. "Front Side" |
| `original_name` | ❌ | Original filename |

**Response `201`**
```json
{ "data": { "id": "uuid", "file_url": "https://...", ... } }
```

---

## Delete employee document
```
DELETE /api/employees/:id/documents/:docId
```
**Roles:** `owner`  
**Response:** `204 No Content`  
> Also removes the file from Supabase Storage.

---

---

# 7. Admin — Plans

> All `/api/admin/*` routes require `role = admin` or `super_admin`.

## List plans
```
GET /api/admin/plans
```

## Create plan
```
POST /api/admin/plans
```
**Body**
```json
{
  "name": "starter",
  "display_name": "Starter",
  "display_name_nepali": "स्टार्टर",
  "max_employees": 10,
  "max_workplaces": 1,
  "max_admin_users": 1,
  "price_monthly": 999.00,
  "price_yearly": 9990.00,
  "trial_days": 30,
  "feature_geofence": true,
  "feature_payroll": false,
  "is_active": true,
  "sort_order": 1
}
```

## Update plan
```
PUT /api/admin/plans/:id
```
**Body:** Same fields as create (all optional)

## Toggle plan active/inactive
```
PATCH /api/admin/plans/:id/toggle
```
**Body**
```json
{ "is_active": false }
```
> Omit `is_active` to flip the current value.

---

---

# 8. Admin — Organizations

## List all organizations
```
GET /api/admin/organizations?search=sunrise&limit=50&offset=0
```

| Query Param | Description |
|-------------|-------------|
| `search` | Searches name, slug, email |
| `limit` | Max 100, default 50 |
| `offset` | Default 0 |

## Get organization by ID
```
GET /api/admin/organizations/:id
```

## Update organization
```
PUT /api/admin/organizations/:id
```
**Body:** Same fields as `PUT /api/organizations/me`

## Toggle organization active/inactive
```
PATCH /api/admin/organizations/:id/toggle
```
**Body**
```json
{
  "is_active": false,
  "reason": "Payment overdue"
}
```

---

---

# 9. Admin — Subscriptions

## List all subscriptions
```
GET /api/admin/subscriptions?status=active&org_id=<uuid>&limit=50&offset=0
```

| Query Param | Description |
|-------------|-------------|
| `status` | `trialing` \| `active` \| `past_due` \| `cancelled` \| `expired` \| `paused` |
| `org_id` | Filter by organization |
| `limit` | Max 100, default 50 |
| `offset` | Default 0 |

**Response**
```json
{
  "data": [
    {
      "id": "uuid",
      "org_id": "uuid",
      "status": "active",
      "billing_cycle": "monthly",
      "plan": { "id": "uuid", "name": "pro", "display_name": "Pro", ... },
      "organization": { "id": "uuid", "name": "Sunrise Tech", "email": "..." }
    }
  ],
  "count": 120,
  "limit": 50,
  "offset": 0
}
```

## Get subscription by ID
```
GET /api/admin/subscriptions/:id
```

---

---

## Notes for Frontend

### Authentication flow
1. Sign in via Supabase Auth (email/phone OTP)
2. Get the `access_token` from the Supabase session
3. Pass it as `Authorization: Bearer <token>` on every API call
4. Refresh the token before it expires using Supabase client

### File uploads
For all raw binary uploads (org logo, employee documents):
- Set `Content-Type` to the actual MIME type (`image/png`, `image/jpeg`, `application/pdf`)
- Send the raw file bytes as the request body — **not** `multipart/form-data`
- For documents, pass metadata as **query params** (not body)

### Dates
- `*_bs` fields are Bikram Sambat dates as strings: `"2081-01-15"`
- `*_ad` fields are Gregorian dates: `"2024-04-28"` (ISO 8601 date)
- Times are `"HH:MM:SS"` strings: `"09:00:00"`

### Pagination
Use `page` + `limit` for employees. Use `limit` + `offset` for admin endpoints.

### Shift working_days bitmask
To check if a day is a working day:
```js
const DAYS = { Sun: 1, Mon: 2, Tue: 4, Wed: 8, Thu: 16, Fri: 32, Sat: 64 };
const isWorkingDay = (working_days, day) => (working_days & DAYS[day]) !== 0;
```
