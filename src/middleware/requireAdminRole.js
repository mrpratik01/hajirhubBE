const { supabaseAdmin } = require("../config/supabase");

/**
 * Checks that the authenticated user has role = 'admin' or 'super_admin'
 * in the public.users table. Must run after requireSupabaseUser.
 */
async function requireAdminPlanRole(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (error || !data) {
      return res.status(403).json({ error: "User not found" });
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
