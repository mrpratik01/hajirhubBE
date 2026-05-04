const { supabaseAdmin } = require("../config/supabase");

// Join subscriptions with plan details
const SUBSCRIPTION_SELECT = `
  id,
  org_id,
  status,
  billing_cycle,
  trial_ends_at,
  current_period_start,
  current_period_end,
  cancelled_at,
  created_at,
  updated_at,
  plan:plan_id (
    id,
    name,
    display_name,
    display_name_nepali,
    max_employees,
    max_workplaces,
    max_admin_users,
    price_monthly,
    price_yearly,
    trial_days,
    feature_geofence,
    feature_qr_checkin,
    feature_offline_sync,
    feature_payroll,
    feature_ssf_export,
    feature_tds_engine,
    feature_festival_bonus,
    feature_viber_report,
    feature_whatsapp_report,
    feature_excel_export,
    feature_pdf_payslip,
    feature_multi_branch,
    feature_api_access,
    feature_biometric_hardware
  )
`.trim();

/**
 * Get the subscription for the org linked to a given user.
 * Used by the owner role.
 */
async function getSubscriptionByUserId(userId) {
  // 1. Resolve the user's org_id
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .single();

  if (userError) throw userError;
  if (!user?.org_id) throw new Error("No organization linked to this user");

  // 2. Fetch the subscription for that org
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("org_id", user.org_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data;
}

/**
 * List all subscriptions with pagination and optional filters.
 * Used by admin / super_admin.
 */
async function listAllSubscriptions({ limit = 50, offset = 0, status, org_id } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit)));
  const safeOffset = Math.max(0, Number(offset));

  let query = supabaseAdmin
    .from("subscriptions")
    .select(
      `${SUBSCRIPTION_SELECT},
      organization:org_id (
        id,
        name,
        slug,
        email,
        phone
      )`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (status) query = query.eq("status", status);
  if (org_id) query = query.eq("org_id", org_id);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data, count, limit: safeLimit, offset: safeOffset };
}

/**
 * Get a single subscription by its id.
 * Used by admin / super_admin.
 */
async function getSubscriptionById(id) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      `${SUBSCRIPTION_SELECT},
      organization:org_id (
        id,
        name,
        slug,
        email,
        phone
      )`
    )
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  getSubscriptionByUserId,
  listAllSubscriptions,
  getSubscriptionById,
};
