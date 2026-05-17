/**
 * Middleware to require Super Admin role
 * Super Admin can create owner accounts and access all organizations
 */
async function requireSuperAdminRole(req, res, next) {
  try {
    const { supabaseAdmin } = require("../config/supabase");
    
    // Get user role from public.users table
    const { data: user, error } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;
    if (!user) throw new Error("User profile not found");
    if (user.role !== "super_admin") {
      return res.status(403).json({ 
        error: "Super Admin access required" 
      });
    }

    // Add user info to request for downstream use
    req.userRole = user.role;
    req.userOrgId = user.org_id;
    
    next();
  } catch (err) {
    console.error("[requireSuperAdminRole] Error:", err);
    return res.status(500).json({ 
      error: "Authorization check failed" 
    });
  }
}

module.exports = { requireSuperAdminRole };
