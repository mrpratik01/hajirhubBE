# Employees API Implementation Plan

## Overview
Building a comprehensive employee management system with 13 endpoints covering CRUD operations, salary management, document handling, and app invitations.

## Database Schema Analysis

### Core Employee Table
```sql
CREATE TABLE public.employees (
  id                  UUID PRIMARY KEY,
  org_id              UUID NOT NULL,
  user_id             UUID REFERENCES users(id),
  employee_code       TEXT NOT NULL, -- HH-001 format
  
  -- Identity
  full_name           TEXT NOT NULL,
  full_name_nepali    TEXT,
  phone               TEXT NOT NULL,
  email               TEXT,
  gender              TEXT CHECK (gender IN ('male','female','other')),
  date_of_birth_bs    TEXT,
  date_of_birth_ad    DATE,
  
  -- Nepal legal IDs
  citizenship_no      TEXT,
  pan_no              CHAR(9),
  ssf_id              TEXT,
  ssf_enrolled        BOOLEAN DEFAULT TRUE,
  
  -- Organization
  department_id       UUID REFERENCES departments(id),
  designation         TEXT,
  shift_id            UUID REFERENCES shifts(id),
  workplace_id        UUID REFERENCES workplaces(id),
  
  -- Employment dates
  join_date_bs        TEXT NOT NULL,
  join_date_ad        DATE NOT NULL,
  exit_date_bs        TEXT,
  exit_date_ad        DATE,
  termination_reason  TEXT,
  
  -- Salary (NPR)
  basic_salary        NUMERIC(10,2) NOT NULL CHECK (basic_salary >= 0),
  hra                 NUMERIC(10,2) DEFAULT 0,
  travel_allowance    NUMERIC(10,2) DEFAULT 0,
  medical_allowance   NUMERIC(10,2) DEFAULT 0,
  
  -- Tax
  marital_status      TEXT DEFAULT 'single' CHECK (marital_status IN ('single','couple')),
  
  -- Bank
  bank_name           TEXT,
  bank_account_no     TEXT,
  bank_branch         TEXT,
  bank_ifsc           TEXT,
  
  -- Profile photo
  photo_url           TEXT,
  
  -- Status
  status              TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','terminated')),
  app_access_status   TEXT DEFAULT 'not_invited' CHECK (app_access_status IN ('not_invited','invited','active','suspended')),
  
  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### Related Tables
- `employee_documents` - Document management
- `salary_revisions` - Salary change history
- `leave_balances` - Leave entitlement tracking
- `organizations.max_employees` - Plan limits

## API Endpoints

### 1. Employee Management
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/employees` | Owner/HR | Paginated list with search & filters |
| POST | `/api/employees` | Owner | Create new employee |
| GET | `/api/employees/me` | Employee | Own profile |
| GET | `/api/employees/:id` | Owner/HR | Full employee profile |
| PUT | `/api/employees/:id` | Owner | Update profile fields |
| PUT | `/api/employees/:id/deactivate` | Owner | Soft terminate |

### 2. Salary Management
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| PUT | `/api/employees/:id/salary` | Owner | Update salary with revision logging |

### 3. Assignment Management
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| PUT | `/api/employees/:id/shift` | Owner | Assign shift |
| PUT | `/api/employees/:id/workplace` | Owner | Assign workplace |

### 4. App Access
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| POST | `/api/employees/:id/invite` | Owner | Send app invite SMS/WhatsApp |

### 5. Document Management
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/employees/:id/documents` | Owner/HR | List documents |
| POST | `/api/employees/:id/documents` | Owner/HR | Upload document |
| DELETE | `/api/employees/:id/documents/:docId` | Owner | Delete document |

## Implementation Steps

### Phase 1: Core Service Layer
1. **Employee Service** (`src/services/employees.service.js`)
   - CRUD operations with organization scoping
   - Employee code generation (HH-001 format)
   - Plan limit validation (max_employees)
   - Search and pagination logic

2. **Business Logic Functions**
   - `generateEmployeeCode(orgId)` - HH-001, HH-002 format
   - `initializeLeaveBalances(employeeId)` - Create leave_balances rows
   - `logSalaryRevision()` - Track salary changes
   - `validatePlanLimits(orgId)` - Check max_employees

### Phase 2: Advanced Features
3. **Document Management**
   - Supabase Storage integration
   - File type validation
   - Document metadata tracking

4. **App Invitation System**
   - SMS/WhatsApp integration hooks
   - User creation for non-existent phone numbers
   - Invitation status tracking

### Phase 3: Controller & Routes
5. **Employee Controller** (`src/controllers/employees.controller.js`)
   - All 13 endpoint handlers
   - Role-based access control
   - Input validation and error handling

6. **Employee Routes** (`src/routes/employees.routes.js`)
   - Route definitions with middleware
   - Role-based route protection

### Phase 4: Integration
7. **App Integration**
   - Add routes to main app.js
   - Ensure authentication middleware

8. **Audit Logging**
   - Track employee operations
   - Log to audit_logs table

## Key Business Logic

### Employee Creation Side Effects
1. **Code Generation**: Call `fn_next_employee_code(org_id)` → HH-001 format
2. **Leave Balances**: Create rows in `leave_balances` for all active leave_types
3. **User Creation**: If phone not in auth.users, create user and send SMS invite
4. **Audit Log**: Write `{ action: 'employee.created', employee_id, user_id }`

### Salary Revision Process
1. Validate old vs new salary
2. Create entry in `salary_revisions` table
3. Update employee record
4. Log audit trail

### Plan Limit Validation
```javascript
// Check organization's subscription limits
const org = await getOrganization(orgId);
const currentEmployeeCount = await getEmployeeCount(orgId);
if (currentEmployeeCount >= org.max_employees) {
  throw new Error('Employee limit exceeded for current plan');
}
```

## Query Parameters for List Endpoint
```
GET /api/employees?search=ram&department_id=uuid&status=active&page=1&limit=20
```

- `search` - Trigram search on full_name
- `department_id` - Filter by department
- `status` - Filter by status (active/inactive/terminated)
- `page` & `limit` - Pagination

## Security Considerations
- Organization-based data isolation
- Role-based access control (Owner/HR/Employee)
- Input validation for all fields
- File upload security for documents
- Audit trail for all operations

## Next Steps
1. Start with employee service implementation
2. Implement employee code generation
3. Build controller with core CRUD operations
4. Add advanced features (documents, invitations)
5. Create routes and integrate with app
6. Add comprehensive testing

This plan ensures a robust, secure, and feature-complete employee management API that integrates seamlessly with the existing HajirHub system.
