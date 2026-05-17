const hardwareService = require("../services/hardware.service");
const { handleError } = require("../middleware/errorHandler");

/**
 * GET /iclock/getrequest
 * Device polls for commands.
 */
async function getRequest(req, res) {
  try {
    const response = await hardwareService.handleGetRequest(req.query);
    return res.send(response);
  } catch (err) {
    console.error("[HardwareController] getRequest error:", err);
    return res.send("OK"); // Fail safe for device
  }
}

/**
 * POST /iclock/cdata
 * Device pushes data (Attendance logs).
 */
async function postData(req, res) {
  try {
    // Note: req.body must be the raw text/plain body from ADMS
    const response = await hardwareService.handlePostData(req.query, req.body);
    return res.send(response);
  } catch (err) {
    console.error("[HardwareController] postData error:", err);
    return res.send("OK"); // Fail safe for device
  }
}

/**
 * GET /iclock/cdata
 * Basic device check-in.
 */
async function getCData(req, res) {
  return res.send("OK");
}

// ─── API Management ──────────────────────────────────────────────────────────

async function listDevices(req, res) {
  try {
    const data = await hardwareService.listDevices(req.user.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "List devices");
  }
}

async function registerDevice(req, res) {
  try {
    const data = await hardwareService.registerDevice(req.user.id, req.body);
    return res.status(201).json({ data });
  } catch (err) {
    return handleError(res, err, "Register device");
  }
}

async function updateDevice(req, res) {
  try {
    const data = await hardwareService.updateDevice(req.user.id, req.params.id, req.body);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Update device");
  }
}

async function deleteDevice(req, res) {
  try {
    const data = await hardwareService.deleteDevice(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Delete device");
  }
}

async function assignBiometricId(req, res) {
  try {
    const { employeeId } = req.params;
    const { biometric_user_id } = req.body;
    const data = await hardwareService.assignBiometricId(req.user.id, employeeId, biometric_user_id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Assign biometric ID");
  }
}

/**
 * POST /iclock/devicecmd
 * Device acknowledges command execution.
 */
async function deviceCmd(req, res) {
  try {
    const response = await hardwareService.handleDeviceCmd(req.query, req.body);
    return res.send(response);
  } catch (err) {
    console.error("[HardwareController] deviceCmd error:", err);
    return res.send("OK");
  }
}

module.exports = {
  getRequest,
  postData,
  getCData,
  deviceCmd, // Added
  listDevices,
  registerDevice,
  updateDevice,
  deleteDevice,
  assignBiometricId
};
