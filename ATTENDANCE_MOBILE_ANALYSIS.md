# Section E - Mobile Attendance System: Deep Analysis & Implementation Plan

## 📱 **Core Architecture Overview**

This section implements the most complex part of HajirHub - mobile attendance with selfie verification, GPS geofencing, and offline sync. The system handles 3 distinct check-in modes:

1. **Mobile GPS Check-in** - Selfie + GPS location verification
2. **QR Code Check-in** - Selfie + QR token (skips geofence)  
3. **Offline Sync** - Batch sync of records when connectivity returns

## 🧠 **Brainstorming & Key Challenges**

### **Challenge 1: Face Recognition vs Face Presence**
- **MVP Approach**: Store selfie for audit purposes (face presence proof)
- **Phase 2**: Add face recognition using embeddings (128 float vectors)
- **Privacy**: Never store reconstructable photos long-term
- **Storage**: Selfies in Supabase Storage, embeddings in JSONB column

### **Challenge 2: Geofencing Accuracy**
- **GPS Accuracy**: Handle poor GPS conditions (accuracy_m field)
- **Haversine Distance**: Already implemented in `utils/haversine.js`
- **Override Logic**: PIN-based geofence override for edge cases
- **Radius Validation**: 10-500 meters from workplace schema

### **Challenge 3: Offline Complexity**
- **Time Window**: 24-hour offline limit
- **Deduplication**: client_record_id prevents duplicate syncs
- **Approval Workflow**: Owner approval for old records
- **Conflict Resolution**: Manual correction endpoints

### **Challenge 4: Status Calculation Logic**
- **Shift Integration**: Use shift start times + grace periods
- **Status Types**: present, late, half_day, absent, leave, holiday, weekend
- **Working Minutes**: Calculate based on check-in/out times
- **Source Tracking**: mobile, qr, manual, hardware

## 🏗️ **Database Schema Analysis**

### **Core Attendance Table**
```sql
CREATE TABLE public.attendance (
  id                      UUID PRIMARY KEY,
  org_id                  UUID NOT NULL,
  employee_id             UUID NOT NULL,
  workplace_id            UUID REFERENCES workplaces(id),
  shift_id                UUID REFERENCES shifts(id),
  
  -- Date keys (BS primary)
  date_bs                 TEXT NOT NULL,      -- "2082-01-10"
  date_ad                 DATE NOT NULL,
  
  -- Check-in
  check_in_time           TIMESTAMPTZ,
  check_in_lat            DOUBLE PRECISION,
  check_in_lng            DOUBLE PRECISION,
  check_in_accuracy_m     DOUBLE PRECISION,   -- GPS accuracy in metres
  check_in_selfie_url     TEXT,               -- Supabase Storage
  check_in_device_info    JSONB,              -- {os, model, appVersion}
  
  -- Check-out
  check_out_time          TIMESTAMPTZ,
  check_out_lat           DOUBLE PRECISION,
  check_out_lng           DOUBLE PRECISION,
  check_out_selfie_url    TEXT,
  
  -- Computed
  working_minutes         INT,
  
  -- Status
  status                  TEXT DEFAULT 'absent',
                          CHECK (status IN (
                            'present','late','absent','half_day',
                            'leave','holiday','weekend','manual'
                          )),
  
  -- Offline
  is_offline_record       BOOLEAN DEFAULT FALSE,
  offline_created_at      TIMESTAMPTZ,
  client_record_id        TEXT,               -- device-generated UUID
  synced_at               TIMESTAMPTZ,
  
  -- Geofence
  geofence_status         TEXT CHECK (geofence_status IN ('inside','outside','skipped','qr')),
  geofence_distance_m     INT,
  geofence_override       BOOLEAN DEFAULT FALSE,
  override_reason         TEXT,
  override_approved_by    UUID REFERENCES users(id),
  
  -- Audit
  source                  TEXT DEFAULT 'mobile',
                          CHECK (source IN ('mobile','qr','manual','hardware')),
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
```

### **Related Tables**
- `qr_tokens` - QR code management
- `offline_sync_log` - Offline record tracking
- `attendance_violations` - Geofence violations
- `organizations` - Late grace minutes, check-in windows

## 📋 **Implementation Plan**

### **Phase 1: Core Service Layer** (Day 1)

#### **1.1 Attendance Service** (`src/services/attendance.service.js`)
```javascript
// Core functions needed:
- checkInEmployee(userId, body, file) 
- checkOutEmployee(userId, body)
- qrCheckInEmployee(userId, body, file)
- syncOfflineRecords(userId, records)
- getTodayAttendance(orgId)
- getMonthlyAttendance(orgId, month)
- getEmployeeHistory(employeeId)
- manualCorrection(userId, attendanceId, body)
```

#### **1.2 Business Logic Functions**
```javascript
// Validation functions:
- validateDuplicateCheckIn(employeeId, date_bs)
- validateGeofence(lat, lng, workplace, accuracy)
- validateQRToken(token, orgId)
- validateOfflineTime(timestamp)

// Status calculation:
- calculateAttendanceStatus(checkInTime, shift, graceMinutes)
- calculateWorkingMinutes(checkInTime, checkOutTime)

// Storage functions:
- uploadSelfie(orgId, employeeId, date, file)
- generateFaceEmbedding(selfie) // Future Phase 2

// Approval workflow:
- createOfflineApprovalRequest(record)
- processOfflineApproval(logId, approved, reason)
```

### **Phase 2: Mobile Check-in Endpoints** (Day 1.5)

#### **2.1 Check-in Endpoint**
```javascript
POST /api/attendance/checkin
Content-Type: multipart/form-data

Body:
- selfie: image file (max 300KB)
- lat: float
- lng: float  
- accuracy_m: float
- client_record_id: uuid

Response:
{
  "attendanceId": "uuid",
  "status": "present|late|half_day",
  "checkInTime": "2025-01-15T09:15:00Z",
  "selfieUrl": "https://storage.supabase.co/..."
}
```

#### **2.2 Check-out Endpoint**
```javascript
POST /api/attendance/checkout
Content-Type: application/json

Body:
{
  "lat": 27.7172,
  "lng": 85.3240,
  "client_record_id": "uuid" // optional
}

Response:
{
  "attendanceId": "uuid",
  "workingMinutes": 480,
  "checkOutTime": "2025-01-15T18:00:00Z"
}
```

### **Phase 3: QR Check-in System** (Day 2)

#### **3.1 QR Token Integration**
- Reuse existing `qr_tokens` table from workplaces
- Token validation and expiration logic
- Use count tracking for analytics

#### **3.2 QR Check-in Endpoint**
```javascript
POST /api/attendance/qr-checkin
Content-Type: multipart/form-data

Body:
- token: string (from QR scan)
- selfie: image file
- lat: float
- lng: float
- accuracy_m: float
- client_record_id: uuid

Logic differences from mobile check-in:
1. Validate QR token instead of geofence
2. Set geofence_status = 'skipped'
3. Set source = 'qr'
4. Increment qr_tokens.use_count
```

### **Phase 4: Offline Sync System** (Day 2.5)

#### **4.1 Sync Endpoint**
```javascript
POST /api/attendance/sync
Content-Type: application/json

Body:
{
  "records": [
    {
      "client_record_id": "uuid",
      "type": "checkin|checkout",
      "lat": 27.7172,
      "lng": 85.3240,
      "selfieBase64": "data:image/jpeg;base64,...",
      "offline_timestamp": "2025-01-15T09:15:00Z"
    }
  ]
}

Response:
[
  {
    "client_record_id": "uuid",
    "success": true,
    "attendanceId": "uuid",
    "error": null
  }
]
```

#### **4.2 Offline Approval Workflow**
```javascript
// Owner approval endpoints:
GET  /api/attendance/offline/pending
PUT  /api/attendance/offline/:logId/approve
PUT  /api/attendance/offline/:logId/reject
```

### **Phase 5: Read Endpoints & Dashboard** (Day 3)

#### **5.1 Dashboard Endpoints**
```javascript
GET /api/attendance/today              // Today's attendance for org
GET /api/attendance/monthly?month=2082-08 // Monthly summary
GET /api/attendance/employee/:id        // Employee history
PUT /api/attendance/:id/manual          // Manual correction
```

### **Phase 6: Controller & Routes** (Day 3)

#### **6.1 Attendance Controller**
- All endpoint handlers with proper error handling
- Role-based access control (Owner/HR/Employee)
- Input validation and sanitization
- File upload handling for selfies

#### **6.2 Attendance Routes**
- Route definitions with middleware
- File upload middleware using multer
- Authentication and authorization

## 🔧 **Technical Implementation Details**

### **File Upload Strategy**
```javascript
// Supabase Storage path structure:
selfies/{org_id}/{employee_id}/{date_ad}.jpg

// Example:
selfies/550e8400-e29b-41d4-a716-446655440000/123e4567-e89b-12d3-a456-426614174000/2025-01-15.jpg
```

### **Geofence Calculation**
```javascript
// Use existing haversine.js utility
const distance = haversineDistanceM(
  workplace.latitude, workplace.longitude,
  employeeLat, employeeLng
);

if (distance > workplace.radius_meters) {
  // Outside geofence
  if (!overridePin) {
    throw new Error('OUTSIDE_GEOFENCE');
  }
  // Verify override PIN
}
```

### **Status Logic**
```javascript
function calculateStatus(checkInTime, shift, graceMinutes) {
  const shiftStart = new Date(shift.start_time);
  const checkIn = new Date(checkInTime);
  const diffMinutes = (checkIn - shiftStart) / (1000 * 60);
  
  if (diffMinutes <= graceMinutes) return 'present';
  if (diffMinutes <= graceMinutes + 120) return 'late';
  if (diffMinutes <= graceMinutes + 240) return 'half_day';
  return 'absent';
}
```

### **Offline Sync Logic**
```javascript
// 24-hour window validation
const now = new Date();
const recordTime = new Date(offlineTimestamp);
const hoursDiff = (now - recordTime) / (1000 * 60 * 60);

if (hoursDiff > 24) {
  // Requires owner approval
  return { requiresOwnerApproval: true };
}
```

## 📱 **React Native Integration Points**

### **Frontend Responsibilities**
1. **Camera Integration** - Capture selfie with compression
2. **GPS Location** - Get accurate location with accuracy
3. **QR Scanning** - Scan workplace QR codes
4. **Offline Storage** - Store records locally when offline
5. **Background Sync** - Auto-sync when connectivity returns

### **Key React Native Libraries**
```javascript
// Camera & Selfie
import { Camera } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';

// GPS Location  
import * as Location from 'expo-location';

// QR Scanning
import { BarCodeScanner } from 'expo-barcode-scanner';

// Offline Storage
import AsyncStorage from '@react-native-async-storage/async-storage';

// Background Sync
import { BackgroundFetch } from 'expo-background-fetch';
```

### **Mobile Flow Examples**

#### **Check-in Flow**
```javascript
1. Open camera → capture selfie
2. Compress image to <300KB
3. Get current GPS location
4. Generate client_record_id (UUID)
5. Send to POST /api/attendance/checkin
6. Handle geofence override if needed
7. Store response locally
```

#### **Offline Flow**
```javascript
1. Detect network connectivity
2. Store attendance locally if offline
3. Periodically check for connectivity
4. Batch sync stored records
5. Handle approval requirements
```

## 🚀 **Next Steps**

### **Immediate Actions**
1. **Start with attendance service** - Core business logic
2. **Implement mobile check-in** - Most critical endpoint
3. **Add file upload handling** - Selfie storage
4. **Test geofence logic** - Using existing haversine utility

### **Sequence Priority**
1. Day 1: Mobile check-in + checkout
2. Day 1.5: QR check-in integration  
3. Day 2: Offline sync system
4. Day 2.5: Approval workflow
5. Day 3: Dashboard endpoints + controller

### **Success Metrics**
- ✅ Mobile check-in with selfie + GPS working
- ✅ Geofence validation with override logic
- ✅ QR code check-in skipping geofence
- ✅ Offline sync with 24-hour approval
- ✅ Dashboard showing today's attendance

This plan ensures a robust, scalable mobile attendance system that handles edge cases, offline scenarios, and provides the foundation for future face recognition features.
