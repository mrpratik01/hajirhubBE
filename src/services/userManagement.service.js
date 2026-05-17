const { supabaseAdmin } = require("../config/supabase");

// ─── Role hierarchy ───────────────────────────────────────────────────────────

/**
 * Define role hierarchy for authorization checks
 * Higher roles can create lower roles
 */
const ROLE_HIERARCHY = {
  super_admin: 4,
  owner: 3,
  hr_manager: 2,
  employee: 1
};

/**
 * Check if a user can create a target role
 */
function canCreateRole(userRole, targetRole) {
  return ROLE_HIERARCHY[userRole] > ROLE_HIERARCHY[targetRole];
}

function isMissingSchemaColumnError(error, columnName) {
  return (
    error?.message?.includes(`'${columnName}' column`) ||
    error?.message?.includes(`column "${columnName}"`) ||
    error?.details?.includes(columnName)
  );
}

// ─── User creation functions ───────────────────────────────────────────────────

/**
 * Create Supabase auth user with role metadata
 */
async function createAuthUser(email, password, role, metadata = {}) {
  try {
    console.log(`[UserManagement] Creating auth user for email: ${email}, role: ${role}`);
    
    const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for admin accounts
      user_metadata: {
        role,
        ...metadata
      }
    });

    if (error) {
      console.error('[UserManagement] Supabase auth error:', error);
      throw error;
    }
    
    console.log(`[UserManagement] Auth user created successfully: ${authUser.user.id}`);
    return authUser.user;
  } catch (error) {
    console.error('[UserManagement] Error creating auth user:', error);
    throw error;
  }
}

/**
 * Create public.users record for the auth user
 */
async function createUserProfile(authUserId, orgId, role, createdBy, metadata = {}) {
  try {
    const profile = {
      id: authUserId,
      org_id: orgId,
      role: role,
      full_name: metadata.full_name || '',
      email: metadata.email || '',
      phone: metadata.phone || null,
      password_changed: false
    };

    const { data, error } = await supabaseAdmin
      .from("users")
      .upsert(profile, { onConflict: "id" })
      .select("*")
      .single();

    if (isMissingSchemaColumnError(error, "password_changed")) {
      delete profile.password_changed;
      const { data: retryData, error: retryError } = await supabaseAdmin
        .from("users")
        .upsert(profile, { onConflict: "id" })
        .select("*")
        .single();

      if (retryError) throw retryError;
      return retryData;
    }

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[UserManagement] Error creating user profile:', error);
    throw error;
  }
}

// ─── User creation by role ─────────────────────────────────────────────────────

/**
 * Super Admin creates Owner account
 * Workflow 1: Create owner without organization (owner creates org later)
 * Workflow 2: Create owner for existing organization
 */
async function createOwner(superAdminId, orgId, userData) {
  console.log('[UserManagement] createOwner called with:', { superAdminId, orgId, userData });
  
  const { full_name, email, phone, org_name, create_org_later = false } = userData;
  const explicitCreateOrgLater =
    create_org_later === true ||
    create_org_later === "true";
  const shouldCreateOrgLater = explicitCreateOrgLater || (!orgId && !org_name);
  
  const password = email;
  
  try {
    let targetOrgId = orgId;
    let organization = null;
    
    // Workflow 1: Create owner without organization (owner will create org later)
    if (shouldCreateOrgLater) {
      if (orgId || org_name) {
        throw new Error("When create_org_later=true, do not provide org_id or org_name. Owner will create organization later.");
      }
      
      // Create auth user without org_id initially
      const authUser = await createAuthUser(email, password, 'owner', {
        full_name
        // No org_id - will be set when owner creates organization
      });
      
      // Create user profile without org_id initially
      const userProfile = await createUserProfile(authUser.id, null, 'owner', superAdminId, {
        full_name,
        email,
        phone
      });
      
      return {
        user: userProfile,
        auth_user: {
          id: authUser.id,
          email: authUser.email,
          created_at: authUser.created_at
        },
        credentials: {
          email: email,
          password: password,
          message: 'Owner account created. Initial password is the owner email.'
        },
        role: 'owner',
        created_by: superAdminId,
        organization: null,
        next_step: 'create_organization',
        instruction: 'Owner should log in and create organization with full details'
      };
    }
    
    // Workflow 2: Create owner for existing organization OR create new organization
    if (orgId) {
      const { data: existingOrg, error: orgError } = await supabaseAdmin
        .from("organizations")
        .select("id, name")
        .eq("id", orgId)
        .maybeSingle();
      
      if (orgError) throw orgError;
      if (!existingOrg) throw new Error("Organization not found");
      
      organization = existingOrg;
      targetOrgId = orgId;
    } 
    // If org_name provided, create new organization
    else if (org_name) {
      const { data: newOrg, error: createOrgError } = await supabaseAdmin
        .from("organizations")
        .insert({
          name: org_name,
          created_by: superAdminId,
          // Admin responsible for org setup - owner gets access after creation
          status: 'active',
          subscription_plan: 'trial' // Default plan, can be updated later
        })
        .select("*")
        .single();
      
      if (createOrgError) throw createOrgError;
      if (!newOrg) throw new Error("Failed to create organization");
      
      organization = newOrg;
      targetOrgId = newOrg.id;
    }
    // This path is intentionally unreachable when org details are omitted:
    // no org now means the owner will create it after first login.
    else {
      throw new Error("Either org_id (for existing org) or org_name (for new org) is required");
    }
    
    // Create auth user
    const authUser = await createAuthUser(email, password, 'owner', {
      full_name,
      org_id: targetOrgId
    });
    
    // Create user profile
    const userProfile = await createUserProfile(authUser.id, targetOrgId, 'owner', superAdminId, {
      full_name,
      email,
      phone
    });
    
    return {
      user: userProfile,
      auth_user: {
        id: authUser.id,
        email: authUser.email,
        created_at: authUser.created_at
      },
      credentials: {
        email: email,
        password: password,
        message: 'Owner account created. Initial password is the owner email.'
      },
      role: 'owner',
      created_by: superAdminId,
      organization: organization,
      workflow: targetOrgId ? 'existing_org' : 'new_org'
    };
  } catch (error) {
    console.error('[UserManagement] Error creating owner:', error);
    throw new Error(`Failed to create owner account: ${error.message}`);
  }
}

/**
 * Owner creates HR Manager account
 */
async function createHRManager(ownerId, orgId, userData) {
  const { full_name, email, phone } = userData;
  const password = email;
  
  try {
    // Create auth user
    const authUser = await createAuthUser(email, password, 'hr_manager', {
      full_name,
      org_id: orgId
    });
    
    // Create user profile
    const userProfile = await createUserProfile(authUser.id, orgId, 'hr_manager', ownerId, {
      full_name,
      email,
      phone
    });
    
    return {
      user: userProfile,
      auth_user: {
        id: authUser.id,
        email: authUser.email,
        created_at: authUser.created_at
      },
      credentials: {
        email: email,
        password: password,
        message: 'HR manager account created. Initial password is the HR email.'
      },
      role: 'hr_manager',
      created_by: ownerId
    };
  } catch (error) {
    console.error('[UserManagement] Error creating HR manager:', error);
    throw new Error(`Failed to create HR manager account: ${error.message}`);
  }
}

/**
 * Get user credentials for login sharing
 */
async function getUserCredentials(requesterId, targetUserId) {
  try {
    const { data: requester, error: requesterError } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", requesterId)
      .single();

    if (requesterError) throw requesterError;

    const { data: targetUser, error: targetError } = await supabaseAdmin
      .from("users")
      .select("role, org_id, email")
      .eq("id", targetUserId)
      .single();

    if (targetError) throw targetError;

    // Check authorization - can only get credentials for same org and lower/equal role
    if (requester.org_id !== targetUser.org_id || !canCreateRole(requester.role, targetUser.role)) {
      throw new Error("Not authorized to access these credentials");
    }

    return {
      email: targetUser.email,
      password: targetUser.email,
      is_active: true,
      note: "Initial password is the user's email address.",
    };
  } catch (error) {
    console.error('[UserManagement] Error getting user credentials:', error);
    throw error;
  }
}

/**
 * Administrative password reset - allows reset without email interaction
 */
async function adminResetPassword(requesterId, targetUserId, newPassword) {
  try {
    // 1. Get requester and target user details
    const { data: requester, error: e1 } = await supabaseAdmin
      .from("users")
      .select("role, org_id")
      .eq("id", requesterId)
      .single();
    if (e1) throw e1;

    const { data: targetUser, error: e2 } = await supabaseAdmin
      .from("users")
      .select("role, org_id, email")
      .eq("id", targetUserId)
      .single();
    if (e2) throw e2;

    // 2. Authorization check
    const isSuperAdmin = requester.role === "super_admin";
    
    // Super Admin can reset anyone's password
    // Owner can reset anyone in their org (except themselves/other owners)
    // HR can reset anyone in their org with lower role (employees)
    let authorized = false;
    if (isSuperAdmin) {
      authorized = true;
    } else if (requester.org_id === targetUser.org_id) {
      if (canCreateRole(requester.role, targetUser.role)) {
        authorized = true;
      }
    }

    if (!authorized) {
      throw new Error("Not authorized to reset this user's password");
    }

    // 3. Update password in Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      targetUserId,
      { password: newPassword }
    );
    if (authError) throw authError;

    // 4. Reset password_changed flag so they are prompted to change it again on next login
    await supabaseAdmin
      .from("users")
      .update({ password_changed: false })
      .eq("id", targetUserId);

    return { 
      message: "Password reset successfully", 
      email: targetUser.email,
      user_id: targetUserId
    };
  } catch (error) {
    console.error('[UserManagement] Error in adminResetPassword:', error);
    throw error;
  }
}

module.exports = {
  createOwner,
  createHRManager,
  getUserCredentials,
  adminResetPassword,
  canCreateRole,
  ROLE_HIERARCHY
};
