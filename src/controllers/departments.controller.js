const departmentsService = require("../services/departments.service");

/**
 * GET /api/departments
 * Owner + HR Manager: list all departments for their org.
 */
async function list(req, res) {
  try {
    const departments = await departmentsService.listDepartments(req.user.id);
    return res.json({ data: departments });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch departments" });
  }
}

/**
 * POST /api/departments
 * Owner only: create a department.
 */
async function create(req, res) {
  try {
    const department = await departmentsService.createDepartment(req.user.id, req.body);
    return res.status(201).json({ data: department });
  } catch (err) {
    const status = err.message?.includes("already exists") ? 409 : 500;
    return res.status(status).json({ error: err.message || "Failed to create department" });
  }
}

/**
 * PUT /api/departments/:id
 * Owner only: update a department.
 */
async function update(req, res) {
  try {
    const department = await departmentsService.updateDepartment(
      req.user.id,
      req.params.id,
      req.body
    );
    return res.json({ data: department });
  } catch (err) {
    if (err.message === "Department not found") return res.status(404).json({ error: err.message });
    const status = err.message?.includes("already exists") ? 409 : 500;
    return res.status(status).json({ error: err.message || "Failed to update department" });
  }
}

/**
 * DELETE /api/departments/:id
 * Owner only: delete a department.
 */
async function remove(req, res) {
  try {
    await departmentsService.deleteDepartment(req.user.id, req.params.id);
    return res.status(204).send();
  } catch (err) {
    if (err.message === "Department not found") return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: err.message || "Failed to delete department" });
  }
}

module.exports = { list, create, update, remove };
