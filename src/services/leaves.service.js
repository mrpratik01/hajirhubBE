const { supabaseAdmin } = require("../config/supabase");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveOrgId(userId) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.org_id) throw new Error("No organization linked to this user");
  return data.org_id;
}

async function resolveEmployeeId(userId) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("employee_id, org_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.employee_id) throw new Error("No employee profile linked to this account");
  return { employeeId: data.employee_id, orgId: data.org_id };
}

// ─── Leave Types ──────────────────────────────────────────────────────────────

/**
 * List all leave types for the org.
 * Owner/HR: all types. Employee: only active ones.
 */
async function listLeaveTypes(userId, includeInactive = false) {
  const orgId = await resolveOrgId(userId);

  let q = supabaseAdmin
    .from("leave_types")
    .select("*")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (!includeInactive) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/**
 * Create a leave type. Owner only.
 */
async function createLeaveType(userId, body) {
  const orgId = await resolveOrgId(userId);

  const ALLOWED = new Set([
    "code", "name", "name_nepali", "default_days_per_year",
    "is_paid", "requires_doc_after_days", "is_carry_forward",
    "max_carry_forward_days", "gender_restriction", "is_active",
  ]);

  const fields = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = body[key];
  }

  if (!fields.code) throw new Error("code is required");
  if (!fields.name) throw new Error("name is required");

  // Auto-assign sort_order
  const { data: last } = await supabaseAdmin
    .from("leave_types")
    .select("sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  fields.sort_order = last ? last.sort_order + 1 : 1;

  const { data, error } = await supabaseAdmin
    .from("leave_types")
    .insert({ ...fields, org_id: orgId })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error(`Leave type code "${fields.code}" already exists`);
    throw error;
  }
  return data;
}

/**
 * Update a leave type. Owner only.
 */
async function updateLeaveType(userId, leaveTypeId, body) {
  const orgId = await resolveOrgId(userId);

  const ALLOWED = new Set([
    "name", "name_nepali", "default_days_per_year",
    "is_paid", "requires_doc_after_days", "is_carry_forward",
    "max_carry_forward_days", "gender_restriction", "is_active",
  ]);

  const patch = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  }

  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  const { data, error } = await supabaseAdmin
    .from("leave_types")
    .update(patch)
    .eq("id", leaveTypeId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Leave type not found");
  return data;
}

// ─── Leave Balances ───────────────────────────────────────────────────────────

/**
 * Get leave balances for a specific employee and BS year.
 * Owner/HR: any employee. Employee: own only.
 */
async function getLeaveBalances(orgId, employeeId, bsYear) {
  const { data, error } = await supabaseAdmin
    .from("leave_balances")
    .select(`
      id, bs_year, allocated_days, used_days, carried_forward,
      leave_type:leave_type_id(id, code, name, name_nepali, is_paid, gender_restriction)
    `)
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .eq("bs_year", bsYear)
    .order("leave_type_id", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Get own leave balances (employee role).
 */
async function getMyLeaveBalances(userId, bsYear) {
  const { employeeId, orgId } = await resolveEmployeeId(userId);
  return getLeaveBalances(orgId, employeeId, bsYear);
}

/**
 * Get leave balances for any employee (owner/HR).
 */
async function getEmployeeLeaveBalances(userId, employeeId, bsYear) {
  const orgId = await resolveOrgId(userId);
  // Verify employee belongs to org
  const { data: emp } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!emp) throw new Error("Employee not found");
  return getLeaveBalances(orgId, employeeId, bsYear);
}

// ─── Leave Requests ───────────────────────────────────────────────────────────

/**
 * Employee applies for leave.
 */
async function applyLeave(userId, body) {
  const { employeeId, orgId } = await resolveEmployeeId(userId);

  const {
    leave_type_id, from_date_bs, from_date_ad,
    to_date_bs, to_date_ad, total_days, reason,
  } = body;

  if (!leave_type_id) throw new Error("leave_type_id is required");
  if (!from_date_bs || !from_date_ad) throw new Error("from_date_bs and from_date_ad are required");
  if (!to_date_bs || !to_date_ad) throw new Error("to_date_bs and to_date_ad are required");
  if (!total_days || total_days <= 0) throw new Error("total_days must be greater than 0");

  // Verify leave type belongs to org and is active
  const { data: leaveType, error: ltError } = await supabaseAdmin
    .from("leave_types")
    .select("id, name, gender_restriction, is_active")
    .eq("id", leave_type_id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (ltError) throw ltError;
  if (!leaveType) throw new Error("Leave type not found");
  if (!leaveType.is_active) throw new Error("This leave type is not active");

  // Gender restriction check
  if (leaveType.gender_restriction) {
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("gender")
      .eq("id", employeeId)
      .single();
    if (emp?.gender && emp.gender !== leaveType.gender_restriction) {
      throw new Error(`This leave type is only available for ${leaveType.gender_restriction} employees`);
    }
  }

  // Check for overlapping pending/approved requests
  const { data: overlap } = await supabaseAdmin
    .from("leave_requests")
    .select("id")
    .eq("employee_id", employeeId)
    .in("status", ["pending", "approved"])
    .lte("from_date_ad", to_date_ad)
    .gte("to_date_ad", from_date_ad)
    .maybeSingle();

  if (overlap) throw new Error("You already have a leave request overlapping these dates");

  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .insert({
      org_id: orgId,
      employee_id: employeeId,
      leave_type_id,
      from_date_bs,
      from_date_ad,
      to_date_bs,
      to_date_ad,
      total_days,
      reason: reason ?? null,
      status: "pending",
    })
    .select(`
      *,
      leave_type:leave_type_id(id, code, name, name_nepali, is_paid)
    `)
    .single();

  if (error) throw error;
  return data;
}

/**
 * List all leave requests for the org (owner/HR).
 * Filters: status, employee_id, month (YYYY-MM AD)
 */
async function listLeaveRequests(userId, query = {}) {
  const orgId = await resolveOrgId(userId);

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from("leave_requests")
    .select(`
      id, from_date_bs, from_date_ad, to_date_bs, to_date_ad,
      total_days, reason, status, review_note, reviewed_at, created_at,
      employee:employee_id(id, employee_code, full_name, photo_url,
        department:department_id(name)
      ),
      leave_type:leave_type_id(id, code, name, name_nepali, is_paid),
      reviewer:reviewed_by(id, full_name)
    `, { count: "exact" })
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.status) q = q.eq("status", query.status);
  if (query.employee_id) q = q.eq("employee_id", query.employee_id);
  if (query.month) {
    // month = "2025-04" (AD)
    const start = `${query.month}-01`;
    const [y, m] = query.month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const end = `${query.month}-${String(lastDay).padStart(2, "0")}`;
    q = q.gte("from_date_ad", start).lte("from_date_ad", end);
  }

  const { data, error, count } = await q;
  if (error) throw error;

  return {
    data,
    meta: { total: count, page, limit, pages: Math.ceil(count / limit) },
  };
}

/**
 * Employee's own leave requests.
 */
async function getMyLeaveRequests(userId, query = {}) {
  const { employeeId, orgId } = await resolveEmployeeId(userId);

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from("leave_requests")
    .select(`
      id, from_date_bs, from_date_ad, to_date_bs, to_date_ad,
      total_days, reason, status, review_note, reviewed_at, created_at,
      leave_type:leave_type_id(id, code, name, name_nepali, is_paid),
      reviewer:reviewed_by(id, full_name)
    `, { count: "exact" })
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query.status) q = q.eq("status", query.status);

  const { data, error, count } = await q;
  if (error) throw error;

  return {
    data,
    meta: { total: count, page, limit, pages: Math.ceil(count / limit) },
  };
}

/**
 * Approve a leave request. Owner/HR only.
 * Side effect: deducts from leave_balances.
 */
async function approveLeave(userId, requestId, reviewNote) {
  const orgId = await resolveOrgId(userId);

  // Fetch the request
  const { data: req, error: fetchError } = await supabaseAdmin
    .from("leave_requests")
    .select("*")
    .eq("id", requestId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!req) throw new Error("Leave request not found");
  if (req.status !== "pending") throw new Error(`Cannot approve a request with status "${req.status}"`);

  // Get current BS year from from_date_bs
  const bsYear = parseInt(req.from_date_bs?.split("-")[0]);

  // Deduct from leave_balances
  const { data: balance, error: balError } = await supabaseAdmin
    .from("leave_balances")
    .select("id, used_days, allocated_days, carried_forward")
    .eq("employee_id", req.employee_id)
    .eq("leave_type_id", req.leave_type_id)
    .eq("bs_year", bsYear)
    .maybeSingle();

  if (balError) throw balError;

  if (balance) {
    const totalAvailable = Number(balance.allocated_days) + Number(balance.carried_forward);
    const newUsed = Number(balance.used_days) + Number(req.total_days);

    if (newUsed > totalAvailable) {
      throw new Error(
        `Insufficient leave balance. Available: ${totalAvailable - Number(balance.used_days)} days, Requested: ${req.total_days} days`
      );
    }

    await supabaseAdmin
      .from("leave_balances")
      .update({ used_days: newUsed })
      .eq("id", balance.id);
  }

  // Update request status
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .update({
      status: "approved",
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      review_note: reviewNote ?? null,
    })
    .eq("id", requestId)
    .eq("org_id", orgId)
    .select(`
      *,
      employee:employee_id(id, employee_code, full_name),
      leave_type:leave_type_id(id, code, name)
    `)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Reject a leave request. Owner/HR only.
 */
async function rejectLeave(userId, requestId, reviewNote) {
  const orgId = await resolveOrgId(userId);

  const { data: req } = await supabaseAdmin
    .from("leave_requests")
    .select("status")
    .eq("id", requestId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!req) throw new Error("Leave request not found");
  if (req.status !== "pending") throw new Error(`Cannot reject a request with status "${req.status}"`);

  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .update({
      status: "rejected",
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      review_note: reviewNote ?? null,
    })
    .eq("id", requestId)
    .eq("org_id", orgId)
    .select(`
      *,
      employee:employee_id(id, employee_code, full_name),
      leave_type:leave_type_id(id, code, name)
    `)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Employee cancels their own pending request.
 */
async function cancelLeave(userId, requestId) {
  const { employeeId, orgId } = await resolveEmployeeId(userId);

  const { data: req } = await supabaseAdmin
    .from("leave_requests")
    .select("status, employee_id")
    .eq("id", requestId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!req) throw new Error("Leave request not found");
  if (req.employee_id !== employeeId) throw new Error("You can only cancel your own requests");
  if (req.status !== "pending") throw new Error(`Cannot cancel a request with status "${req.status}"`);

  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .update({ status: "cancelled" })
    .eq("id", requestId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Leave calendar — all employees' approved/pending leaves for a month.
 * month = "2025-04" (AD format)
 */
async function getLeaveCalendar(userId, month) {
  const orgId = await resolveOrgId(userId);

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("month must be in YYYY-MM format (AD), e.g. 2025-04");
  }

  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;

  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select(`
      id, from_date_bs, from_date_ad, to_date_bs, to_date_ad,
      total_days, status,
      employee:employee_id(id, employee_code, full_name, photo_url),
      leave_type:leave_type_id(id, code, name, name_nepali)
    `)
    .eq("org_id", orgId)
    .in("status", ["pending", "approved"])
    .lte("from_date_ad", end)
    .gte("to_date_ad", start)
    .order("from_date_ad", { ascending: true });

  if (error) throw error;
  return data;
}

module.exports = {
  // Leave types
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  // Leave balances
  getMyLeaveBalances,
  getEmployeeLeaveBalances,
  // Leave requests
  applyLeave,
  listLeaveRequests,
  getMyLeaveRequests,
  approveLeave,
  rejectLeave,
  cancelLeave,
  getLeaveCalendar,
};
