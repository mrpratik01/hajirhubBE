const { supabaseAdmin } = require("../config/supabase");
const crypto = require("crypto");

/**
 * Employee Credentials Service
 * 
 * This service handles:
 * 1. Creating Supabase auth users for employees
 * 2. Storing employee login credentials securely
 * 3. Managing password resets and account access
 */

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Generate a secure random password
 */
function generateSecurePassword(length = 12) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let password = "";
  
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  
  return password;
}

/**
 * Hash password for storage (never store plain passwords)
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Generate employee username based on email or employee code
 */
function generateUsername(email, employeeCode) {
  if (email) {
    return email.split('@')[0];
  }
  return employeeCode.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Create Supabase auth user for employee
 */
async function createAuthUser(email, password, metadata = {}) {
  try {
    console.log('[Auth] Creating auth user for email:', email);
    
    const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for employee accounts
      user_metadata: {
        role: 'employee',
        employee_type: 'staff',
        ...metadata
      }
    });

    if (error) {
      console.error('[Auth] Supabase auth error:', error);
      throw error;
    }
    
    console.log('[Auth] Auth user created successfully:', authUser.user.id);
    return authUser.user;
  } catch (error) {
    console.error('[Auth] Error creating auth user:', error);
    throw error;
  }
}

/**
 * Store employee credentials in secure table
 */
async function storeEmployeeCredentials(employeeId, orgId, credentials) {
  try {
    const { data, error } = await supabaseAdmin
      .from('employee_credentials')
      .insert({
        employee_id: employeeId,
        org_id: orgId,
        email: credentials.email,
        password_hash: hashPassword(credentials.password),
        is_active: true,
        provisioned_by: credentials.created_by
      })
      .select('*')
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error storing credentials:', error);
    throw error;
  }
}

/**
 * Create complete employee account with auth
 */
async function createEmployeeAccount(employeeData, createdBy) {
  try {
    const { email, employee_code, full_name, org_id } = employeeData;
    
    // Generate password
    const password = generateSecurePassword();
    
    // Create Supabase auth user
    const authUser = await createAuthUser(email, password, {
      employee_code,
      full_name,
      org_id
    });

    // Store credentials
    const credentials = await storeEmployeeCredentials(employeeData.id, org_id, {
      email,
      password,
      created_by: createdBy
    });

    // Update employee record with user_id
    const { data: updatedEmployee, error: updateError } = await supabaseAdmin
      .from('employees')
      .update({ 
        user_id: authUser.id,
        app_access_status: 'active'
      })
      .eq('id', employeeData.id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return {
      employee: updatedEmployee,
      auth_user: {
        id: authUser.id,
        email: authUser.email,
        created_at: authUser.created_at
      },
      credentials: {
        email: email,
        password: password,
        employee_code: employee_code,
        message: 'Save these credentials securely. They will not be shown again.'
      },
      message: 'Employee account created successfully. Login credentials provided.'
    };
  } catch (error) {
    console.error('Error creating employee account:', error);
    
    // Cleanup: if auth user was created but employee update failed, delete auth user
    if (error.message.includes('employee update') && authUser) {
      await supabaseAdmin.auth.admin.deleteUser(authUser.id);
    }
    
    throw error;
  }
}

/**
 * Get employee credentials (for admin/owner only)
 */
async function getEmployeeCredentials(employeeId, requesterId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('employee_credentials')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('is_active', true)
      .single();

    if (error) throw error;
    if (!data) throw new Error('No credentials found for this employee');

    return {
      email: data.email,
      is_active: data.is_active,
      created_at: data.created_at,
      provisioned_by: data.provisioned_by,
      note: 'Password hash is stored securely. Use reset password to generate new credentials.'
    };
  } catch (error) {
    console.error('Error getting employee credentials:', error);
    throw error;
  }
}

/**
 * Reset employee password
 */
async function resetEmployeePassword(employeeId, requesterId) {
  try {
    const newPassword = generateSecurePassword();
    
    // Get current credentials and employee info
    const { data: currentCreds, error: fetchError } = await supabaseAdmin
      .from('employee_credentials')
      .select(`
        email,
        employee:employee_id(user_id, email)
      `)
      .eq('employee_id', employeeId)
      .single();

    if (fetchError) throw fetchError;
    if (!currentCreds) throw new Error('Employee credentials not found');

    // Update Supabase auth user password
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      currentCreds.employee.user_id,
      { password: newPassword }
    );

    if (authError) throw authError;

    // Update credentials record
    const { data, error } = await supabaseAdmin
      .from('employee_credentials')
      .update({
        password_hash: hashPassword(newPassword),
        updated_at: new Date().toISOString()
      })
      .eq('employee_id', employeeId)
      .select('*')
      .single();

    if (error) throw error;

    return {
      email: data.email,
      temporary_password: newPassword,
      message: 'Password reset successful. New password generated.'
    };
  } catch (error) {
    console.error('Error resetting employee password:', error);
    throw error;
  }
}

/**
 * Deactivate employee credentials
 */
async function deactivateEmployeeCredentials(employeeId, requesterId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('employee_credentials')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('employee_id', employeeId)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error deactivating employee credentials:', error);
    throw error;
  }
}

module.exports = {
  // Core account creation
  createEmployeeAccount,
  createAuthUser,
  storeEmployeeCredentials,
  
  // Credential management
  getEmployeeCredentials,
  resetEmployeePassword,
  deactivateEmployeeCredentials,
  
  // Utilities
  generateSecurePassword,
  generateUsername
};
