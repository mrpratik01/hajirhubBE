const { supabaseAdmin } = require("../config/supabase");

async function requireOwnerRole(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) {
      console.error("[requireOwnerRole] DB error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(403).json({ error: "User profile not found — run PUT /api/users/me first" });
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
