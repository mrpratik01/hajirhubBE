const orgsService = require("../services/organizations.service");

/**
 * GET /api/admin/organizations
 * List all organizations with pagination and optional search.
 * Query params: limit, offset, search
 */
async function listAll(req, res) {
  try {
    const { limit, offset, search } = req.query;
    const result = await orgsService.listAllOrgs({ limit, offset, search });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to list organizations" });
  }
}

/**
 * GET /api/admin/organizations/:id
 * Get any single org by id.
 */
async function getById(req, res) {
  try {
    const org = await orgsService.getOrgById(req.params.id);
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }
    return res.json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch organization" });
  }
}

/**
 * PUT /api/admin/organizations/:id
 * Update any org by id.
 */
async function updateById(req, res) {
  try {
    const org = await orgsService.updateOrgById(req.params.id, req.body);
    return res.json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to update organization" });
  }
}

/**
 * PATCH /api/admin/organizations/:id/toggle
 * Activate or deactivate an org.
 * Body: { is_active: boolean, reason?: string }
 */
async function toggle(req, res) {
  try {
    const { is_active, reason } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "is_active (boolean) is required" });
    }

    const org = await orgsService.toggleOrgById(req.params.id, is_active, reason);
    return res.json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to toggle organization" });
  }
}

module.exports = { listAll, getById, updateById, toggle };
