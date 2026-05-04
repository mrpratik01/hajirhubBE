const { supabaseAdmin } = require("../config/supabase");

const PLAN_KEYS = new Set([
  "name",
  "display_name",
  "display_name_nepali",
  "max_employees",
  "max_workplaces",
  "max_admin_users",
  "feature_geofence",
  "feature_qr_checkin",
  "feature_offline_sync",
  "feature_payroll",
  "feature_ssf_export",
  "feature_tds_engine",
  "feature_festival_bonus",
  "feature_viber_report",
  "feature_whatsapp_report",
  "feature_excel_export",
  "feature_pdf_payslip",
  "feature_multi_branch",
  "feature_api_access",
  "feature_biometric_hardware",
  "price_monthly",
  "price_yearly",
  "price_yearly_per_month",
  "trial_days",
  "is_active",
  "sort_order",
]);

function pickPlanFields(body) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const key of PLAN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  return patch;
}

async function getAllPlans() {
  const { data, error } = await supabaseAdmin
    .from("plans")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data;
}

async function createPlan(body) {
  const fields = pickPlanFields(body);

  const { data, error } = await supabaseAdmin
    .from("plans")
    .insert({ ...fields, is_active: fields.is_active ?? true })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function updatePlan(id, body) {
  const fields = pickPlanFields(body);

  const { data, error } = await supabaseAdmin
    .from("plans")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function togglePlan(id, isActive) {
  // If isActive not provided, flip the current value
  let newValue = isActive;

  if (typeof newValue !== "boolean") {
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("plans")
      .select("is_active")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;
    newValue = !existing.is_active;
  }

  const { data, error } = await supabaseAdmin
    .from("plans")
    .update({ is_active: newValue, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = { getAllPlans, createPlan, updatePlan, togglePlan };
