const shiftsService = require("../services/shifts.service");

/**
 * GET /api/shifts
 * Owner + HR Manager: list all shifts for their org.
 */
async function list(req, res) {
  try {
    const shifts = await shiftsService.listShifts(req.user.id);
    return res.json({ data: shifts });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch shifts" });
  }
}

/**
 * POST /api/shifts
 * Owner only: create a shift.
 */
async function create(req, res) {
  try {
    const shift = await shiftsService.createShift(req.user.id, req.body);
    return res.status(201).json({ data: shift });
  } catch (err) {
    if (err.message?.includes("required")) return res.status(400).json({ error: err.message });
    const status = err.message?.includes("already exists") ? 409 : 500;
    return res.status(status).json({ error: err.message || "Failed to create shift" });
  }
}

/**
 * PUT /api/shifts/:id
 * Owner only: update a shift.
 */
async function update(req, res) {
  try {
    const shift = await shiftsService.updateShift(req.user.id, req.params.id, req.body);
    return res.json({ data: shift });
  } catch (err) {
    if (err.message === "Shift not found") return res.status(404).json({ error: err.message });
    const status = err.message?.includes("already exists") ? 409 : 500;
    return res.status(status).json({ error: err.message || "Failed to update shift" });
  }
}

/**
 * DELETE /api/shifts/:id
 * Owner only: delete a shift.
 */
async function remove(req, res) {
  try {
    await shiftsService.deleteShift(req.user.id, req.params.id);
    return res.status(204).send();
  } catch (err) {
    if (err.message === "Shift not found") return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: err.message || "Failed to delete shift" });
  }
}

module.exports = { list, create, update, remove };
