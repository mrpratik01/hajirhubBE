const { supabaseAdmin } = require("../config/supabase");

/**
 * Allows only users with role = 'owner' (or super_admin for platform ops).
 * Must run after requireSupabaseUser.
 * Attaches req.profile with the user row.
 */
async function requireOwnerRole(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", req.user.id)
      .single();

    if (error || !data) {
      return res.status(403).json({ error: "User not found" });
    }

    if (!["owner", "super_admin"].includes(data.role)) {
      return res.status(403).json({ error: "Forbidden: owner access required" });
    }

    req.profile = data;
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || "Authorization check failed" });
  }
}

module.exports = { requireOwnerRole };
