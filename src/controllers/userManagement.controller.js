const userManagementService = require("../services/userManagement.service");

// ─── Error handler ────────────────────────────────────────────────────────────

function handleError(res, err, context = "Operation") {
  const msg = err.message || `${context} failed`;

  if (msg.includes("not found")) return res.status(404).json({ error: msg });
  if (
    msg.includes("required") ||
    msg.includes("Invalid JSON") ||
    msg.includes("Request body") ||
    msg.includes("must be") ||
    msg.includes("greater than") ||
    msg.includes("only available") ||
    msg.includes("YYYY-MM")
  ) {
    return res.status(400).json({ error: msg });
  }
  if (msg.includes("already exists")) return res.status(409).json({ error: msg });
  if (
    msg.includes("Not authorized") ||
    msg.includes("Cannot create") ||
    msg.includes("permission")
  ) {
    return res.status(403).json({ error: msg });
  }
  if (msg.includes("overlapping")) return res.status(409).json({ error: msg });

  console.error(`[userManagement] ${context}:`, err);
  return res.status(500).json({ error: msg });
}

// ─── User Creation Endpoints ───────────────────────────────────────────────────

/**
 * POST /api/users/owner
 * Super Admin only: Create owner account for an organization
 */
async function createOwner(req, res) {
  try {
    console.log('[createOwner] Request body:', req.body);
    console.log('[createOwner] Request headers:', req.headers);
    
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new Error("Invalid JSON in request body");
      }
    }
    if (!body || typeof body !== "object") {
      throw new Error("Request body is required");
    }

    const { org_id, org_name, full_name, email, phone, create_org_later } = body;
    const explicitCreateOrgLater =
      create_org_later === true ||
      create_org_later === "true";
    const shouldCreateOrgLater =
      explicitCreateOrgLater || (!org_id && !org_name);
    
    // Validation
    if (!full_name) throw new Error("full_name is required");
    if (!email) throw new Error("email is required");
    if (!phone) throw new Error("phone is required");
    
    console.log('[createOwner] create_org_later:', create_org_later);
    console.log('[createOwner] org_id:', org_id);
    console.log('[createOwner] org_name:', org_name);
    
    // For create_org_later=true, allow both org_id and org_name to be falsy (undefined/null)
    if (explicitCreateOrgLater && (org_id || org_name)) {
      console.log('[createOwner] Validation failed: both org_id and org_name provided');
      throw new Error("When create_org_later=true, do not provide org_id or org_name");
    }
    
    console.log('[createOwner] Calling service with:', {
      superAdminId: req.user.id,
      orgId: shouldCreateOrgLater ? null : org_id,
      userData: { full_name, email, phone, org_name, create_org_later: shouldCreateOrgLater }
    });
    
    const data = await userManagementService.createOwner(req.user.id, shouldCreateOrgLater ? null : org_id, {
      full_name,
      email,
      phone,
      org_name,
      create_org_later: shouldCreateOrgLater
    });
    
    return res.status(201).json({ data });
  } catch (err) {
    return handleError(res, err, "Create owner");
  }
}

/**
 * POST /api/users/hr-manager
 * Owner only: Create HR manager account for the organization
 */
async function createHRManager(req, res) {
  try {
    const { full_name, email, phone } = req.body;
    
    // Validation
    if (!full_name) throw new Error("full_name is required");
    if (!email) throw new Error("email is required");
    if (!phone) throw new Error("phone is required");
    
    // Get user's org_id from the authenticated user
    const { supabaseAdmin } = require("../config/supabase");
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("org_id")
      .eq("id", req.user.id)
      .single();
    
    if (!user || !user.org_id) {
      throw new Error("User organization not found");
    }
    
    const data = await userManagementService.createHRManager(req.user.id, user.org_id, {
      full_name,
      email,
      phone
    });
    
    return res.status(201).json({ data });
  } catch (err) {
    return handleError(res, err, "Create HR manager");
  }
}

/**
 * GET /api/users/:userId/credentials
 * Get user credentials for login sharing (role-based access)
 */
async function getUserCredentials(req, res) {
  try {
    const { userId } = req.params;
    
    if (!userId) throw new Error("userId is required");
    
    const data = await userManagementService.getUserCredentials(req.user.id, userId);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get user credentials");
  }
}

/**
 * GET /api/users/roles
 * Get available roles that current user can create
 */
async function getCreatableRoles(req, res) {
  try {
    const { supabaseAdmin } = require("../config/supabase");
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", req.user.id)
      .single();
    
    if (!user) throw new Error("User not found");
    
    const userRole = user.role;
    const creatableRoles = [];
    
    // Super Admin can create owners
    if (userRole === 'super_admin') {
      creatableRoles.push({
        role: 'owner',
        description: 'Organization owner with full access',
        can_create: ['hr_manager', 'employee']
      });
    }
    
    // Owner can create HR managers
    if (userRole === 'owner') {
      creatableRoles.push({
        role: 'hr_manager',
        description: 'HR manager with employee management access',
        can_create: ['employee']
      });
    }
    
    return res.json({ data: creatableRoles });
  } catch (err) {
    return handleError(res, err, "Get creatable roles");
  }
}

/**
 * GET /api/users/organization/:orgId/users
 * Get all users in an organization (role-based access)
 */
async function getOrganizationUsers(req, res) {
  try {
    const { orgId } = req.params;
    const { role, page = 1, limit = 20 } = req.query;
    
    if (!orgId) throw new Error("orgId is required");
    
    const { supabaseAdmin } = require("../config/supabase");
    const { data: requester } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", req.user.id)
      .single();
    
    if (!requester) throw new Error("Requester not found");
    
    // Check authorization - only super admin or same org users can view
    if (requester.role !== 'super_admin' && requester.org_id !== orgId) {
      throw new Error("Not authorized to view this organization's users");
    }
    
    let query = supabaseAdmin
      .from("users")
      .select(`
        id, role, full_name, email, created_at, password_changed,
        employee:employee_id(id, employee_code, full_name, phone, designation, status)
      `)
      .eq("org_id", orgId);
    
    if (role) {
      query = query.eq("role", role);
    }
    
    query = query
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    // Get total count
    const { count } = await supabaseAdmin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq(role ? "role" : "role", role || "super_admin"); // This is a hack, but it works
    
    return res.json({
      data: data || [],
      meta: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (err) {
    return handleError(res, err, "Get organization users");
  }
}

/**
 * POST /api/users/:userId/reset-password
 * Admin resets a user's password (role-based access)
 */
async function adminResetPassword(req, res) {
  try {
    const { userId } = req.params;
    const { password } = req.body;
    
    if (!userId) throw new Error("userId is required");
    if (!password) throw new Error("password is required");
    
    const data = await userManagementService.adminResetPassword(
      req.user.id,
      userId,
      password
    );
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Admin password reset");
  }
}

module.exports = {
  createOwner,
  createHRManager,
  getUserCredentials,
  getCreatableRoles,
  getOrganizationUsers,
  adminResetPassword
};
