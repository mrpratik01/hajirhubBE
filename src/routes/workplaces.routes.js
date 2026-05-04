const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const workplacesController = require("../controllers/workplaces.controller");

const router = express.Router();

router.use(requireSupabaseUser);

// GET  /api/workplaces          — owner + hr_manager
router.get("/", requireStaffRole, workplacesController.list);

// POST /api/workplaces          — owner only
router.post("/", requireOwnerRole, workplacesController.create);

// GET  /api/workplaces/:id      — owner + hr_manager
router.get("/:id", requireStaffRole, workplacesController.get);

// PUT  /api/workplaces/:id/geofence  — owner only  (must come before /:id)
router.put("/:id/geofence", requireOwnerRole, workplacesController.updateGeofence);

// PUT  /api/workplaces/:id      — owner only
router.put("/:id", requireOwnerRole, workplacesController.update);

// GET  /api/workplaces/:id/qr-token  — owner + hr_manager
router.get("/:id/qr-token", requireStaffRole, workplacesController.getQRToken);

// POST /api/workplaces/:id/rotate-qr — owner only
router.post("/:id/rotate-qr", requireOwnerRole, workplacesController.rotateQRToken);

module.exports = router;
