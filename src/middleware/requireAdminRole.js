const { supabaseAdmin } = require("../config/supabase");

async function requireAdminPlanRole(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) {
      console.error("[requireAdminPlanRole] DB error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(403).json({ error: "User profile not found — run PUT /api/users/me first" });
    }

    const allowedRoles = ["admin", "super_admin"];
    if (!allowedRoles.includes(data.role)) {
      return res.status(403).json({ error: "Forbidden: admin access required" });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || "Authorization check failed" });
  }
}

module.exports = { requireAdminPlanRole };
