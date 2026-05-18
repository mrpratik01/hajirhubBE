const attendanceService = require("../services/attendance.service");

// ─── Error handler ────────────────────────────────────────────────────────────
function handleError(res, err, context = "Operation") {
  const msg = err.message || `${context} failed`;
  console.error(`[attendance] ${context}:`, err);

  if (msg.includes("Already checked in")) return res.status(409).json({ error: msg });
  if (msg.includes("No active check-in")) return res.status(404).json({ error: msg });
  if (msg.includes("No active employee record") || msg.includes("not linked")) {
    return res.status(403).json({ error: msg });
  }
  if (msg.includes("Invalid or expired QR")) return res.status(400).json({ error: msg });
  if (msg.includes("required") || msg.includes("Invalid") || msg.includes("must be")) {
    return res.status(400).json({ error: msg });
  }
  if (msg.includes("not found")) return res.status(404).json({ error: msg });

  return res.status(500).json({ error: msg });
}

// ─── Check-in ─────────────────────────────────────────────────────────────────

/**
 * POST /api/attendance/checkin
 * multipart/form-data: selfie (file), lat, lng, accuracy_m, client_record_id, workplace_id
 */
async function checkIn(req, res) {
  try {
    // ── DEBUG: log the authenticated user so we can verify the row exists ──
    console.log("[checkIn] req.user.id =", req.user.id);
    console.log("[checkIn] req.user.email =", req.user.email);
    console.log("[checkIn] req.body keys =", Object.keys(req.body));
    console.log("[checkIn] has selfie file =", !!req.file);

    const { lat, lng, accuracy_m, client_record_id, workplace_id, device_info } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: "lat and lng must be valid numbers" });
    }

    // Selfie is optional for MVP — warn but don't block
    const fileBuffer = req.file?.buffer ?? null;
    const mimeType = req.file?.mimetype ?? "image/jpeg";

    const { attendance, geofence } = await attendanceService.checkInEmployee(
      req.user.id,
      {
        lat: latitude,
        lng: longitude,
        accuracy_m: accuracy_m ? parseFloat(accuracy_m) : null,
        client_record_id: client_record_id ?? null,
        workplace_id: workplace_id ?? null,
        device_info: device_info ? JSON.parse(device_info) : null,
      },
      fileBuffer,
      mimeType
    );

    // Outside geofence — return 422 so FE can show override prompt
    if (geofence.status === "outside") {
      return res.status(422).json({
        error: "OUTSIDE_GEOFENCE",
        message: `You are ${geofence.distance}m from the workplace (allowed: ${geofence.radius}m)`,
        data: {
          attendanceId: attendance.id,
          status: attendance.status,
          checkInTime: attendance.check_in_time,
          selfieUrl: attendance.check_in_selfie_url,
          geofence,
        },
      });
    }

    return res.status(201).json({
      data: {
        attendanceId: attendance.id,
        status: attendance.status,
        checkInTime: attendance.check_in_time,
        selfieUrl: attendance.check_in_selfie_url,
        geofence,
      },
    });
  } catch (err) {
    return handleError(res, err, "Check-in");
  }
}

// ─── Check-out ────────────────────────────────────────────────────────────────

/**
 * POST /api/attendance/checkout
 * JSON: { lat, lng }
 */
async function checkOut(req, res) {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: "lat and lng must be valid numbers" });
    }

    const attendance = await attendanceService.checkOutEmployee(req.user.id, {
      lat: latitude,
      lng: longitude,
    });

    return res.json({
      data: {
        attendanceId: attendance.id,
        workingMinutes: attendance.working_minutes,
        checkOutTime: attendance.check_out_time,
      },
    });
  } catch (err) {
    return handleError(res, err, "Check-out");
  }
}

// ─── QR Check-in ──────────────────────────────────────────────────────────────

/**
 * POST /api/attendance/qr-checkin
 * multipart/form-data: token, selfie (file), lat, lng, accuracy_m, client_record_id
 */
async function qrCheckIn(req, res) {
  try {
    const { token, lat, lng, accuracy_m, client_record_id, device_info } = req.body;

    if (!token) return res.status(400).json({ error: "token is required" });
    if (!lat || !lng) return res.status(400).json({ error: "lat and lng are required" });

    const fileBuffer = req.file?.buffer ?? null;
    const mimeType = req.file?.mimetype ?? "image/jpeg";

    const attendance = await attendanceService.qrCheckInEmployee(
      req.user.id,
      {
        token,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        accuracy_m: accuracy_m ? parseFloat(accuracy_m) : null,
        client_record_id: client_record_id ?? null,
        device_info: device_info ? JSON.parse(device_info) : null,
      },
      fileBuffer,
      mimeType
    );

    return res.status(201).json({
      data: {
        attendanceId: attendance.id,
        status: attendance.status,
        checkInTime: attendance.check_in_time,
        selfieUrl: attendance.check_in_selfie_url,
        geofence: { status: "qr" },
      },
    });
  } catch (err) {
    return handleError(res, err, "QR check-in");
  }
}

// ─── Read Endpoints ───────────────────────────────────────────────────────────

/**
 * GET /api/attendance/today
 * Owner + HR: all employees' attendance for today.
 */
async function getToday(req, res) {
  try {
    const data = await attendanceService.getTodayAttendance(req.user.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get today attendance");
  }
}

/**
 * GET /api/attendance/monthly?month=2082-08
 * Owner + HR: all employees for a BS month.
 */
async function getMonthly(req, res) {
  try {
    const data = await attendanceService.getMonthlyAttendance(req.user.id, req.query.month);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get monthly attendance");
  }
}

/**
 * GET /api/attendance/report
 * Owner + HR: Enhanced attendance report with custom date range.
 * Query params:
 *   - month: "2082-08" (single BS month)
 *   - start_date: "2082-08-01" (start of range, BS by default)
 *   - end_date: "2082-08-30" (end of range, BS by default)
 *   - date_mode: "bs" | "ad" (set "ad" when using AD date range)
 *   - department_id: filter by department
 *   - status: filter by status (present, absent, late, etc.)
 */
async function getAttendanceReport(req, res) {
  try {
    const data = await attendanceService.getMonthlyAttendanceReport(req.user.id, req.query);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get attendance report");
  }
}

/**
 * GET /api/attendance/employee/:id?month=2082-08&page=1&limit=31
 * Owner + HR: history for a specific employee.
 */
async function getEmployeeHistory(req, res) {
  try {
    const result = await attendanceService.getEmployeeAttendance(
      req.user.id,
      req.params.id,
      req.query
    );
    return res.json(result);
  } catch (err) {
    return handleError(res, err, "Get employee attendance");
  }
}

/**
 * GET /api/attendance/me?month=2082-08&page=1&limit=31
 * Employee: own attendance history.
 */
async function getMyAttendance(req, res) {
  try {
    const result = await attendanceService.getMyAttendance(req.user.id, req.query);
    return res.json(result);
  } catch (err) {
    return handleError(res, err, "Get my attendance");
  }
}

/**
 * PUT /api/attendance/:id/manual
 */
async function manualCorrection(req, res) {
  try {
    const data = await attendanceService.manualCorrection(
      req.user.id,
      req.params.id,
      req.body
    );
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Manual correction");
  }
}

/**
 * GET /api/attendance/today/absent
 * Owner + HR: Get today's absent employees list
 */
async function getTodayAbsent(req, res) {
  try {
    const data = await attendanceService.getTodayAbsentEmployees(req.user.id);
    return res.json(data);
  } catch (err) {
    return handleError(res, err, "Get today's absent employees");
  }
}

module.exports = {
  checkIn,
  checkOut,
  qrCheckIn,
  getToday,
  getMonthly,
  getAttendanceReport,
  getEmployeeHistory,
  getMyAttendance,
  manualCorrection,
  getTodayAbsent,
};
