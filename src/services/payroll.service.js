const { supabaseAdmin } = require("../config/supabase");
const { todayBs, getDaysInBsMonth } = require("../utils/nepaliDate");

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

// ─── Payroll Config ──────────────────────────────────────────────────────────

async function getPayrollConfig(userId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("payroll_config")
    .select("*")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updatePayrollConfig(userId, body) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("payroll_config")
    .upsert({ ...body, org_id: orgId, updated_by: userId })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── Salary Advances (Sapathi) ────────────────────────────────────────────────

async function listAdvances(userId, query = {}) {
  const orgId = await resolveOrgId(userId);
  let q = supabaseAdmin
    .from("salary_advances")
    .select(`
      *,
      employee:employee_id(id, full_name, employee_code)
    `)
    .eq("org_id", orgId);

  if (query.status) q = q.eq("status", query.status);
  if (query.employee_id) q = q.eq("employee_id", query.employee_id);

  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

async function createAdvance(userId, body) {
  const orgId = await resolveOrgId(userId);
  const { employee_id, amount, reason } = body;

  const { data, error } = await supabaseAdmin
    .from("salary_advances")
    .insert({
      org_id: orgId,
      employee_id,
      amount,
      reason,
      advance_date_bs: todayBs(),
      advance_date_ad: new Date().toISOString().split("T")[0],
      created_by: userId,
      status: "pending"
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function updateAdvanceStatus(userId, advanceId, status, note) {
  const orgId = await resolveOrgId(userId);
  const patch = { status };
  if (status === "repaid_cash" || status === "waived") {
    patch.repaid_at = new Date().toISOString();
    patch.repaid_note = note;
  }

  const { data, error } = await supabaseAdmin
    .from("salary_advances")
    .update(patch)
    .eq("id", advanceId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── TDS Slabs ───────────────────────────────────────────────────────────────

async function getTdsSlabs(bsYear, maritalStatus) {
  const { data, error } = await supabaseAdmin
    .from("tds_slabs")
    .select("*")
    .eq("bs_year", bsYear)
    .eq("marital_status", maritalStatus)
    .order("slab_order", { ascending: true });

  if (error) throw error;
  return data;
}

// ─── Calculation Logic ────────────────────────────────────────────────────────

/**
 * Calculate annual TDS based on taxable income and slabs.
 */
function calculateAnnualTDS(taxableIncome, slabs) {
  let remainingIncome = taxableIncome;
  let totalTax = 0;
  const appliedSlabs = [];

  for (const slab of slabs) {
    if (remainingIncome <= 0) break;

    const slabRange = slab.income_to ? slab.income_to - slab.income_from : Infinity;
    const taxableInThisSlab = Math.min(remainingIncome, slabRange);
    
    const taxInThisSlab = taxableInThisSlab * slab.rate;
    totalTax += taxInThisSlab;
    remainingIncome -= taxableInThisSlab;

    appliedSlabs.push(`${slab.slab_label}: ${taxInThisSlab.toFixed(2)}`);
  }

  return { totalTax, appliedSlabs: appliedSlabs.join(", ") };
}

/**
 * Aggregate attendance stats for an employee in a BS month.
 */
async function getAttendanceStats(orgId, employeeId, monthBs) {
  // monthBs format: "2082-08"
  const { data, error } = await supabaseAdmin
    .from("attendance")
    .select("status")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .like("date_bs", `${monthBs}-%`);

  if (error) throw error;

  const stats = {
    present: 0,
    late: 0,
    half_day: 0,
    absent: 0,
    leave: 0,
    holiday: 0,
    weekend: 0,
  };

  data.forEach((row) => {
    if (stats[row.status] !== undefined) {
      stats[row.status]++;
    }
  });

  return stats;
}

/**
 * The Orchestrator: Generate a payroll run.
 */
async function generatePayrollRun(userId, monthBs) {
  const orgId = await resolveOrgId(userId);
  const [bsYear, bsMonth] = monthBs.split("-").map(Number);
  const daysInMonth = getDaysInBsMonth(bsYear, bsMonth);

  // 1. Fetch Config
  const config = await getPayrollConfig(userId);
  if (!config) throw new Error("Payroll configuration not found. Please set it up first.");

  // 2. Fetch Active Employees
  const { data: employees, error: empError } = await supabaseAdmin
    .from("employees")
    .select(`
      *,
      allowances:employee_allowances(*)
    `)
    .eq("org_id", orgId)
    .eq("status", "active");

  if (empError) throw empError;
  if (!employees.length) throw new Error("No active employees found.");

  // 3. Fetch System TDS Slabs
  const slabsSingle = await getTdsSlabs(bsYear, "single");
  const slabsCouple = await getTdsSlabs(bsYear, "couple");

  const runItems = [];
  let totalGross = 0, totalNet = 0;

  for (const emp of employees) {
    // A. Attendance stats
    const stats = await getAttendanceStats(orgId, emp.id, monthBs);
    
    // Proration logic (Working Day basis)
    // We assume 30 days or daysInMonth for simple proration if shift info is missing,
    // but here we use actual attendance + holidays + leaves.
    const paidDays = stats.present + stats.late + (stats.half_day * 0.5) + stats.leave + stats.holiday + stats.weekend;
    const prorationRatio = Math.min(1, paidDays / daysInMonth);

    const payableBasic = emp.basic_salary * prorationRatio;
    const allowancesFixed = (emp.hra || 0) + (emp.travel_allowance || 0) + (emp.medical_allowance || 0);
    const allowancesVariable = (emp.allowances || [])
      .filter(a => a.is_active)
      .reduce((sum, a) => sum + a.amount, 0);
    
    const totalAllowances = allowancesFixed + allowancesVariable;
    const payableAllowances = totalAllowances * prorationRatio;
    const grossSalary = payableBasic + payableAllowances;

    // B. SSF (Social Security Fund)
    let ssfEmployee = 0, ssfEmployer = 0;
    if (emp.ssf_enrolled) {
      ssfEmployee = payableBasic * config.ssf_employee_rate;
      ssfEmployer = payableBasic * config.ssf_employer_rate;
    }

    // C. SST (Social Security Tax) - 1% on the first slab usually
    const taxableForSST = grossSalary - ssfEmployee;
    const sstDeduction = taxableForSST * config.sst_rate;

    // D. TDS (Tax Deducted at Source)
    const annualTaxableIncome = (taxableForSST - sstDeduction) * 12;
    const slabs = emp.marital_status === "couple" ? slabsCouple : slabsSingle;
    const tds = calculateAnnualTDS(annualTaxableIncome, slabs);
    const monthlyTDS = tds.totalTax / 12;

    // E. Advance Deductions
    const { data: advances } = await supabaseAdmin
      .from("salary_advances")
      .select("id, amount")
      .eq("employee_id", emp.id)
      .eq("status", "pending");

    const totalAdvances = (advances || []).reduce((sum, a) => sum + a.amount, 0);

    const totalDeductions = ssfEmployee + sstDeduction + monthlyTDS + totalAdvances;
    const netSalary = grossSalary - totalDeductions;

    runItems.push({
      employee_id: emp.id,
      org_id: orgId,
      working_days: daysInMonth,
      present_days: stats.present + stats.late,
      absent_days: stats.absent,
      late_days: stats.late,
      half_days: stats.half_day,
      leave_days: stats.leave,
      basic_salary: emp.basic_salary,
      hra: emp.hra,
      travel_allowance: emp.travel_allowance,
      medical_allowance: emp.medical_allowance,
      other_allowances: allowancesVariable,
      payable_basic: payableBasic,
      payable_allowances: payableAllowances,
      gross_salary: grossSalary,
      ssf_enrolled: emp.ssf_enrolled,
      ssf_employee_deduction: ssfEmployee,
      ssf_employer_contribution: ssfEmployer,
      sst_deduction: sstDeduction,
      annual_taxable_income: annualTaxableIncome,
      tds_deduction: monthlyTDS,
      tds_slab_applied: tds.appliedSlabs,
      advance_deduction: totalAdvances,
      total_deductions: totalDeductions,
      net_salary: netSalary,
      advance_ids: (advances || []).map(a => a.id) // Temporary for persistence
    });

    totalGross += grossSalary;
    totalNet += netSalary;
  }

  // 4. Save Payroll Run (Draft)
  const { data: run, error: runError } = await supabaseAdmin
    .from("payroll_runs")
    .insert({
      org_id: orgId,
      month_bs: monthBs,
      month_ad: new Date().toISOString().substring(0, 7),
      bs_year: bsYear,
      bs_month: bsMonth,
      status: "draft",
      employee_count: employees.length,
      total_gross: totalGross,
      total_net: totalNet,
      run_by: userId,
      payroll_config_id: config.id
    })
    .select("*")
    .single();

  if (runError) throw runError;

  // 5. Save Items
  const itemsToInsert = runItems.map(item => {
    const { advance_ids, ...cleanItem } = item;
    return { ...cleanItem, payroll_run_id: run.id };
  });

  const { error: itemsError } = await supabaseAdmin
    .from("payroll_items")
    .insert(itemsToInsert);

  if (itemsError) throw itemsError;

  return { run, items: itemsToInsert };
}

async function listRuns(userId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("payroll_runs")
    .select("*")
    .eq("org_id", orgId)
    .order("month_bs", { ascending: false });

  if (error) throw error;
  return data;
}

async function getRunDetails(userId, runId) {
  const orgId = await resolveOrgId(userId);
  const { data: run, error: runError } = await supabaseAdmin
    .from("payroll_runs")
    .select("*")
    .eq("id", runId)
    .eq("org_id", orgId)
    .single();

  if (runError) throw runError;

  const { data: items, error: itemsError } = await supabaseAdmin
    .from("payroll_items")
    .select(`
      *,
      employee:employee_id(id, full_name, employee_code, designation)
    `)
    .eq("payroll_run_id", runId);

  if (itemsError) throw itemsError;

  return { run, items };
}

async function finalizeRun(userId, runId) {
  const orgId = await resolveOrgId(userId);

  // 1. Get run details to find advances
  const { items } = await getRunDetails(userId, runId);

  // 2. Update run status
  const { data: run, error } = await supabaseAdmin
    .from("payroll_runs")
    .update({
      status: "finalized",
      finalized_at: new Date().toISOString(),
      finalized_by: userId
    })
    .eq("id", runId)
    .eq("org_id", orgId)
    .eq("status", "draft")
    .select("*")
    .single();

  if (error) throw error;
  if (!run) throw new Error("Run not found or already finalized");

  // 3. Update status of advances that were deducted
  // We need to find all advances that were part of this run.
  // In a real scenario, we'd have a link table or track IDs.
  // For now, we'll mark pending advances for these employees as deducted.
  const employeeIds = items.map(i => i.employee_id);
  
  const { error: advError } = await supabaseAdmin
    .from("salary_advances")
    .update({
      status: "deducted",
      deducted_in_payroll_id: runId
    })
    .in("employee_id", employeeIds)
    .eq("status", "pending")
    .eq("org_id", orgId);

  if (advError) console.error("Error updating advances:", advError);

  return run;
}

async function deleteRun(userId, runId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("payroll_runs")
    .delete()
    .eq("id", runId)
    .eq("org_id", orgId)
    .eq("status", "draft")
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Draft run not found");
  return data;
}

module.exports = {
  getPayrollConfig,
  updatePayrollConfig,
  listAdvances,
  createAdvance,
  updateAdvanceStatus,
  getTdsSlabs,
  generatePayrollRun,
  listRuns,
  getRunDetails,
  finalizeRun,
  deleteRun,
};
