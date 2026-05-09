const { supabaseAdmin, supabaseForUser } = require("../config/supabase");

/**
 * GET /api/auth/me
 *
 * Returns the employee profile for the authenticated user.
 * Side effects:
 *  - If app_access_status === 'invited' → set to 'active' (first login)
 *  - Always updates public.users.last_login_at
 *
 * Returns: { ...employeeProfile, password_changed }
 */
async function getMe(userId) {
  // 1. Look up public.users
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id, employee_id, password_changed")
    .eq("id", userId)
    .maybeSingle();

  if (userError) throw userError;
  if (!user) throw new Error("User profile not found");
  if (!user.employee_id) throw new Error("No employee profile linked to this account");

  // 2. Look up employee
  const { data: employee, error: empError } = await supabaseAdmin
    .from("employees")
    .select(
      `id, employee_code, full_name, full_name_nepali, phone, email,
       gender, designation, status, app_access_status, photo_url,
       join_date_bs, join_date_ad,
       department:department_id(id, name),
       shift:shift_id(id, name, start_time, end_time),
       workplace:workplace_id(id, name, address, latitude, longitude)`
    )
    .eq("id", user.employee_id)
    .eq("org_id", user.org_id)
    .maybeSingle();

  if (empError) throw empError;
  if (!employee) throw new Error("Employee record not found");

  // 3. Activate on first login
  if (employee.app_access_status === "invited") {
    await supabaseAdmin
      .from("employees")
      .update({ app_access_status: "active" })
      .eq("id", employee.id);

    employee.app_access_status = "active";
  }

  // 4. Update last_login_at
  await supabaseAdmin
    .from("users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", userId);

  return {
    ...employee,
    password_changed: user.password_changed ?? false,
  };
}

/**
 * PUT /api/auth/change-password
 *
 * Verifies current password by re-authenticating, then updates to new password.
 * Sets public.users.password_changed = true on success.
 * Sets employee_credentials.is_active = false (temp password no longer valid).
 */
async function changePassword(userId, userEmail, accessToken, currentPassword, newPassword) {
  // 1. Validate new password length
  if (!newPassword || newPassword.length < 8) {
    const err = new Error("Password must be at least 8 characters");
    err.code = "PASSWORD_TOO_SHORT";
    throw err;
  }

  // 2. Re-authenticate with current password to verify it's correct
  const supabaseUser = supabaseForUser(accessToken);
  const { error: signInError } = await supabaseUser.auth.signInWithPassword({
    email: userEmail,
    password: currentPassword,
  });

  if (signInError) {
    const err = new Error("Current password is incorrect");
    err.code = "WRONG_PASSWORD";
    throw err;
  }

  // 3. Update password via admin API
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });

  if (updateError) throw new Error(`Failed to update password: ${updateError.message}`);

  // 4. Mark password as changed in public.users
  // Also fetch employee_id so we can delete the credential record
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("employee_id, org_id")
    .eq("id", userId)
    .maybeSingle();

  await supabaseAdmin
    .from("users")
    .update({ password_changed: true })
    .eq("id", userId);

  // 5. Delete the credential record — temp password is no longer needed
  if (userRow?.employee_id) {
    await supabaseAdmin
      .from("employee_credentials")
      .delete()
      .eq("employee_id", userRow.employee_id)
      .eq("org_id", userRow.org_id);
  }

  return { message: "Password changed successfully" };
}

module.exports = { getMe, changePassword };
