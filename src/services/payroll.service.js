const { supabaseAdmin } = require("../config/supabase");
const { todayBs, getDaysInBsMonth, bsToAd, getNepalDateAd } = require("../utils/nepaliDate");
const {
  enumerateBsRange,
  buildEmployeeCalendar,
} = require("./workCalendar.service");

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
 * The Orchestrator: Generate a payroll run.
 */
async function generatePayrollRun(userId, monthBs) {
  const orgId = await resolveOrgId(userId);
  const [bsYear, bsMonth] = monthBs.split("-").map(Number);
  const daysInMonth = getDaysInBsMonth(bsYear, bsMonth);
  const startDateBs = `${monthBs}-01`;
  const endDateBs = `${monthBs}-${String(daysInMonth).padStart(2, "0")}`;
  const startDateAd = bsToAd(startDateBs);
  const endDateAd = bsToAd(endDateBs);
  const allDates = enumerateBsRange(startDateBs, endDateBs);

  // 1. Fetch Config
  const config = await getPayrollConfig(userId);
  if (!config) throw new Error("Payroll configuration not found. Please set it up first.");

  // 2. Fetch Active Employees
  const { data: employees, error: empError } = await supabaseAdmin
    .from("employees")
    .select(`
      *,
      shift:shift_id(id, name, start_time, end_time, working_days),
      allowances:employee_allowances(*)
    `)
    .eq("org_id", orgId)
    .eq("status", "active");

  if (empError) throw empError;
  if (!employees.length) throw new Error("No active employees found.");

  // 3. Fetch System TDS Slabs
  const slabsSingle = await getTdsSlabs(bsYear, "single");
  const slabsCouple = await getTdsSlabs(bsYear, "couple");
  const calendar = await buildEmployeeCalendar({
    orgId,
    employees,
    allDates,
    startDateBs,
    endDateBs,
    startDateAd,
    endDateAd,
    todayAd: getNepalDateAd(),
  });

  const runItems = [];
  let totalBasic = 0, totalAllowancesAgg = 0, totalGross = 0, totalNet = 0;
  let totalSsfEmployee = 0, totalSsfEmployer = 0, totalSst = 0, totalTds = 0, totalAdvancesAgg = 0;

  for (const emp of employees) {
    const empCalendar = calendar.byEmployee.get(emp.id);
    const stats = empCalendar?.stats || {
      working_days: 0,
      present: 0,
      late: 0,
      half_day: 0,
      absent: 0,
      leave: 0,
      unpaid_days: 0,
    };

    const unpaidWorkingDays = Math.min(stats.working_days, stats.unpaid_days);
    const payableWorkDays = Math.max(0, stats.working_days - unpaidWorkingDays);
    const prorationRatio = stats.working_days > 0
      ? Math.min(1, payableWorkDays / stats.working_days)
      : 0;

    const basicSalary = Number(emp.basic_salary || 0);
    const hra = Number(emp.hra || 0);
    const travelAllowance = Number(emp.travel_allowance || 0);
    const medicalAllowance = Number(emp.medical_allowance || 0);
    const payableBasic = basicSalary * prorationRatio;
    const allowancesFixed = hra + travelAllowance + medicalAllowance;
    const allowancesVariable = (emp.allowances || [])
      .filter(a => a.is_active)
      .reduce((sum, a) => sum + Number(a.amount || 0), 0);
    
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

    const totalAdvances = (advances || []).reduce((sum, a) => sum + Number(a.amount || 0), 0);

    const totalDeductions = ssfEmployee + sstDeduction + monthlyTDS + totalAdvances;
    const netSalary = grossSalary - totalDeductions;

    runItems.push({
      employee_id: emp.id,
      org_id: orgId,
      working_days: stats.working_days,
      present_days: stats.present + stats.late,
      absent_days: stats.absent,
      late_days: stats.late,
      half_days: stats.half_day,
      leave_days: stats.leave,
      basic_salary: basicSalary,
      hra,
      travel_allowance: travelAllowance,
      medical_allowance: medicalAllowance,
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
    totalBasic += payableBasic;
    totalAllowancesAgg += payableAllowances;
    totalSsfEmployee += ssfEmployee;
    totalSsfEmployer += ssfEmployer;
    totalSst += sstDeduction;
    totalTds += monthlyTDS;
    totalAdvancesAgg += totalAdvances;
  }

  // 4. Save Payroll Run (Draft)
  const { data: run, error: runError } = await supabaseAdmin
    .from("payroll_runs")
    .insert({
      org_id: orgId,
      month_bs: monthBs,
      month_ad: startDateAd.substring(0, 7),
      bs_year: bsYear,
      bs_month: bsMonth,
      status: "draft",
      employee_count: employees.length,
      total_basic: totalBasic,
      total_allowances: totalAllowancesAgg,
      total_gross: totalGross,
      total_ssf_employee: totalSsfEmployee,
      total_ssf_employer: totalSsfEmployer,
      total_sst: totalSst,
      total_tds: totalTds,
      total_advances: totalAdvancesAgg,
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

function monthsWorkedForBonus(joinDateBs, bsYear) {
  if (!joinDateBs) return 12;
  const [joinYear, joinMonth] = String(joinDateBs).split("-").map(Number);
  if (!joinYear || !joinMonth) return 12;
  if (joinYear < bsYear) return 12;
  if (joinYear > bsYear) return 0;
  return Math.max(0, Math.min(12, 13 - joinMonth));
}

async function listFestivalBonuses(userId, query = {}) {
  const orgId = await resolveOrgId(userId);
  let q = supabaseAdmin
    .from("festival_bonuses")
    .select(`
      *,
      employee:employee_id(id, full_name, employee_code, designation)
    `)
    .eq("org_id", orgId);

  if (query.status) q = q.eq("status", query.status);
  if (query.bs_year) q = q.eq("bs_year", parseInt(query.bs_year, 10));
  if (query.festival_name) q = q.eq("festival_name", query.festival_name);

  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

async function generateFestivalBonuses(userId, body) {
  const orgId = await resolveOrgId(userId);
  const config = await getPayrollConfig(userId);
  if (!config) throw new Error("Payroll configuration not found. Please set it up first.");

  const { festival_name, bs_year, payment_mode = "standalone" } = body;
  const { data: employees, error: empError } = await supabaseAdmin
    .from("employees")
    .select("id, basic_salary, join_date_bs")
    .eq("org_id", orgId)
    .eq("status", "active");

  if (empError) throw empError;
  if (!employees.length) throw new Error("No active employees found.");

  const rows = employees
    .map((employee) => {
      const monthsWorked = monthsWorkedForBonus(employee.join_date_bs, bs_year);
      const calculatedBonus =
        Number(employee.basic_salary || 0) *
        Number(config.festival_bonus_months || 1) *
        (monthsWorked / 12);
      const finalBonus = Number(calculatedBonus.toFixed(2));

      return {
        org_id: orgId,
        employee_id: employee.id,
        festival_name,
        bs_year,
        months_worked: monthsWorked,
        basic_salary_at_bonus: employee.basic_salary || 0,
        calculated_bonus: finalBonus,
        final_bonus: finalBonus,
        tds_on_bonus: 0,
        net_bonus: finalBonus,
        payment_mode,
        status: "draft",
      };
    })
    .filter((row) => row.months_worked > 0);

  const { data, error } = await supabaseAdmin
    .from("festival_bonuses")
    .upsert(rows, { onConflict: "org_id,employee_id,festival_name" })
    .select(`
      *,
      employee:employee_id(id, full_name, employee_code, designation)
    `);

  if (error) throw error;
  return data;
}

async function updateFestivalBonusStatus(userId, bonusId, status) {
  const orgId = await resolveOrgId(userId);
  if (!["draft", "finalized", "paid"].includes(status)) {
    throw new Error("Invalid festival bonus status");
  }

  const patch = { status };
  if (status === "finalized" || status === "paid") {
    patch.finalized_by = userId;
    patch.finalized_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("festival_bonuses")
    .update(patch)
    .eq("id", bonusId)
    .eq("org_id", orgId)
    .select(`
      *,
      employee:employee_id(id, full_name, employee_code, designation)
    `)
    .single();

  if (error) throw error;
  return data;
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
  listFestivalBonuses,
  generateFestivalBonuses,
  updateFestivalBonusStatus,
  generatePayrollRun,
  listRuns,
  getRunDetails,
  finalizeRun,
  deleteRun,
};
