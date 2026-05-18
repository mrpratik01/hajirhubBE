const { supabaseAdmin } = require("../config/supabase");
const { haversineDistanceM } = require("../utils/haversine");
const { adToBs, bsToAd, getDaysInBsMonth } = require("../utils/nepaliDate");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NEPAL_OFFSET_MINUTES = 5 * 60 + 45;
const NEPAL_OFFSET_MS = NEPAL_OFFSET_MINUTES * 60 * 1000;

function getNepalDateAd(date = new Date()) {
  return new Date(date.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

function assertYmd(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error(`${label} must be in YYYY-MM-DD format`);
  }
}

function addAdDays(dateAd, days) {
  const [year, month, day] = dateAd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function compareYmd(left, right) {
  return left.localeCompare(right);
}

function nextBsDate(dateBs) {
  const [year, month, day] = dateBs.split("-").map(Number);
  const daysInMonth = getDaysInBsMonth(year, month);
  if (day < daysInMonth) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`;
  }
  if (month < 12) return `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return `${year + 1}-01-01`;
}

function enumerateBsRange(startDateBs, endDateBs) {
  const dates = [];
  let cursor = startDateBs;
  while (compareYmd(cursor, endDateBs) <= 0) {
    dates.push({ date_bs: cursor, date_ad: bsToAd(cursor) });
    cursor = nextBsDate(cursor);
    if (dates.length > 370) throw new Error("Attendance report date range cannot exceed 370 days");
  }
  return dates;
}

function enumerateAdRange(startDateAd, endDateAd) {
  const dates = [];
  let cursor = startDateAd;
  while (compareYmd(cursor, endDateAd) <= 0) {
    dates.push({ date_ad: cursor, date_bs: adToBs(cursor) });
    cursor = addAdDays(cursor, 1);
    if (dates.length > 370) throw new Error("Attendance report date range cannot exceed 370 days");
  }
  return dates;
}

function nepalDateTimeToUtcIso(dateAd, timeValue) {
  if (!dateAd || !/^\d{4}-\d{2}-\d{2}$/.test(dateAd)) {
    throw new Error("date_ad is required in YYYY-MM-DD format for Nepal time conversion");
  }

  const match = String(timeValue).match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new Error("Time must be in HH:mm or HH:mm:ss format");

  const [, h, m, s = "0", ms = "0"] = match;
  const hour = Number(h);
  const minute = Number(m);
  const second = Number(s);
  const millisecond = Number(ms.padEnd(3, "0"));

  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("Invalid time value");
  }

  const [year, month, day] = dateAd.split("-").map(Number);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - NEPAL_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

function normalizeManualTimestamp(value, dateAd) {
  if (value == null || value === "") return value;
  const raw = String(value).trim();

  if (/^\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)) {
    return nepalDateTimeToUtcIso(dateAd, raw);
  }

  const localDateTime = raw.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/
  );
  if (localDateTime) {
    return nepalDateTimeToUtcIso(localDateTime[1], localDateTime[2]);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid timestamp");
  }
  return parsed.toISOString();
}

/**
 * Resolve org_id from the authenticated user.
 */
async function resolveOrgId(userId) {
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!user) throw new Error("User profile not found");
  if (!user.org_id) throw new Error("No organization linked to this user");
  return user.org_id;
}

/**
 * Get the employee record for the authenticated user.
 *
 * FIX: The employees table has user_id FK pointing to users.id.
 * We look up by employees.user_id = userId (the auth user's UUID).
 * If that returns nothing, we also try users.employee_id as a fallback
 * (set when the owner links an employee record to a user account).
 */
async function getEmployeeByUserId(userId) {
  // Primary: employees.user_id = userId
  const { data: byUserId, error: e1 } = await supabaseAdmin
    .from("employees")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (e1) throw e1;
  if (byUserId) return byUserId;

  // Fallback: look up users.employee_id and fetch that employee
  const { data: user, error: e2 } = await supabaseAdmin
    .from("users")
    .select("employee_id, org_id")
    .eq("id", userId)
    .maybeSingle();

  if (e2) throw e2;
  if (!user) throw new Error("User profile not found in database");

  if (user?.employee_id) {
    const { data: byEmpId, error: e3 } = await supabaseAdmin
      .from("employees")
      .select("*")
      .eq("id", user.employee_id)
      .eq("status", "active")
      .maybeSingle();

    if (e3) throw e3;
    if (byEmpId) return byEmpId;
  }

  throw new Error(
    "No active employee record found for this user. " +
    "Make sure the employee account is linked via the dashboard."
  );
}

/**
 * Get org attendance settings.
 */
async function getOrgSettings(orgId) {
  const { data: org, error } = await supabaseAdmin
    .from("organizations")
    .select("checkin_window_start, checkin_window_end, late_grace_minutes, half_day_threshold_hours")
    .eq("id", orgId)
    .maybeSingle();

  if (error) throw error;
  if (!org) throw new Error("Organization not found");
  return org;
}

/**
 * Get shift details. Returns null if no shiftId.
 */
async function getShiftDetails(shiftId) {
  if (!shiftId) return null;

  const { data, error } = await supabaseAdmin
    .from("shifts")
    .select("id, name, start_time, end_time, working_days")
    .eq("id", shiftId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Get workplace details. Returns null if no workplaceId.
 */
async function getWorkplaceDetails(workplaceId) {
  if (!workplaceId) return null;

  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .select("id, name, latitude, longitude, radius_meters, geofence_enabled, qr_enabled")
    .eq("id", workplaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Prevent duplicate check-ins on the same BS date.
 * The attendance table has UNIQUE (employee_id, date_bs).
 */
async function validateDuplicateCheckIn(employeeId, dateBs) {
  const { data: existing, error } = await supabaseAdmin
    .from("attendance")
    .select("id, check_in_time")
    .eq("employee_id", employeeId)
    .eq("date_bs", dateBs)
    .not("check_in_time", "is", null)
    .maybeSingle();

  if (error) throw error;
  if (existing) throw new Error("Already checked in today");
  return true;
}

/**
 * Validate geofence.
 * FIX: Safely handles null workplace — returns 'skipped' instead of crashing.
 */
function validateGeofence(employeeLat, employeeLng, workplace) {
  // No workplace assigned or geofence disabled → skip silently
  if (!workplace || !workplace.geofence_enabled) {
    return { status: "skipped", distance: null };
  }

  const distance = haversineDistanceM(
    workplace.latitude,
    workplace.longitude,
    employeeLat,
    employeeLng
  );

  const isInside = distance <= workplace.radius_meters;
  return {
    status: isInside ? "inside" : "outside",
    distance: Math.round(distance),
    radius: workplace.radius_meters,
  };
}

/**
 * Validate a QR token — must be active, not expired, and belong to the org.
 */
async function validateQRToken(token, orgId) {
  const { data: qrToken, error } = await supabaseAdmin
    .from("qr_tokens")
    .select("*")
    .eq("token", token)
    .eq("org_id", orgId)
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  if (!qrToken) throw new Error("Invalid or expired QR token");
  return qrToken;
}

/**
 * Check if an offline timestamp is within the 24-hour sync window.
 */
function validateOfflineTime(timestamp) {
  const now = new Date();
  const recordTime = new Date(timestamp);
  const hoursDiff = (now - recordTime) / (1000 * 60 * 60);

  return {
    isWithinWindow: hoursDiff <= 24,
    hoursDiff: Math.round(hoursDiff * 100) / 100,
    requiresApproval: hoursDiff > 24,
  };
}

// ─── Status Calculation ───────────────────────────────────────────────────────

/**
 * Determine attendance status from check-in time vs shift start.
 * FIX: Properly compares times on the same calendar day.
 */
function calculateAttendanceStatus(checkInTime, shift, graceMinutes = 10) {
  if (!shift || !shift.start_time) return "present";

  const checkIn = new Date(checkInTime);
  const dateAd = getNepalDateAd(checkIn);
  const shiftStart = new Date(nepalDateTimeToUtcIso(dateAd, shift.start_time));

  const diffMinutes = (checkIn - shiftStart) / (1000 * 60);

  if (diffMinutes <= graceMinutes) return "present";
  if (diffMinutes <= graceMinutes + 120) return "late";
  if (diffMinutes <= graceMinutes + 240) return "half_day";
  return "absent";
}

/**
 * Calculate working minutes between check-in and check-out.
 */
function calculateWorkingMinutes(checkInTime, checkOutTime) {
  if (!checkInTime || !checkOutTime) return 0;
  const diff = new Date(checkOutTime) - new Date(checkInTime);
  return Math.max(0, Math.round(diff / (1000 * 60)));
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Upload a selfie buffer to Supabase Storage.
 * Path: selfies/{orgId}/{employeeId}/{dateAd}.jpg
 * Returns the public URL or null if no file provided.
 */
async function uploadSelfie(orgId, employeeId, dateAd, fileBuffer, mimeType = "image/jpeg") {
  if (!fileBuffer) return null;

  const ext = mimeType.includes("png") ? "png" : "jpg";
  // Folder structure: attendance/selfies/{orgId}/{employeeId}/{dateAd}.jpg
  const filePath = `attendance/selfies/${orgId}/${employeeId}/${dateAd}.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("hajirhub-storage")
    .upload(filePath, fileBuffer, { contentType: mimeType, upsert: true });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseAdmin.storage
    .from("hajirhub-storage")
    .getPublicUrl(filePath);

  return urlData.publicUrl;
}

// ─── Core Check-in / Check-out ────────────────────────────────────────────────

/**
 * Mobile GPS check-in.
 * FIX: Removed non-existent columns (source, created_by).
 * FIX: Uses real BS date conversion.
 * FIX: Geofence safely handles null workplace.
 */
async function checkInEmployee(userId, body, fileBuffer, mimeType) {
  const { lat, lng, accuracy_m, client_record_id, workplace_id } = body;

  console.log("[checkIn] step 1 — resolving employee for userId:", userId);
  const employee = await getEmployeeByUserId(userId);
  console.log("[checkIn] step 2 — employee found:", employee.id, "org:", employee.org_id);

  const orgId = employee.org_id;

  console.log("[checkIn] step 3 — fetching org settings for orgId:", orgId);
  const orgSettings = await getOrgSettings(orgId);
  console.log("[checkIn] step 4 — org settings:", orgSettings);

  console.log("[checkIn] step 5 — fetching shift:", employee.shift_id);
  const shift = await getShiftDetails(employee.shift_id);
  console.log("[checkIn] step 6 — shift:", shift?.name ?? "none");

  // Resolve workplace: prefer body param, fall back to employee's assigned workplace
  const resolvedWorkplaceId = workplace_id || employee.workplace_id || null;
  console.log("[checkIn] step 7 — fetching workplace:", resolvedWorkplaceId);
  const workplace = await getWorkplaceDetails(resolvedWorkplaceId);
  console.log("[checkIn] step 8 — workplace:", workplace?.name ?? "none");

  const now = new Date();
  const dateAd = getNepalDateAd(now);
  const dateBs = adToBs(dateAd);
  console.log("[checkIn] step 9 — dates: AD=", dateAd, "BS=", dateBs);

  console.log("[checkIn] step 10 — checking duplicate for employee:", employee.id, "date_bs:", dateBs);
  await validateDuplicateCheckIn(employee.id, dateBs);
  console.log("[checkIn] step 11 — no duplicate found");

  // Geofence — safe even if workplace is null
  const geofenceResult = validateGeofence(lat, lng, workplace);
  console.log("[checkIn] step 12 — geofence result:", geofenceResult);

  console.log("[checkIn] step 13 — uploading selfie, hasFile:", !!fileBuffer);
  const selfieUrl = await uploadSelfie(orgId, employee.id, dateAd, fileBuffer, mimeType);
  console.log("[checkIn] step 14 — selfie url:", selfieUrl ?? "null (no file)");

  // Status - use current time for accurate calculation
  const currentCheckInTime = new Date();
  const status = calculateAttendanceStatus(currentCheckInTime, shift, orgSettings.late_grace_minutes);
  console.log("[checkIn] step 15 — calculated status:", status);

  const insertPayload = {
    org_id: orgId,
    employee_id: employee.id,
    workplace_id: workplace?.id ?? null,
    shift_id: employee.shift_id ?? null,
    date_bs: dateBs,
    date_ad: dateAd,
    check_in_time: currentCheckInTime.toISOString(), // Use current time at check-in
    check_in_lat: lat,
    check_in_lng: lng,
    check_in_accuracy_m: accuracy_m ?? null,
    check_in_selfie_url: selfieUrl,
    check_in_device_info: body.device_info ?? null,
    status,
    geofence_status: geofenceResult.status,
    geofence_distance_m: geofenceResult.distance ?? null,
    is_offline_record: false,
    client_record_id: client_record_id ?? null,
  };

  console.log("[checkIn] step 16 — inserting attendance row:", JSON.stringify(insertPayload, null, 2));

  // Insert without .single() — use .select() then take first row
  // Avoids "cannot coerce to single JSON object" when RLS or triggers
  // cause the post-insert read to return unexpected row count.
  const { data: rows, error } = await supabaseAdmin
    .from("attendance")
    .insert(insertPayload)
    .select("*");

  console.log("[checkIn] step 17 — insert result: rows=", rows?.length, "error=", error);

  if (error) {
    if (error.code === "23505") throw new Error("Already checked in today");
    throw error;
  }

  const attendance = rows?.[0];
  if (!attendance) throw new Error("Check-in insert succeeded but no row returned — check RLS policies on attendance table");

  console.log("[checkIn] step 18 — success, attendanceId:", attendance.id);
  return { attendance, geofence: geofenceResult };
}

/**
 * Mobile GPS check-out.
 */
async function checkOutEmployee(userId, body) {
  const { lat, lng } = body;

  const employee = await getEmployeeByUserId(userId);

  const currentCheckOutTime = new Date();
  const dateAd = getNepalDateAd(currentCheckOutTime);

  // Find today's open check-in
  const { data: attendance, error: fetchError } = await supabaseAdmin
    .from("attendance")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("date_ad", dateAd)
    .not("check_in_time", "is", null)
    .is("check_out_time", null)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!attendance) throw new Error("No active check-in found for today");

  const workingMinutes = calculateWorkingMinutes(attendance.check_in_time, currentCheckOutTime.toISOString());

  const { data: updateRows, error } = await supabaseAdmin
    .from("attendance")
    .update({
      check_out_time: currentCheckOutTime.toISOString(),
      check_out_lat: lat,
      check_out_lng: lng,
      working_minutes: workingMinutes,
    })
    .eq("id", attendance.id)
    .select("*");

  if (error) throw error;

  const updated = updateRows?.[0];
  if (!updated) throw new Error("Check-out update succeeded but no row returned");
  return updated;
}

/**
 * QR code check-in.
 */
async function qrCheckInEmployee(userId, body, fileBuffer, mimeType) {
  const { token, lat, lng, accuracy_m, client_record_id } = body;

  const employee = await getEmployeeByUserId(userId);
  const orgId = employee.org_id;
  const orgSettings = await getOrgSettings(orgId);
  const shift = await getShiftDetails(employee.shift_id);

  // Validate QR token
  const qrToken = await validateQRToken(token, orgId);

  const now = new Date();
  const dateAd = getNepalDateAd(now);
  const dateBs = adToBs(dateAd);

  await validateDuplicateCheckIn(employee.id, dateBs);

  const selfieUrl = await uploadSelfie(orgId, employee.id, dateAd, fileBuffer, mimeType);
  const status = calculateAttendanceStatus(now, shift, orgSettings.late_grace_minutes);

  const { data: rows, error } = await supabaseAdmin
    .from("attendance")
    .insert({
      org_id: orgId,
      employee_id: employee.id,
      workplace_id: qrToken.workplace_id,
      shift_id: employee.shift_id ?? null,
      date_bs: dateBs,
      date_ad: dateAd,
      check_in_time: now.toISOString(),
      check_in_lat: lat ?? null,
      check_in_lng: lng ?? null,
      check_in_accuracy_m: accuracy_m ?? null,
      check_in_selfie_url: selfieUrl,
      check_in_device_info: body.device_info ?? null,
      status,
      geofence_status: "qr",
      geofence_distance_m: null,
      is_offline_record: false,
      client_record_id: client_record_id ?? null,
      qr_token_id: qrToken.id,
    })
    .select("*");

  if (error) {
    if (error.code === "23505") throw new Error("Already checked in today");
    throw error;
  }

  const attendance = rows?.[0];
  if (!attendance) throw new Error("QR check-in insert succeeded but no row returned — check RLS policies on attendance table");

  // Increment QR token usage (non-fatal)
  supabaseAdmin
    .from("qr_tokens")
    .update({ use_count: qrToken.use_count + 1, last_used_at: now.toISOString() })
    .eq("id", qrToken.id)
    .then(() => {})
    .catch(() => {});

  return attendance;
}

// ─── Read Endpoints ───────────────────────────────────────────────────────────

/**
 * Today's attendance for the whole org — owner/HR dashboard.
 * Includes all employees with their status (present, late, absent, or leave).
 */
async function getTodayAttendance(userId) {
  const orgId = await resolveOrgId(userId);
  const todayAd = getNepalDateAd();
  const dateBs = adToBs(todayAd);

  // 1. Fetch all active employees
  const { data: employees, error: empError } = await supabaseAdmin
    .from("employees")
    .select(
      `id, employee_code, full_name, photo_url,
       department:department_id(id, name),
       shift:shift_id(id, name, start_time, end_time),
       workplace:workplace_id(id, name)`
    )
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("full_name", { ascending: true });

  if (empError) throw empError;

  // 2. Fetch today's attendance records
  const { data: attendanceRecords, error: attError } = await supabaseAdmin
    .from("attendance")
    .select(
      `id, employee_id, date_bs, date_ad, check_in_time, check_out_time,
       working_minutes, status, geofence_status, geofence_distance_m,
       is_offline_record`
    )
    .eq("org_id", orgId)
    .eq("date_bs", dateBs);

  if (attError) throw attError;

  // 3. Fetch today's approved leave requests
  const { data: leaveRequests, error: leaveError } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, leave_type:leave_type_id(name)")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .lte("from_date_ad", todayAd)
    .gte("to_date_ad", todayAd);

  if (leaveError) throw leaveError;

  // Map for easy lookup
  const attendanceMap = new Map(attendanceRecords.map((r) => [r.employee_id, r]));
  const leaveMap = new Map(leaveRequests.map((r) => [r.employee_id, r]));

  // 4. Merge
  const results = employees.map((emp) => {
    const attendance = attendanceMap.get(emp.id);
    const leave = leaveMap.get(emp.id);

    if (attendance) {
      return {
        ...attendance,
        employee: emp,
      };
    }

    // Not present (no attendance record)
    return {
      id: null,
      employee_id: emp.id,
      date_bs: dateBs,
      date_ad: todayAd,
      check_in_time: null,
      check_out_time: null,
      working_minutes: 0,
      status: leave ? "leave" : "absent",
      leave_type: leave ? leave.leave_type?.name : null,
      geofence_status: null,
      geofence_distance_m: null,
      is_offline_record: false,
      employee: emp,
    };
  });

  return results;
}

/**
 * Monthly attendance summary — owner/HR.
 * month format: "2082-08"
 */
async function getMonthlyAttendance(userId, month) {
  const orgId = await resolveOrgId(userId);

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("month must be in YYYY-MM format (BS), e.g. 2082-08");
  }

  const { data, error } = await supabaseAdmin
    .from("attendance")
    .select(
      `id, date_bs, date_ad, check_in_time, check_out_time,
       working_minutes, status, geofence_status, is_offline_record,
       employee:employee_id(id, employee_code, full_name)`
    )
    .eq("org_id", orgId)
    .like("date_bs", `${month}-%`)
    .order("date_bs", { ascending: true })
    .order("employee_id", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Enhanced monthly attendance report with custom date range filtering.
 * Returns day-by-day breakdown of all employees (present/absent/late/etc.)
 * Supports both single month and custom date ranges.
 * 
 * Query params:
 *   - month: "2082-08" (single month)
 *   - start_date: "2082-08-01" (start of range, BS by default)
 *   - end_date: "2082-08-30" (end of range, BS by default)
 *   - date_mode: "bs" | "ad" (set "ad" when start_date/end_date are AD)
 *   - department_id: filter by department
 *   - status: filter by specific status (present, absent, late, etc.)
 */
async function getMonthlyAttendanceReport(userId, query = {}) {
  const orgId = await resolveOrgId(userId);

  let startDateBs, endDateBs, startDateAd, endDateAd, allDates;

  // Determine date range
  if (query.start_date && query.end_date) {
    assertYmd(query.start_date, "start_date");
    assertYmd(query.end_date, "end_date");

    if (compareYmd(query.start_date, query.end_date) > 0) {
      throw new Error("start_date must be before or equal to end_date");
    }

    if (query.date_mode === "ad") {
      startDateAd = query.start_date;
      endDateAd = query.end_date;
      allDates = enumerateAdRange(startDateAd, endDateAd);
      startDateBs = allDates[0].date_bs;
      endDateBs = allDates[allDates.length - 1].date_bs;
    } else {
      startDateBs = query.start_date;
      endDateBs = query.end_date;
      allDates = enumerateBsRange(startDateBs, endDateBs);
      startDateAd = allDates[0].date_ad;
      endDateAd = allDates[allDates.length - 1].date_ad;
    }
  } else if (query.month) {
    // Single month
    if (!/^\d{4}-\d{2}$/.test(query.month)) {
      throw new Error("month must be in YYYY-MM format (BS), e.g. 2082-08");
    }
    startDateBs = `${query.month}-01`;
    const [year, month] = query.month.split("-").map(Number);
    endDateBs = `${query.month}-${String(getDaysInBsMonth(year, month)).padStart(2, "0")}`;
    allDates = enumerateBsRange(startDateBs, endDateBs);
    startDateAd = allDates[0].date_ad;
    endDateAd = allDates[allDates.length - 1].date_ad;
  } else {
    // Default: current BS month
    const todayAd = getNepalDateAd();
    const todayBs = adToBs(todayAd);
    const parts = todayBs.split("-");
    startDateBs = `${parts[0]}-${parts[1]}-01`;
    endDateBs = `${parts[0]}-${parts[1]}-${String(getDaysInBsMonth(Number(parts[0]), Number(parts[1]))).padStart(2, "0")}`;
    allDates = enumerateBsRange(startDateBs, endDateBs);
    startDateAd = allDates[0].date_ad;
    endDateAd = allDates[allDates.length - 1].date_ad;
  }

  // Fetch all active employees with details
  let employeesQuery = supabaseAdmin
    .from("employees")
    .select(`
      id, employee_code, full_name, full_name_nepali, phone, email,
      department:department_id(id, name),
      shift:shift_id(id, name, start_time, end_time),
      workplace:workplace_id(id, name)
    `)
    .eq("org_id", orgId)
    .eq("status", "active");

  if (query.department_id) {
    employeesQuery = employeesQuery.eq("department_id", query.department_id);
  }

  const { data: employees, error: empError } = await employeesQuery;
  if (empError) throw empError;
  if (!employees || employees.length === 0) {
    return {
      report: {
        date_range: {
          start: startDateBs,
          end: endDateBs,
          start_ad: startDateAd,
          end_ad: endDateAd,
          total_days: allDates.length,
        },
        daily_breakdown: [],
        summary: {
          total_employees: 0,
          total_present: 0,
          total_absent: 0,
          total_late: 0,
          total_half_day: 0,
          total_leave: 0,
          attendance_rate: "0%",
          total_working_days: 0,
        },
      },
      employee_summary: [],
    };
  }

  const employeeIds = employees.map((e) => e.id);

   // Fetch attendance records for the date range
  let attendanceQuery = supabaseAdmin
    .from("attendance")
    .select(
      `id, employee_id, date_bs, date_ad, check_in_time, check_out_time,
       working_minutes, status, geofence_status, is_offline_record,
       is_manual_correction`
    )
    .eq("org_id", orgId)
    .gte("date_bs", startDateBs)
    .lte("date_bs", endDateBs)
    .in("employee_id", employeeIds)
    .order("date_bs", { ascending: true })
    .order("employee_id", { ascending: true });

  const validStatuses = ["present", "absent", "late", "half_day", "leave", "holiday", "weekend", "manual", "no_record"];
  const statusFilter = validStatuses.includes(query.status) ? query.status : null;

  const { data: attendanceRecords, error: attError } = await attendanceQuery;
  if (attError) throw attError;

  // Fetch approved leave requests for the date range
  // Convert BS dates to AD for leave_requests (uses AD dates)
  const { data: leaveRequests, error: leaveError } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, from_date_ad, to_date_ad, leave_type:leave_type_id(name)")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .lte("from_date_ad", endDateAd)
    .gte("to_date_ad", startDateAd)
    .in("employee_id", employeeIds);

  if (leaveError) throw leaveError;

  // Create lookup maps
  const attendanceMap = new Map();
  for (const record of attendanceRecords || []) {
    const key = `${record.employee_id}_${record.date_bs}`;
    attendanceMap.set(key, record);
  }

  const leaveMap = new Map();
  for (const leave of leaveRequests || []) {
    if (!leaveMap.has(leave.employee_id)) {
      leaveMap.set(leave.employee_id, []);
    }
    leaveMap.get(leave.employee_id).push(leave);
  }

  // Build daily breakdown
  const todayAdForReport = getNepalDateAd();
  const dailyBreakdown = allDates.map(({ date_bs: date, date_ad: dateAd }) => {
    const dayReport = {
      date_bs: date,
      date_ad: dateAd,
      total_employees: employees.length,
      present: [],
      absent: [],
      late: [],
      half_day: [],
      leave: [],
      holiday: [],
      weekend: [],
      manual: [],
      no_record: [],
    };

    for (const emp of employees) {
      const key = `${emp.id}_${date}`;
      const attendance = attendanceMap.get(key);

      if (attendance) {
        // Employee has attendance record
        const employeeData = {
          employee_id: emp.id,
          employee_code: emp.employee_code,
          full_name: emp.full_name,
          full_name_nepali: emp.full_name_nepali,
          department: emp.department?.name || null,
          shift: emp.shift?.name || null,
          attendance_id: attendance.id,
          check_in_time: attendance.check_in_time,
          check_out_time: attendance.check_out_time,
          working_minutes: attendance.working_minutes || 0,
          geofence_status: attendance.geofence_status,
          is_offline_record: attendance.is_offline_record,
          is_manual_correction: attendance.is_manual_correction,
        };

        // Categorize by status
        const statusKey = attendance.status === "present" ? "present" :
                         attendance.status === "absent" ? "absent" :
                         attendance.status === "late" ? "late" :
                         attendance.status === "half_day" ? "half_day" :
                         attendance.status === "leave" ? "leave" :
                         attendance.status === "holiday" ? "holiday" :
                         attendance.status === "weekend" ? "weekend" :
                         attendance.status === "manual" ? "manual" : "no_record";

        dayReport[statusKey].push(employeeData);
      } else {
        if (compareYmd(dateAd, todayAdForReport) > 0) {
          dayReport.no_record.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            full_name_nepali: emp.full_name_nepali,
            department: emp.department?.name || null,
            shift: emp.shift?.name || null,
            attendance_id: null,
            reason: "Upcoming date",
          });
          continue;
        }

        // No attendance record - check if on leave
        const empLeaves = leaveMap.get(emp.id) || [];
        const activeLeave = empLeaves.find((leave) =>
          compareYmd(leave.from_date_ad, dateAd) <= 0 &&
          compareYmd(leave.to_date_ad, dateAd) >= 0
        );

        if (activeLeave) {
          dayReport.leave.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            full_name_nepali: emp.full_name_nepali,
            department: emp.department?.name || null,
            shift: emp.shift?.name || null,
            attendance_id: null,
            leave_reason: activeLeave.leave_type?.name || "On approved leave",
          });
        } else {
          // Check if weekend (simplified - no shift means no work day)
          if (!emp.shift) {
            dayReport.no_record.push({
              employee_id: emp.id,
              employee_code: emp.employee_code,
              full_name: emp.full_name,
              full_name_nepali: emp.full_name_nepali,
              department: emp.department?.name || null,
              shift: emp.shift?.name || null,
              attendance_id: null,
              reason: "No shift assigned",
            });
          } else {
            dayReport.absent.push({
              employee_id: emp.id,
              employee_code: emp.employee_code,
              full_name: emp.full_name,
              full_name_nepali: emp.full_name_nepali,
              department: emp.department?.name || null,
              shift: emp.shift?.name || null,
              attendance_id: null,
              reason: "No check-in record",
            });
          }
        }
      }
    }

    if (statusFilter) {
      for (const key of validStatuses) {
        if (key !== statusFilter && Array.isArray(dayReport[key])) {
          dayReport[key] = [];
        }
      }
    }

    return dayReport;
  });

  // Calculate summary statistics
  let totalPresent = 0;
  let totalAbsent = 0;
  let totalLate = 0;
  let totalHalfDay = 0;
  let totalLeave = 0;
  let totalRecords = 0;

  for (const day of dailyBreakdown) {
    totalPresent += day.present.length;
    totalAbsent += day.absent.length;
    totalLate += day.late.length;
    totalHalfDay += day.half_day.length;
    totalLeave += day.leave.length;
    totalRecords += day.present.length + day.absent.length + day.late.length + day.half_day.length + day.leave.length;
  }

  const totalAttendanceDays = totalPresent + totalLate + totalHalfDay;
  const attendanceRate = totalRecords > 0
    ? ((totalAttendanceDays / totalRecords) * 100).toFixed(1)
    : "0";

  const report = {
    date_range: {
      start: startDateBs,
      end: endDateBs,
      start_ad: startDateAd,
      end_ad: endDateAd,
      total_days: allDates.length,
    },
    daily_breakdown: dailyBreakdown,
    summary: {
      total_employees: employees.length,
      total_present: totalPresent,
      total_absent: totalAbsent,
      total_late: totalLate,
      total_half_day: totalHalfDay,
      total_leave: totalLeave,
      attendance_rate: `${attendanceRate}%`,
      total_working_days: totalRecords,
      present_count: totalPresent,
      absent_count: totalAbsent,
      late_count: totalLate,
      half_day_count: totalHalfDay,
      leave_count: totalLeave,
    },
  };

  // Also provide employee-wise summary from the final daily breakdown so
  // generated absences and leave days are counted alongside stored records.
  const employeeSummary = employees.map((emp) => {
    let empPresent = 0;
    let empAbsent = 0;
    let empLate = 0;
    let empHalfDay = 0;
    let empLeave = 0;

    for (const day of dailyBreakdown) {
      if (day.present.some((entry) => entry.employee_id === emp.id)) empPresent++;
      if (day.absent.some((entry) => entry.employee_id === emp.id)) empAbsent++;
      if (day.late.some((entry) => entry.employee_id === emp.id)) empLate++;
      if (day.half_day.some((entry) => entry.employee_id === emp.id)) empHalfDay++;
      if (day.leave.some((entry) => entry.employee_id === emp.id)) empLeave++;
    }

    const totalDays = empPresent + empAbsent + empLate + empHalfDay + empLeave;
    const attendanceRate = totalDays > 0
      ? (((empPresent + empLate + empHalfDay) / totalDays) * 100).toFixed(1)
      : "0";

    return {
      employee_id: emp.id,
      employee_code: emp.employee_code,
      full_name: emp.full_name,
      full_name_nepali: emp.full_name_nepali,
      department: emp.department?.name || null,
      shift: emp.shift?.name || null,
      workplace: emp.workplace?.name || null,
      present: empPresent,
      absent: empAbsent,
      late: empLate,
      half_day: empHalfDay,
      leave: empLeave,
      attendance_rate: `${attendanceRate}%`,
    };
  });

  return {
    report,
    employee_summary: employeeSummary,
  };
}

/**
 * Attendance history for a single employee — owner/HR.
 */
async function getEmployeeAttendance(userId, employeeId, query = {}) {
  const orgId = await resolveOrgId(userId);

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 31));
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from("attendance")
    .select("*", { count: "exact" })
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .order("date_bs", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.month) q = q.like("date_bs", `${query.month}-%`);

  const { data, error, count } = await q;
  if (error) throw error;

  return {
    data,
    meta: { total: count, page, limit, pages: Math.ceil(count / limit) },
  };
}

/**
 * Employee's own attendance history.
 */
async function getMyAttendance(userId, query = {}) {
  const employee = await getEmployeeByUserId(userId);

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 31));
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from("attendance")
    .select("*", { count: "exact" })
    .eq("employee_id", employee.id)
    .order("date_bs", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.month) q = q.like("date_bs", `${query.month}-%`);

  const { data, error, count } = await q;
  if (error) throw error;

  return {
    data,
    meta: { total: count, page, limit, pages: Math.ceil(count / limit) },
  };
}

/**
 * Manual correction — owner only.
 * Supports upsert: if attendanceId is not provided/null, uses employee_id + date_bs.
 */
async function manualCorrection(userId, attendanceId, body) {
  const orgId = await resolveOrgId(userId);

  const {
    employee_id,
    date_ad,
    check_in_time,
    check_out_time,
    status,
    correction_note,
  } = body;

  const ALLOWED = new Set(["status", "working_minutes", "override_reason"]);

  const patch = {
    org_id: orgId,
    is_manual_correction: true,
    correction_by: userId,
    correction_note: correction_note,
  };

  // Determine if we are updating by ID or by Employee+Date
  const isNew = !attendanceId || attendanceId === "null" || attendanceId === "new";

  let recordDateAd = date_ad;
  const hasManualTime =
    Object.prototype.hasOwnProperty.call(body, "check_in_time") ||
    Object.prototype.hasOwnProperty.call(body, "check_out_time");

  if (!isNew && hasManualTime && !recordDateAd) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("attendance")
      .select("date_ad")
      .eq("id", attendanceId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) throw new Error("Attendance record not found");
    recordDateAd = existing.date_ad;
  }

  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "check_in_time")) {
    patch.check_in_time = normalizeManualTimestamp(check_in_time, recordDateAd);
  }

  if (Object.prototype.hasOwnProperty.call(body, "check_out_time")) {
    patch.check_out_time = normalizeManualTimestamp(check_out_time, recordDateAd);
  }

  // Recalculate working_minutes if both times are available in this correction.
  if (patch.check_in_time && patch.check_out_time) {
    patch.working_minutes = calculateWorkingMinutes(patch.check_in_time, patch.check_out_time);
  }
  
  let query = supabaseAdmin.from("attendance");

  if (isNew) {
    if (!employee_id || !recordDateAd) {
      throw new Error("employee_id and date_ad are required for new corrections");
    }
    
    // For new records, we need some defaults
    patch.employee_id = employee_id;
    patch.date_bs = adToBs(recordDateAd);
    patch.date_ad = recordDateAd;
    if (!patch.status) patch.status = "present";

    // Use upsert with ON CONFLICT (employee_id, date_bs)
    const { data, error } = await query
      .upsert(patch, { onConflict: "employee_id, date_bs" })
      .select("*");
      
    if (error) throw error;
    return data?.[0];
  } else {
    if (recordDateAd && Object.prototype.hasOwnProperty.call(body, "date_ad")) {
      patch.date_ad = recordDateAd;
      patch.date_bs = adToBs(recordDateAd);
    }

    // Standard update by ID
    const { data, error } = await query
      .update(patch)
      .eq("id", attendanceId)
      .eq("org_id", orgId)
      .select("*");

    if (error) throw error;
    const updated = data?.[0];
    if (!updated) throw new Error("Attendance record not found");
    return updated;
  }
}

/**
 * Get today's absent employees list
 * Returns employees who are scheduled to work today but haven't checked in
 */
async function getTodayAbsentEmployees(userId) {
  const orgId = await resolveOrgId(userId);
  const today = getNepalDateAd();
  
  try {
    // Get all active employees
    const { data: employees, error: empError } = await supabaseAdmin
      .from('employees')
      .select(`
        id, employee_code, full_name, full_name_nepali, phone, email,
        department:department_id(id, name),
        shift:shift_id(id, name, start_time, end_time),
        workplace:workplace_id(id, name, address)
      `)
      .eq('org_id', orgId)
      .eq('status', 'active');

    if (empError) throw empError;
    if (!employees || employees.length === 0) {
      return { absent_employees: [], total_absent: 0 };
    }

    // Get today's leave requests
    const { data: leaveRequests, error: leaveError } = await supabaseAdmin
      .from('leave_requests')
      .select('employee_id')
      .eq('org_id', orgId)
      .eq('status', 'approved')
      .lte('from_date_ad', today)
      .gte('to_date_ad', today);

    if (leaveError) throw leaveError;

    // Get today's attendance records
    const { data: attendanceRecords, error: attError } = await supabaseAdmin
      .from('attendance')
      .select('employee_id, check_in_time')
      .eq('org_id', orgId)
      .eq('date_ad', today);

    if (attError) throw attError;

    // Create sets for faster lookup
    const onLeave = new Set(leaveRequests?.map(lr => lr.employee_id) || []);
    const checkedIn = new Set(attendanceRecords?.map(ar => ar.employee_id) || []);

    // Filter employees who are absent
    const absentEmployees = employees.filter(employee => {
      const hasShiftToday = employee.shift; // Employee has shift assigned
      const isOnLeave = onLeave.has(employee.id);
      const hasCheckedIn = checkedIn.has(employee.id);
      
      // Employee is absent if: has shift today AND not on leave AND hasn't checked in
      return hasShiftToday && !isOnLeave && !hasCheckedIn;
    });

    return {
      absent_employees: absentEmployees.map(emp => ({
        employee_id: emp.id,
        employee_code: emp.employee_code,
        full_name: emp.full_name,
        full_name_nepali: emp.full_name_nepali,
        phone: emp.phone,
        email: emp.email,
        department: emp.department,
        shift: emp.shift,
        workplace: emp.workplace,
        absence_reason: !emp.shift ? 'No shift assigned' : 'Not checked in'
      })),
      total_absent: absentEmployees.length,
      date: today,
      summary: {
        total_active_employees: employees.length,
        employees_on_leave: onLeave.size,
        employees_checked_in: checkedIn.size,
        employees_absent: absentEmployees.length
      }
    };
  } catch (error) {
    console.error('Error getting today\'s absent employees:', error);
    throw error;
  }
}

module.exports = {
  checkInEmployee,
  checkOutEmployee,
  qrCheckInEmployee,
  getTodayAttendance,
  getMonthlyAttendance,
  getMonthlyAttendanceReport,
  getEmployeeAttendance,
  getMyAttendance,
  manualCorrection,
  getTodayAbsentEmployees,
  // Exported for testing
  validateGeofence,
  calculateAttendanceStatus,
  calculateWorkingMinutes,
  adToBs,
};
