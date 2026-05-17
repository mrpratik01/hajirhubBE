const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/payroll.controller");
const { requireSupabaseUser } = require("../middleware/auth");
const { checkSuspension } = require("../middleware/checkSuspension");

// All payroll routes require being a logged-in staff member (Owner/HR)
router.use(requireSupabaseUser);
router.use(checkSuspension);

// ─── Config ──────────────────────────────────────────────────────────────────
router.get("/config", payrollController.getConfig);
router.put("/config", payrollController.updateConfig);

// ─── Advances ────────────────────────────────────────────────────────────────
router.get("/advances", payrollController.listAdvances);
router.post("/advances", payrollController.createAdvance);
router.put("/advances/:id/status", payrollController.updateAdvanceStatus);

// ─── TDS Slabs ───────────────────────────────────────────────────────────────
router.get("/tds-slabs", payrollController.getTdsSlabs);

// ─── Payroll Runs ────────────────────────────────────────────────────────────
router.get("/runs", payrollController.listRuns);
router.get("/runs/:id", payrollController.getRunDetails);
router.post("/runs", payrollController.generateRun);
router.put("/runs/:id/finalize", payrollController.finalizeRun);
router.delete("/runs/:id", payrollController.deleteRun);

module.exports = router;
