const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const departmentsController = require("../controllers/departments.controller");

const router = express.Router();

// All routes require a valid Supabase session
router.use(requireSupabaseUser);

// GET  /api/departments  — owner + hr_manager
router.get("/", requireStaffRole, departmentsController.list);

// POST /api/departments  — owner only
router.post("/", requireOwnerRole, departmentsController.create);

// PUT  /api/departments/:id  — owner only
router.put("/:id", requireOwnerRole, departmentsController.update);

// DELETE /api/departments/:id  — owner only
router.delete("/:id", requireOwnerRole, departmentsController.remove);

module.exports = router;
