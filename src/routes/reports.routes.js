const express = require("express");
const router = express.Router();
const reportsController = require("../controllers/reports.controller");
const { requireSupabaseUser } = require("../middleware/auth");
const checkSuspension = require("../middleware/checkSuspension");
const { requireStaffRole } = require("../middleware/rbac");

// All reports routes require being a logged-in staff member (Owner/HR)
router.use(requireSupabaseUser);
router.use(checkSuspension);
router.use(requireStaffRole);

router.get("/", reportsController.listReports);
router.post("/generate", reportsController.generateReport);
router.delete("/:id", reportsController.deleteReport);

module.exports = router;
 