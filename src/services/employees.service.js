const { supabaseAdmin } = require("../config/supabase");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const employeeCredentialsService = require("./employeeCredentials.service");

// ─── Encryption helpers ───────────────────────────────────────────────────────
// AES-256-GCM: symmetric encryption so the owner can retrieve the temp password.
// The key lives in CREDENTIALS_ENCRYPTION_KEY env var — never in the DB.

const ALGO = "aes-256-gcm";

function getEncryptionKey() {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be a 64-char hex string in .env");
  }
  return Buffer.from(hex, "hex"); // 32 bytes
}

/**
 * Encrypt a plain-text string.
 * Returns "iv:authTag:ciphertext" — all hex-encoded, safe to store in TEXT column.
 */
function encryptPassword(plainText) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a stored credential string back to plain text.
 * Returns null if decryption fails (wrong key, tampered data).
 */
function decryptPassword(stored) {
  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encryptedHex] = stored.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    return null;
  }
}

// ─── Field whitelists ─────────────────────────────────────────────────────────

const CREATE_FIELDS = new Set([
  "full_name", "full_name_nepali", "phone", "email",
  "gender", "date_of_birth_bs", "date_of_birth_ad",
  "citizenship_no", "pan_no", "ssf_id", "ssf_enrolled",
  "department_id", "designation", "shift_id", "workplace_id",
  "join_date_bs", "join_date_ad",
  "basic_salary", "hra", "travel_allowance", "medical_allowance",
  "marital_status",
  "bank_name", "bank_account_no", "bank_branch", "bank_ifsc",
  "notes",
]);

const UPDATE_FIELDS = new Set([
  "full_name", "full_name_nepali", "phone", "email",
  "gender", "date_of_birth_bs", "date_of_birth_ad",
  "citizenship_no", "pan_no", "ssf_id", "ssf_enrolled",
  "department_id", "designation",
  "join_date_bs", "join_date_ad",
  "marital_status",
  "bank_name", "bank_account_no", "bank_branch", "bank_ifsc",
  "notes",
]);

const SALARY_FIELDS = new Set([
  "basic_salary", "hra", "travel_allowance", "medical_allowance",
]);

function pickFields(body, allowed) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  return patch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve org_id for the authenticated user.
 */
async function resolveOrgId(userId) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .single();

  if (error) throw error;
  if (!data?.org_id) throw new Error("No organization linked to this user");
  return data.org_id;
}

/**
 * Verify an employee exists and belongs to the given org.
 * Returns the employee row or throws.
 */
async function assertEmployeeOwnership(employeeId, orgId) {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("*")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Employee not found");
  return data;
}

/**
 * Generate the next employee code for an org using the DB function.
 * fn_next_employee_code uses an atomic upsert on employee_sequences.
 */
async function generateEmployeeCode(orgId) {
  const { data, error } = await supabaseAdmin.rpc("fn_next_employee_code", {
    p_org_id: orgId,
  });
  if (error) throw error;
  return data; // e.g. "HH-001"
}

/**
 * Validate the org's plan limit before creating an employee.
 * Joins subscriptions → plans to get max_employees.
 */
async function validatePlanLimit(orgId) {
  // Get active subscription + plan limits
  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .select("plan:plan_id(max_employees)")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle();

  if (subError) throw subError;

  const maxEmployees = sub?.plan?.max_employees ?? -1;
  if (maxEmployees === -1) return; // unlimited

  // Count active employees for this org
  const { count, error: countError } = await supabaseAdmin
    .from("employees")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .neq("status", "terminated");

  if (countError) throw countError;

  if (count >= maxEmployees) {
    throw new Error(
      `Employee limit reached (${count}/${maxEmployees}). Upgrade your plan to add more employees.`
    );
  }
}

/**
 * Initialize leave_balances for a new employee.
 * Creates one row per active leave_type for the current BS year.
 * bs_year is passed in from the caller (derived from join_date_bs).
 */
async function initializeLeaveBalances(orgId, employeeId, bsYear) {
  const { data: leaveTypes, error } = await supabaseAdmin
    .from("leave_types")
    .select("id, default_days_per_year")
    .eq("org_id", orgId)
    .eq("is_active", true);

  if (error) throw error;
  if (!leaveTypes || leaveTypes.length === 0) return;

  const balances = leaveTypes.map((lt) => ({
    org_id: orgId,
    employee_id: employeeId,
    leave_type_id: lt.id,
    bs_year: bsYear,
    allocated_days: lt.default_days_per_year,
    used_days: 0,
    carried_forward: 0,
  }));

  const { error: insertError } = await supabaseAdmin
    .from("leave_balances")
    .insert(balances);

  if (insertError) throw insertError;
}

// ─── Auth Provisioning ────────────────────────────────────────────────────────

/**
 * Generate a memorable temporary password.
 * Pattern: Hajir@{last4digits}{rand1000-9999}
 * Always 14 chars — well above Supabase's 6-char minimum.
 */
function generateTempPassword(phone) {
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4).padStart(4, "0");
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `Hajir@${last4}${rand}`;
}

/**
 * Core provisioning function — shared by createEmployee and provisionExistingEmployee.
 *
 * Steps:
 *  1. Generate temp password
 *  2. Create Supabase Auth user (email_confirm: true)
 *  3. Update public.users row (created by trigger) with org_id, role, employee_id, password_changed
 *  4. Update employees.user_id + app_access_status = 'invited'
 *  5. Store bcrypt-hashed credentials in employee_credentials
 *  6. Rollback auth user on any failure
 *
 * Returns: { authUserId, email, temporaryPassword }
 */
async function provisionAuthAccount(employee, orgId, provisionedBy) {
  const temporaryPassword = generateTempPassword(employee.phone);

  // Step 1 — Create Supabase Auth user
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: employee.email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: {
      full_name: employee.full_name,
      org_id: orgId,
      role: "employee",
    },
  });

  if (authError) {
    // Duplicate email
    if (
      authError.message?.toLowerCase().includes("already") ||
      authError.message?.toLowerCase().includes("duplicate") ||
      authError.status === 422
    ) {
      const err = new Error("An account with this email already exists. Use a different email for this employee.");
      err.code = "EMAIL_CONFLICT";
      throw err;
    }
    console.error("[provision] auth_provision_failed", {
      event: "auth_provision_failed",
      employee_id: employee.id,
      org_id: orgId,
      error_code: authError.status,
      error_message: authError.message,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`Auth account creation failed: ${authError.message}`);
  }

  const authUserId = authData.user.id;
  console.log("[provision] auth user created:", authUserId);

  // Rollback helper
  const rollback = async () => {
    const { error: delError } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (delError) {
      console.error("[provision] auth_provision_rollback_failed", {
        event: "auth_provision_rollback_failed",
        orphaned_auth_user_id: authUserId,
        employee_id: employee.id,
        org_id: orgId,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log("[provision] auth_provision_rollback", {
        event: "auth_provision_rollback",
        auth_user_id: authUserId,
        rollback_success: true,
        timestamp: new Date().toISOString(),
      });
    }
  };

  // Step 2 — Wait for the DB trigger to create the public.users row
  // fn_handle_new_auth_user fires on auth.users INSERT and creates the row
  let retries = 5;
  let userRowExists = false;
  while (retries > 0) {
    await new Promise((r) => setTimeout(r, 400));
    const { data: check } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("id", authUserId)
      .maybeSingle();
    if (check) { userRowExists = true; break; }
    retries--;
    console.log(`[provision] waiting for users row... retries left: ${retries}`);
  }

  if (!userRowExists) {
    // Trigger didn't fire — insert the row manually
    console.log("[provision] trigger did not fire, inserting users row manually");
    const { error: insertUserError } = await supabaseAdmin
      .from("users")
      .insert({
        id: authUserId,
        full_name: employee.full_name,
        email: employee.email,
        org_id: orgId,
        employee_id: employee.id ?? null,
        password_changed: false,
      });

    if (insertUserError && insertUserError.code !== "23505") {
      // 23505 = already exists (race condition), safe to ignore
      await rollback();
      throw new Error(`Failed to create user profile: ${insertUserError.message}`);
    }
  } else {
    // Row exists — update it with org context
    // Use raw SQL cast to avoid enum type issues with the role column
    const { error: userUpdateError } = await supabaseAdmin
      .from("users")
      .update({
        org_id: orgId,
        employee_id: employee.id ?? null,
        password_changed: false,
        full_name: employee.full_name,
        email: employee.email,
      })
      .eq("id", authUserId);

    if (userUpdateError) {
      console.error("[provision] users update error:", userUpdateError.message);
      await rollback();
      throw new Error(`Failed to link user profile: ${userUpdateError.message}`);
    }
  }

  // Step 3 — Update employees row (only if employee.id is known)
  if (employee.id) {
    const { error: empUpdateError } = await supabaseAdmin
      .from("employees")
      .update({ user_id: authUserId, app_access_status: "invited" })
      .eq("id", employee.id)
      .eq("org_id", orgId);

    if (empUpdateError) {
      await rollback();
      throw new Error(`Failed to link employee record: ${empUpdateError.message}`);
    }
  }

  // Step 4 — Store encrypted credentials for later retrieval (non-fatal)
  try {
    const encryptedPassword = encryptPassword(temporaryPassword);
    await supabaseAdmin
      .from("employee_credentials")
      .insert({
        org_id: orgId,
        employee_id: employee.id ?? null,
        email: employee.email,
        password_hash: encryptedPassword, // AES-256-GCM encrypted, not bcrypt
        is_active: true,
        provisioned_by: provisionedBy ?? null,
      });
  } catch (credError) {
    console.error("[provision] Failed to store credentials record:", credError.message);
    // Non-fatal — don't block employee creation
  }

  // Audit log (no sensitive data)
  console.log("[provision] auth_provisioned", {
    event: "auth_provisioned",
    employee_id: employee.id,
    auth_user_id: authUserId,
    org_id: orgId,
    email_domain: employee.email.split("@")[1],
    timestamp: new Date().toISOString(),
  });

  return { authUserId, email: employee.email, temporaryPassword };
}

/**
 * Provision auth for an existing employee who has no auth account.
 * POST /api/employees/:id/provision-auth
 */
async function provisionExistingEmployee(userId, employeeId, email) {
  const orgId = await resolveOrgId(userId);
  const employee = await assertEmployeeOwnership(employeeId, orgId);

  if (employee.user_id) {
    const err = new Error("This employee already has an auth account");
    err.code = "ALREADY_PROVISIONED";
    throw err;
  }
  if (employee.status === "terminated") {
    const err = new Error("Cannot provision access for a terminated employee");
    err.code = "TERMINATED";
    throw err;
  }

  // Use provided email or fall back to employee's stored email
  const resolvedEmail = email || employee.email;
  if (!resolvedEmail) {
    throw new Error("Email is required to provision an auth account");
  }

  const credentials = await provisionAuthAccount(
    { id: employeeId, full_name: employee.full_name, phone: employee.phone, email: resolvedEmail },
    orgId,
    userId
  );

  return credentials;
}

/**
 * Get stored credentials for an employee.
 * Decrypts the stored password so the owner can share it again.
 * Only works while is_active = true (before employee changes password).
 */
async function getEmployeeCredentials(userId, employeeId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  const { data, error } = await supabaseAdmin
    .from("employee_credentials")
    .select("id, employee_id, email, password_hash, is_active, created_at")
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("No credentials found for this employee");

  // Decrypt the stored password — only possible while is_active = true
  let temporaryPassword = null;
  if (data.is_active && data.password_hash) {
    temporaryPassword = decryptPassword(data.password_hash);
  }

  return {
    employee_id: data.employee_id,
    email: data.email,
    is_active: data.is_active,
    provisioned_at: data.created_at,
    // Return decrypted password only while still active (employee hasn't changed it)
    temporaryPassword: temporaryPassword ?? undefined,
    note: data.is_active
      ? "Temporary password is still active — employee has not changed it yet"
      : "Employee has set their own password — temporary password no longer available",
  };
}

// ─── Core CRUD ────────────────────────────────────────────────────────────────

/**
 * Paginated list with search and filters.
 * GET /api/employees?search=&department_id=&status=&page=1&limit=20
 */
async function listEmployees(userId, query = {}) {
  const orgId = await resolveOrgId(userId);

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from("employees")
    .select(
      `id, org_id, employee_code, full_name, full_name_nepali,
       phone, email, gender, designation, status, app_access_status,
       join_date_bs, join_date_ad, photo_url,
       department:department_id(id, name),
       shift:shift_id(id, name),
       workplace:workplace_id(id, name)`,
      { count: "exact" }
    )
    .eq("org_id", orgId)
    .order("employee_code", { ascending: true })
    .range(offset, offset + limit - 1);

  if (query.status) q = q.eq("status", query.status);
  if (query.department_id) q = q.eq("department_id", query.department_id);
  if (query.search) {
    // ilike on full_name and employee_code
    q = q.or(
      `full_name.ilike.%${query.search}%,employee_code.ilike.%${query.search}%,phone.ilike.%${query.search}%`
    );
  }

  const { data, error, count } = await q;
  if (error) throw error;

  return {
    data,
    meta: { total: count, page, limit, pages: Math.ceil(count / limit) },
  };
}

/**
 * Full employee profile by id — owner/HR.
 */
async function getEmployee(userId, employeeId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("employees")
    .select(
      `*, 
       department:department_id(id, name, name_nepali),
       shift:shift_id(id, name, start_time, end_time, working_days),
       workplace:workplace_id(id, name, address, latitude, longitude)`
    )
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Employee not found");
  return data;
}

/**
 * Own profile — employee role.
 * Returns the employee record linked to the authenticated user.
 */
async function getMyProfile(userId) {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id, employee_id")
    .eq("id", userId)
    .single();

  if (userError) throw userError;
  if (!user?.employee_id) throw new Error("No employee profile linked to this account");

  const { data, error } = await supabaseAdmin
    .from("employees")
    .select(
      `id, employee_code, full_name, full_name_nepali, phone, email,
       gender, date_of_birth_bs, date_of_birth_ad, designation,
       join_date_bs, join_date_ad, status, app_access_status, photo_url,
       department:department_id(id, name),
       shift:shift_id(id, name, start_time, end_time),
       workplace:workplace_id(id, name, address)`
    )
    .eq("id", user.employee_id)
    .eq("org_id", user.org_id)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Create a new employee with automatic auth account provisioning.
 * email is required — every employee gets a Supabase Auth account.
 */
/**
 * Create a new employee with automatic auth account provisioning.
 * email is required — every employee gets a Supabase Auth account.
 */
async function createEmployee(userId, body) {
  const orgId = await resolveOrgId(userId);

  // 1. Plan limit check
  await validatePlanLimit(orgId);

  const fields = pickFields(body, CREATE_FIELDS);

  // 2. Required field validation
  if (!fields.full_name) throw new Error("full_name is required");
  if (!fields.phone) throw new Error("phone is required");
  if (!fields.email) throw new Error("Email is required to create an employee account");
  if (!fields.join_date_bs) throw new Error("join_date_bs is required");
  if (!fields.join_date_ad) throw new Error("join_date_ad is required");
  if (fields.basic_salary == null) throw new Error("basic_salary is required");

  // 3. Provision auth account BEFORE inserting employee row.
  //    This ensures email conflicts are caught before any DB row is created.
  //    employee.id is not known yet — we pass null and back-fill after insert.
  const { authUserId, temporaryPassword } = await provisionAuthAccount(
    { id: null, full_name: fields.full_name, phone: fields.phone, email: fields.email },
    orgId,
    userId
  );

  // 4. Generate employee code atomically
  const employee_code = await generateEmployeeCode(orgId);

  // 5. Insert employee row — link to the auth user we just created
  const { data: rows, error } = await supabaseAdmin
    .from("employees")
    .insert({
      ...fields,
      org_id: orgId,
      employee_code,
      user_id: authUserId,
      app_access_status: "invited",
      created_by: userId,
    })
    .select("*");

  if (error) {
    // Clean up the auth user we already created
    await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
    if (error.code === "23505") {
      if (error.message.includes("phone")) {
        throw new Error(`Phone number ${fields.phone} is already registered in this organization`);
      }
      throw new Error("Duplicate employee record");
    }
    throw error;
  }

  const employee = rows?.[0];
  if (!employee) throw new Error("Employee insert succeeded but no row returned");

  // 6. Back-fill employee_id on public.users and employee_credentials
  await supabaseAdmin
    .from("users")
    .update({ employee_id: employee.id })
    .eq("id", authUserId);

  await supabaseAdmin
    .from("employee_credentials")
    .update({ employee_id: employee.id })
    .eq("org_id", orgId)
    .is("employee_id", null)
    .eq("email", fields.email);

  // 7. Initialize leave balances (non-fatal)
  const bsYear = parseInt(fields.join_date_bs?.split("-")[0]);
  if (bsYear) {
    await initializeLeaveBalances(orgId, employee.id, bsYear).catch(() => {});
  }

  return { employee, credentials: { email: fields.email, temporaryPassword } };
}

/**
 * Update employee profile fields (excludes salary, status, shift, workplace).
 */
async function updateEmployee(userId, employeeId, body) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  const patch = pickFields(body, UPDATE_FIELDS);
  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update(patch)
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505" && error.message.includes("phone")) {
      throw new Error("Phone number already registered in this organization");
    }
    throw error;
  }
  return data;
}

/**
 * Soft-terminate an employee.
 * Sets status = 'terminated', app_access_status = 'suspended'.
 * Also bans the Supabase Auth user to prevent new logins.
 */
async function deactivateEmployee(userId, employeeId, body) {
  const orgId = await resolveOrgId(userId);
  const employee = await assertEmployeeOwnership(employeeId, orgId);

  const patch = {
    status: "terminated",
    app_access_status: "suspended",
  };

  if (body.exit_date_bs) patch.exit_date_bs = body.exit_date_bs;
  if (body.exit_date_ad) patch.exit_date_ad = body.exit_date_ad;
  if (body.termination_reason) patch.termination_reason = body.termination_reason;

  const { data: rows, error } = await supabaseAdmin
    .from("employees")
    .update(patch)
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*");

  if (error) throw error;
  const updated = rows?.[0];
  if (!updated) throw new Error("Employee not found");

  // Ban the Supabase Auth user — 'none' = permanent ban
  if (employee.user_id) {
    await supabaseAdmin.auth.admin
      .updateUserById(employee.user_id, { ban_duration: "none" })
      .catch((err) => {
        console.error("[deactivate] Failed to ban auth user:", err.message);
        // Non-fatal — app_access_status = suspended still blocks via middleware
      });
  }

  return updated;
}

// ─── Salary ───────────────────────────────────────────────────────────────────

/**
 * Update salary with a revision log entry.
 * Body: { basic_salary, hra, travel_allowance, medical_allowance,
 *         effective_date_bs, effective_date_ad, reason }
 */
async function updateSalary(userId, employeeId, body) {
  const orgId = await resolveOrgId(userId);
  const employee = await assertEmployeeOwnership(employeeId, orgId);

  const salaryPatch = pickFields(body, SALARY_FIELDS);
  if (Object.keys(salaryPatch).length === 0) throw new Error("No salary fields provided");

  if (!body.effective_date_bs) throw new Error("effective_date_bs is required");
  if (!body.effective_date_ad) throw new Error("effective_date_ad is required");

  // 1. Log the revision
  const { error: revError } = await supabaseAdmin
    .from("salary_revisions")
    .insert({
      org_id: orgId,
      employee_id: employeeId,
      effective_date_bs: body.effective_date_bs,
      effective_date_ad: body.effective_date_ad,
      old_basic: employee.basic_salary,
      new_basic: salaryPatch.basic_salary ?? employee.basic_salary,
      old_hra: employee.hra,
      new_hra: salaryPatch.hra ?? employee.hra,
      reason: body.reason ?? null,
      revised_by: userId,
    });

  if (revError) throw revError;

  // 2. Update the employee snapshot
  const { data, error } = await supabaseAdmin
    .from("employees")
    .update(salaryPatch)
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── Assignments ──────────────────────────────────────────────────────────────

/**
 * Assign a shift to an employee.
 */
async function assignShift(userId, employeeId, shiftId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  // Verify shift belongs to same org
  if (shiftId !== null) {
    const { data: shift, error: shiftError } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("id", shiftId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (shiftError) throw shiftError;
    if (!shift) throw new Error("Shift not found");
  }

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({ shift_id: shiftId })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*, shift:shift_id(id, name, start_time, end_time)")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Assign a workplace to an employee.
 */
async function assignWorkplace(userId, employeeId, workplaceId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  // Verify workplace belongs to same org
  if (workplaceId !== null) {
    const { data: wp, error: wpError } = await supabaseAdmin
      .from("workplaces")
      .select("id")
      .eq("id", workplaceId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (wpError) throw wpError;
    if (!wp) throw new Error("Workplace not found");
  }

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({ workplace_id: workplaceId })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*, workplace:workplace_id(id, name, address)")
    .single();

  if (error) throw error;
  return data;
}

// ─── App Invite ───────────────────────────────────────────────────────────────

/**
 * Mark employee as invited and update app_access_status.
 * Actual SMS/WhatsApp delivery is handled by the notification service.
 * Returns the updated employee.
 */
async function inviteEmployee(userId, employeeId) {
  const orgId = await resolveOrgId(userId);
  const employee = await assertEmployeeOwnership(employeeId, orgId);

  if (employee.app_access_status === "active") {
    throw new Error("Employee already has active app access");
  }
  if (employee.status === "terminated") {
    throw new Error("Cannot invite a terminated employee");
  }

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({ app_access_status: "invited" })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── Photo ────────────────────────────────────────────────────────────────────

/**
 * Upload employee photo to Supabase Storage and update employee record.
 * fileBuffer: Buffer, mimeType: string
 */
async function uploadPhoto(userId, employeeId, { fileBuffer, mimeType }) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  // Validate file type and size
  const ALLOWED_MIME = new Set([
    "image/jpeg", "image/png", "image/webp",
  ]);
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error("Unsupported image type. Allowed: JPEG, PNG, WebP");
  }

  const maxSize = 5 * 1024 * 1024; // 5MB
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);

  if (buffer.length > maxSize) {
    throw new Error("File too large. Maximum size is 5MB");
  }

  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  const path = `photos/${orgId}/${employeeId}/photo.${ext}`;

  // Upload to Supabase Storage bucket "hajirhub-storage"
  const { error: uploadError } = await supabaseAdmin.storage
    .from("hajirhub-storage")
    .upload(path, buffer, { contentType: mimeType, upsert: true });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message || uploadError.error || "Unknown storage error"}`);
  }

  const { data: urlData } = supabaseAdmin.storage
    .from("hajirhub-storage")
    .getPublicUrl(path);

  // Update employee record with both path and public URL
  let { data, error } = await supabaseAdmin
    .from("employees")
    .update({ 
      photo_path: path,
      photo_url: urlData.publicUrl 
    })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error && (error.code === "PGRST204" || error.message?.includes("photo_path"))) {
    const fallback = await supabaseAdmin
      .from("employees")
      .update({ photo_url: urlData.publicUrl })
      .eq("id", employeeId)
      .eq("org_id", orgId)
      .select("*")
      .single();

    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw error;
  return data;
}

// ─── Documents ────────────────────────────────────────────────────────────────

/**
 * List all documents for an employee.
 */
async function listDocuments(userId, employeeId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  const { data, error } = await supabaseAdmin
    .from("employee_documents")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Upload a document to Supabase Storage and record metadata.
 * fileBuffer: Buffer, mimeType: string, originalName: string, docType: string, label?: string
 */
async function uploadDocument(userId, employeeId, { fileBuffer, mimeType, originalName, docType, label }) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  const ALLOWED_DOC_TYPES = new Set([
    "citizenship", "pan_card", "contract", "photo", "certificate", "other",
  ]);
  if (!ALLOWED_DOC_TYPES.has(docType)) {
    throw new Error(`Invalid doc_type. Allowed: ${[...ALLOWED_DOC_TYPES].join(", ")}`);
  }

  const ALLOWED_MIME = new Set([
    "image/jpeg", "image/png", "image/webp",
    "application/pdf",
  ]);
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error("Unsupported file type. Allowed: JPEG, PNG, WebP, PDF");
  }

  const maxSize = 10 * 1024 * 1024; // 10MB
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  
  if (buffer.length > maxSize) {
    throw new Error("File too large. Maximum size is 10MB");
  }

  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  const filename = `${docType}_${Date.now()}.${ext}`;
  const path = `documents/${orgId}/${employeeId}/${docType}/${filename}`;

  // Upload to Supabase Storage bucket "hajirhub-storage" (private)
  const { error: uploadError } = await supabaseAdmin.storage
    .from("hajirhub-storage")
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message || uploadError.error || "Unknown storage error"}`);
  }

  // Insert document record with private path (not public URL)
  const { data, error } = await supabaseAdmin
    .from("employee_documents")
    .insert({
      org_id: orgId,
      employee_id: employeeId,
      doc_type: docType,
      label: label ?? null,
      file_path: path, // Store private path instead of public URL
      file_url: path, // Fallback for NOT NULL constraint (private docs don't have public URLs)
      file_name: filename,
      file_size_bytes: fileBuffer.length,
      uploaded_by: userId,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get signed URL for private document access.
 */
async function getDocumentSignedUrl(userId, employeeId, docId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  // Fetch the document to get the storage path
  const { data: doc, error: fetchError } = await supabaseAdmin
    .from("employee_documents")
    .select("id, file_path")
    .eq("id", docId)
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!doc) throw new Error("Document not found");

  // Create signed URL for 5 minutes (300 seconds)
  const { data, error } = await supabaseAdmin.storage
    .from("hajirhub-storage")
    .createSignedUrl(doc.file_path, 60 * 5);

  if (error) throw error;
  return { signedUrl: data.signedUrl };
}

/**
 * Delete a document record and its storage file.
 */
async function deleteDocument(userId, employeeId, docId) {
  const orgId = await resolveOrgId(userId);
  await assertEmployeeOwnership(employeeId, orgId);

  // Fetch the doc to get the storage path
  const { data: doc, error: fetchError } = await supabaseAdmin
    .from("employee_documents")
    .select("id, file_path")
    .eq("id", docId)
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!doc) throw new Error("Document not found");

  // Delete from storage using the stored path
  if (doc.file_path) {
    await supabaseAdmin.storage
      .from("hajirhub-storage")
      .remove([doc.file_path]);
    // Non-fatal if storage delete fails — record is still removed
  }

  const { error: deleteError } = await supabaseAdmin
    .from("employee_documents")
    .delete()
    .eq("id", docId)
    .eq("org_id", orgId);

  if (deleteError) throw deleteError;
}

module.exports = {
  listEmployees,
  createEmployee,
  getMyProfile,
  getEmployee,
  updateEmployee,
  deactivateEmployee,
  updateSalary,
  assignShift,
  assignWorkplace,
  inviteEmployee,
  provisionExistingEmployee,
  getEmployeeCredentials,
  uploadPhoto,
  listDocuments,
  uploadDocument,
  getDocumentSignedUrl,
  deleteDocument,
};
