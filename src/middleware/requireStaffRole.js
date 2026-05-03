const usersService = require("../services/users.service");

const STAFF_ROLES = new Set(["super_admin", "owner", "hr_manager"]);

/**
 * After requireSupabaseUser. Allows listing/managing users only for staff roles
 * as stored in public.users.role.
 */
async function requireStaffRole(req, res, next) {
  try {
    const row = await usersService.getUserRowById(req.user.id);
    if (!row || !STAFF_ROLES.has(row.role)) {
      return res.status(403).json({ error: "Forbidden: super_admin, owner, or hr_manager role required" });
    }
    req.profile = row;
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || "Role check failed" });
  }
}

module.exports = { requireStaffRole, STAFF_ROLES };
