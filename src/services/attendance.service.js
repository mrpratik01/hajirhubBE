const { supabaseAdmin } = require("../config/supabase");
const { haversineDistanceM } = require("../utils/haversine");
const { adToBs, todayBs } = require("../utils/nepaliDate");

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  // Build shift start as a Date on the same day as check-in
  const [shiftHour, shiftMin] = shift.start_time.split(":").map(Number);
  const shiftStart = new Date(checkIn);
  shiftStart.setHours(shiftHour, shiftMin, 0, 0);

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
  const dateAd = now.toISOString().split("T")[0];
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

  // Status
  const status = calculateAttendanceStatus(now, shift, orgSettings.late_grace_minutes);
  console.log("[checkIn] step 15 — calculated status:", status);

  const insertPayload = {
    org_id: orgId,
    employee_id: employee.id,
    workplace_id: workplace?.id ?? null,
    shift_id: employee.shift_id ?? null,
    date_bs: dateBs,
    date_ad: dateAd,
    check_in_time: now.toISOString(),
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

  const now = new Date();
  const dateAd = now.toISOString().split("T")[0];

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

  const workingMinutes = calculateWorkingMinutes(attendance.check_in_time, now.toISOString());

  const { data: updateRows, error } = await supabaseAdmin
    .from("attendance")
    .update({
      check_out_time: now.toISOString(),
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
  const dateAd = now.toISOString().split("T")[0];
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
  const dateBs = todayBs();
  const todayAd = new Date().toISOString().split("T")[0];

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
 */
async function manualCorrection(userId, attendanceId, body) {
  const orgId = await resolveOrgId(userId);

  const ALLOWED = new Set([
    "check_in_time", "check_out_time", "status",
    "working_minutes", "override_reason",
  ]);

  const patch = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }

  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  patch.is_manual_correction = true;
  patch.correction_by = userId;
  if (body.correction_note) patch.correction_note = body.correction_note;

  // Recalculate working_minutes if both times provided
  if (patch.check_in_time && patch.check_out_time) {
    patch.working_minutes = calculateWorkingMinutes(patch.check_in_time, patch.check_out_time);
  }

  const { data: updateRows, error } = await supabaseAdmin
    .from("attendance")
    .update(patch)
    .eq("id", attendanceId)
    .eq("org_id", orgId)
    .select("*");

  if (error) throw error;

  const updated = updateRows?.[0];
  if (!updated) throw new Error("Attendance record not found");
  return updated;
}

/**
 * Get today's absent employees list
 * Returns employees who are scheduled to work today but haven't checked in
 */
async function getTodayAbsentEmployees(userId) {
  const orgId = await resolveOrgId(userId);
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
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
