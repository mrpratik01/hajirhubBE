const express = require("express");
const router = express.Router();
const hardwareController = require("../controllers/hardware.controller");
const { requireSupabaseUser } = require("../middleware/auth");
const { checkSuspension } = require("../middleware/checkSuspension");
const { requireStaffRole } = require("../middleware/requireStaffRole");

/**
 * ADMS (Push SDK) Endpoints
 * These MUST be at /iclock/... and do NOT use standard Bearer Auth
 */
router.get("/getrequest", hardwareController.getRequest);
router.post("/cdata", hardwareController.postData);
router.get("/cdata", hardwareController.getCData);
router.post("/devicecmd", hardwareController.deviceCmd); // Added acknowledgment route

/**
 * Standard API Management Endpoints
 * These are called by the frontend (Dashboard)
 */
router.get("/devices", requireSupabaseUser, checkSuspension, requireStaffRole, hardwareController.listDevices);
router.post("/devices", requireSupabaseUser, checkSuspension, requireStaffRole, hardwareController.registerDevice);
router.put("/devices/:id", requireSupabaseUser, checkSuspension, requireStaffRole, hardwareController.updateDevice);
router.delete("/devices/:id", requireSupabaseUser, checkSuspension, requireStaffRole, hardwareController.deleteDevice);

// Employee Biometric ID Assignment
router.post("/employees/:employeeId/assign-biometric-id", requireSupabaseUser, checkSuspension, requireStaffRole, hardwareController.assignBiometricId);

module.exports = router;
