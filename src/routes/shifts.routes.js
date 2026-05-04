const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const shiftsController = require("../controllers/shifts.controller");

const router = express.Router();

// All routes require a valid Supabase session
router.use(requireSupabaseUser);

// GET  /api/shifts  — owner + hr_manager
router.get("/", requireStaffRole, shiftsController.list);

// POST /api/shifts  — owner only
router.post("/", requireOwnerRole, shiftsController.create);

// PUT  /api/shifts/:id  — owner only
router.put("/:id", requireOwnerRole, shiftsController.update);

// DELETE /api/shifts/:id  — owner only
router.delete("/:id", requireOwnerRole, shiftsController.remove);

module.exports = router;
