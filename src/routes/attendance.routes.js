const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const { checkSuspension } = require("../middleware/checkSuspension");
const attendanceController = require("../controllers/attendance.controller");
const multer = require("multer");

const router = express.Router();

// ─── Multer (selfie upload, memory storage) ───────────────────────────────────
// multer v2 uses memoryStorage differently — keep it simple
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 }, // 300 KB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("Only image files are allowed for selfie"));
  },
});

router.use(requireSupabaseUser);

// ─── Employee actions — also check suspension ─────────────────────────────────

router.post(
  "/checkin",
  checkSuspension,
  upload.single("selfie"),
  attendanceController.checkIn
);

router.post("/checkout", checkSuspension, attendanceController.checkOut);

router.post(
  "/qr-checkin",
  checkSuspension,
  upload.single("selfie"),
  attendanceController.qrCheckIn
);

router.get("/me", checkSuspension, attendanceController.getMyAttendance);

// ─── Owner / HR read endpoints ────────────────────────────────────────────────

// GET /api/attendance/today
router.get("/today", requireStaffRole, attendanceController.getToday);

// GET /api/attendance/monthly?month=2082-08
router.get("/monthly", requireStaffRole, attendanceController.getMonthly);

// GET /api/attendance/employee/:id?month=2082-08&page=1&limit=31
router.get("/employee/:id", requireStaffRole, attendanceController.getEmployeeHistory);

// GET  /api/attendance/me  — employee (own attendance)
router.get("/me", requireSupabaseUser, checkSuspension, attendanceController.getMyAttendance);

// GET  /api/attendance/today/absent  — owner + hr_manager
router.get("/today/absent", requireStaffRole, attendanceController.getTodayAbsent);

// ─── Manual Corrections ────────────────────────────────────────────────────

// PUT  /api/attendance/:id/manual  — owner + hr_manager
router.put("/:id/manual", requireStaffRole, attendanceController.manualCorrection);

module.exports = router;
