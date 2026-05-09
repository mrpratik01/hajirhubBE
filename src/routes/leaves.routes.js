const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const { checkSuspension } = require("../middleware/checkSuspension");
const leavesController = require("../controllers/leaves.controller");

const router = express.Router();

router.use(requireSupabaseUser);

// ─── Leave Types ──────────────────────────────────────────────────────────────

// GET  /api/leaves/types                — any authenticated user
// Owner/HR can pass ?include_inactive=true to see all types
router.get("/types", leavesController.listTypes);

// POST /api/leaves/types                — owner only
router.post("/types", requireOwnerRole, leavesController.createType);

// PUT  /api/leaves/types/:id            — owner only
router.put("/types/:id", requireOwnerRole, leavesController.updateType);

// ─── Leave Balances ───────────────────────────────────────────────────────────

// GET  /api/leaves/balances/my?year=2082        — employee (own balances)
// NOTE: must be before /balances/:employeeId
router.get("/balances/my", checkSuspension, leavesController.getMyBalances);

// GET  /api/leaves/balances/:employeeId?year=2082  — owner + hr_manager
router.get("/balances/:employeeId", requireStaffRole, leavesController.getEmployeeBalances);

// ─── Leave Requests ───────────────────────────────────────────────────────────

// GET  /api/leaves/calendar?month=2025-04  — owner + hr_manager
// NOTE: must be before /api/leaves (list all) to avoid route conflict
router.get("/calendar", requireStaffRole, leavesController.calendar);

// GET  /api/leaves/my                   — employee (own requests)
router.get("/my", checkSuspension, leavesController.listMy);

// POST /api/leaves/apply                — employee
router.post("/apply", checkSuspension, leavesController.apply);

// GET  /api/leaves                      — owner + hr_manager (all requests)
router.get("/", requireStaffRole, leavesController.list);

// PUT  /api/leaves/:id/approve          — owner + hr_manager
router.put("/:id/approve", requireStaffRole, leavesController.approve);

// PUT  /api/leaves/:id/reject           — owner + hr_manager
router.put("/:id/reject", requireStaffRole, leavesController.reject);

// PUT  /api/leaves/:id/cancel           — employee (own pending only)
router.put("/:id/cancel", checkSuspension, leavesController.cancel);

module.exports = router;
