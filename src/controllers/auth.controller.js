const authService = require("../services/auth.service");

/**
 * GET /api/auth/me
 * Any authenticated user with an employee record.
 * Returns employee profile + password_changed.
 * Activates app_access_status on first call.
 */
async function getMe(req, res) {
  try {
    const data = await authService.getMe(req.user.id);
    return res.json({ data });
  } catch (err) {
    if (
      err.message?.includes("No employee profile") ||
      err.message?.includes("Employee record not found")
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message?.includes("User profile not found")) {
      return res.status(403).json({ error: err.message });
    }
    console.error("[auth] getMe:", err);
    return res.status(500).json({ error: err.message || "Failed to load profile" });
  }
}

/**
 * PUT /api/auth/change-password
 * Any authenticated employee.
 * Body: { currentPassword, newPassword }
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ error: "currentPassword is required" });
    }
    if (!newPassword) {
      return res.status(400).json({ error: "newPassword is required" });
    }

    const result = await authService.changePassword(
      req.user.id,
      req.user.email,
      req.accessToken,
      currentPassword,
      newPassword
    );

    return res.json(result);
  } catch (err) {
    if (err.code === "PASSWORD_TOO_SHORT") {
      return res.status(422).json({ error: err.message });
    }
    if (err.code === "WRONG_PASSWORD") {
      return res.status(401).json({ error: err.message });
    }
    console.error("[auth] changePassword:", err);
    return res.status(500).json({ error: err.message || "Failed to change password" });
  }
}

module.exports = { getMe, changePassword };
