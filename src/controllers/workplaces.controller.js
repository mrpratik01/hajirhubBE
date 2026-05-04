const workplacesService = require("../services/workplaces.service");

/**
 * GET /api/workplaces
 * Owner + HR: list all workplaces for the org.
 */
async function list(req, res) {
  try {
    const workplaces = await workplacesService.listWorkplaces(req.user.id);
    return res.json({ data: workplaces });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch workplaces" });
  }
}

/**
 * POST /api/workplaces
 * Owner only: create a workplace.
 */
async function create(req, res) {
  try {
    const workplace = await workplacesService.createWorkplace(req.user.id, req.body);
    return res.status(201).json({ data: workplace });
  } catch (err) {
    if (err.message?.includes("required") || err.message?.includes("radius_meters")) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || "Failed to create workplace" });
  }
}

/**
 * GET /api/workplaces/:id
 * Owner + HR: get a single workplace.
 */
async function get(req, res) {
  try {
    const workplace = await workplacesService.getWorkplace(req.user.id, req.params.id);
    return res.json({ data: workplace });
  } catch (err) {
    if (err.message === "Workplace not found") return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: err.message || "Failed to fetch workplace" });
  }
}

/**
 * PUT /api/workplaces/:id
 * Owner only: update name, address, flags, etc.
 */
async function update(req, res) {
  try {
    const workplace = await workplacesService.updateWorkplace(req.user.id, req.params.id, req.body);
    return res.json({ data: workplace });
  } catch (err) {
    if (err.message === "Workplace not found") return res.status(404).json({ error: err.message });
    if (err.message?.includes("radius_meters") || err.message?.includes("No valid")) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || "Failed to update workplace" });
  }
}

/**
 * PUT /api/workplaces/:id/geofence
 * Owner only: update lat, lng, radius_meters, geofence_enabled.
 */
async function updateGeofence(req, res) {
  try {
    const workplace = await workplacesService.updateGeofence(req.user.id, req.params.id, req.body);
    return res.json({ data: workplace });
  } catch (err) {
    if (err.message === "Workplace not found") return res.status(404).json({ error: err.message });
    if (err.message?.includes("radius_meters") || err.message?.includes("No valid")) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || "Failed to update geofence" });
  }
}

/**
 * GET /api/workplaces/:id/qr-token
 * Owner + HR: get active QR token, auto-generates if none exists.
 */
async function getQRToken(req, res) {
  try {
    const token = await workplacesService.getOrCreateQRToken(req.user.id, req.params.id);
    return res.json({ data: token });
  } catch (err) {
    if (err.message === "Workplace not found") return res.status(404).json({ error: err.message });
    if (err.message?.includes("not enabled")) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: err.message || "Failed to get QR token" });
  }
}

/**
 * POST /api/workplaces/:id/rotate-qr
 * Owner only: invalidate current token and issue a new one.
 */
async function rotateQRToken(req, res) {
  try {
    const token = await workplacesService.rotateQRToken(req.user.id, req.params.id);
    return res.json({ data: token });
  } catch (err) {
    if (err.message === "Workplace not found") return res.status(404).json({ error: err.message });
    if (err.message?.includes("not enabled")) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: err.message || "Failed to rotate QR token" });
  }
}

module.exports = { list, create, get, update, updateGeofence, getQRToken, rotateQRToken };
