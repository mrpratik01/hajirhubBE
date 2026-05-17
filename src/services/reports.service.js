const { supabaseAdmin } = require("../config/supabase");

/**
 * Resolve organization ID from user ID.
 */
async function resolveOrgId(userId) {
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!user?.org_id) throw new Error("Organization not found for this user");
  return user.org_id;
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function fetchAttendanceData(orgId, monthBs) {
  // Get all active employees
  const { data: employees, error: empError } = await supabaseAdmin
    .from("employees")
    .select("id, employee_code, full_name, designation")
    .eq("org_id", orgId)
    .eq("status", "active");

  if (empError) throw empError;

  // Get attendance records for the month
  const { data: attendance, error: attError } = await supabaseAdmin
    .from("attendance")
    .select("employee_id, status, working_minutes")
    .eq("org_id", orgId)
    .like("date_bs", `${monthBs}-%`);

  if (attError) throw attError;

  // Aggregate
  const statsMap = new Map();
  attendance.forEach((rec) => {
    if (!statsMap.has(rec.employee_id)) {
      statsMap.set(rec.employee_id, {
        present: 0,
        absent: 0,
        leave: 0,
        late: 0,
        half_day: 0,
        holiday: 0,
        weekend: 0,
        total_minutes: 0,
      });
    }
    const s = statsMap.get(rec.employee_id);
    if (s[rec.status] !== undefined) s[rec.status]++;
    s.total_minutes += rec.working_minutes || 0;
  });

  return employees.map((emp) => ({
    ...emp,
    stats: statsMap.get(emp.id) || {
      present: 0,
      absent: 0,
      leave: 0,
      late: 0,
      half_day: 0,
      holiday: 0,
      weekend: 0,
      total_minutes: 0,
    },
  }));
}

async function fetchPayrollData(orgId, monthBs) {
  const { data, error } = await supabaseAdmin
    .from("payroll_runs")
    .select(`
      *,
      items:payroll_items(
        *,
        employee:employee_id(full_name, employee_code)
      )
    `)
    .eq("org_id", orgId)
    .eq("month_bs", monthBs)
    .eq("status", "finalized")
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function fetchLeaveData(orgId, monthBs) {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select(`
      *,
      employee:employee_id(full_name, employee_code),
      leave_type:leave_type_id(name)
    `)
    .eq("org_id", orgId)
    .like("from_date_bs", `${monthBs}-%`)
    .eq("status", "approved");

  if (error) throw error;
  return data;
}

// ─── Service Methods ─────────────────────────────────────────────────────────

async function listReports(userId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("report_exports")
    .select(`
      *,
      generated_by_user:generated_by(full_name)
    `)
    .eq("org_id", orgId)
    .order("generated_at", { ascending: false });

  if (error) throw error;
  return data;
}

async function generateReport(userId, type, parameters) {
  const orgId = await resolveOrgId(userId);
  const { month_bs } = parameters;

  if (!month_bs) throw new Error("month_bs parameter is required");

  let reportData;
  let fileName = `${type}_${month_bs}_${Date.now()}`;

  switch (type) {
    case "attendance_summary":
      reportData = await fetchAttendanceData(orgId, month_bs);
      fileName += ".json";
      break;
    case "payroll_summary":
      reportData = await fetchPayrollData(orgId, month_bs);
      if (!reportData) throw new Error("No finalized payroll found for this month");
      fileName += ".json";
      break;
    case "leave_report":
      reportData = await fetchLeaveData(orgId, month_bs);
      fileName += ".json";
      break;
    case "ssf_export":
      // Filter for SSF enrolled only
      const allAtt = await fetchAttendanceData(orgId, month_bs);
      reportData = allAtt.filter(e => e.ssf_id || e.ssf_enrolled);
      fileName += ".json";
      break;
    default:
      throw new Error(`Unsupported report type: ${type}`);
  }

  // In a full implementation, we would convert reportData to Excel/CSV
  // and upload to Supabase Storage. For now, we store the data in parameters
  // or return it directly. The schema has file_url, so we'll mock that.

  const { data, error } = await supabaseAdmin
    .from("report_exports")
    .insert({
      org_id: orgId,
      generated_by: userId,
      report_type: type,
      parameters: { ...parameters, record_count: reportData.length || 1 },
      file_name: fileName,
      file_url: null, // Placeholder for actual file link
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;

  return { ...data, report_data: reportData };
}

async function deleteReport(userId, reportId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("report_exports")
    .delete()
    .eq("id", reportId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  listReports,
  generateReport,
  deleteReport,
};
