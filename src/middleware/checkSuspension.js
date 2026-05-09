const { supabaseAdmin } = require("../config/supabase");

/**
 * Blocks suspended employees from accessing employee-facing routes.
 * Must run after requireSupabaseUser.
 *
 * Supabase's ban_duration prevents new token issuance, but existing
 * short-lived tokens may still be valid briefly. This middleware provides
 * an immediate application-layer block regardless of token state.
 *
 * Only applies to users with role = 'employee'. Owners and HR managers
 * are not blocked by this middleware.
 */
async function checkSuspension(req, res, next) {
  try {
    // Only check employees — owners/HR are never suspended via this flow
    const { data: emp, error } = await supabaseAdmin
      .from("employees")
      .select("app_access_status")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (error) {
      // Non-fatal — if we can't check, let the request through
      // The auth token itself is still valid
      console.error("[checkSuspension] DB error:", error.message);
      return next();
    }

    if (emp?.app_access_status === "suspended") {
      return res.status(403).json({
        error: "Your account access has been suspended. Contact your organization admin.",
      });
    }

    return next();
  } catch (err) {
    console.error("[checkSuspension] Unexpected error:", err.message);
    return next(); // Non-fatal — don't block on middleware errors
  }
}

module.exports = { checkSuspension };
