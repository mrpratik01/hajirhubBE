const { supabaseAdmin } = require("../config/supabase");

// Fields the owner is allowed to write
const ALLOWED_ORG_FIELDS = new Set([
  "name",
  "name_nepali",
  "slug",
  "pan_no",
  "ssf_reg_no",
  "ird_reg_no",
  "phone",
  "email",
  "website",
  "address_line1",
  "address_line2",
  "ward_no",
  "municipality",
  "district",
  "province",
  "viber_id",
  "whatsapp_no",
  "fiscal_year_start_month",
  "checkin_window_start",
  "checkin_window_end",
  "late_grace_minutes",
  "half_day_threshold_hours",
  "require_selfie",
  "onboarding_completed",
  "onboarding_step",
]);

function pickOrgFields(body) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const key of ALLOWED_ORG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  return patch;
}

/**
 * Creates an org, subscribes it to the pro plan, and links the creator user.
 */
async function createOrg(userId, body) {
  const fields = pickOrgFields(body);

  // 1. Insert org
  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .insert(fields)
    .select("*")
    .single();

  if (orgError) throw orgError;

  // 2. Look up the pro plan
  const { data: proPlan, error: planError } = await supabaseAdmin
    .from("plans")
    .select("id")
    .eq("name", "pro")
    .single();

  if (planError || !proPlan) {
    throw new Error("Pro plan not found. Please seed the plans table.");
  }

  // 3. Insert subscription
  const { error: subError } = await supabaseAdmin
    .from("subscriptions")
    .insert({
      org_id: org.id,
      plan_id: proPlan.id,
      status: "active",
    });

  if (subError) throw subError;

  // 4. Link creator user to the org
  const { error: userError } = await supabaseAdmin
    .from("users")
    .update({ org_id: org.id })
    .eq("id", userId);

  if (userError) throw userError;

  return org;
}

/**
 * Get org belonging to the authenticated user.
 */
async function getOrgByUserId(userId) {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .single();

  if (userError) throw userError;
  if (!user?.org_id) return null;

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .select("*")
    .eq("id", user.org_id)
    .single();

  if (orgError) throw orgError;
  return org;
}

/**
 * Update org belonging to the authenticated user.
 */
async function updateOrgByUserId(userId, body) {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .single();

  if (userError) throw userError;
  if (!user?.org_id) throw new Error("No organization linked to this user");

  const patch = pickOrgFields(body);

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .update(patch)
    .eq("id", user.org_id)
    .select("*")
    .single();

  if (orgError) throw orgError;
  return org;
}

/**
 * Upload logo to Supabase Storage and update logo_url/logo_path on the org.
 */
async function uploadOrgLogo(userId, fileBuffer, mimeType, fileName) {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .single();

  if (userError) throw userError;
  if (!user?.org_id) throw new Error("No organization linked to this user");

  // Validate file type and size
  const ALLOWED_MIME = new Set([
    "image/jpeg", "image/png", "image/webp",
  ]);
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error("Unsupported image type. Allowed: JPEG, PNG, WebP");
  }

  const maxSize = 5 * 1024 * 1024; // 5MB
  if (fileBuffer.length > maxSize) {
    throw new Error("File too large. Maximum size is 5MB");
  }

  const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
  const path = `logos/${user.org_id}/logo.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("hajirhub-storage")
    .upload(path, fileBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabaseAdmin.storage
    .from("hajirhub-storage")
    .getPublicUrl(path);

  const logo_url = publicUrlData.publicUrl;

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .update({ 
      logo_path: path,
      logo_url: logo_url 
    })
    .eq("id", user.org_id)
    .select("*")
    .single();

  if (orgError) throw orgError;
  return org;
}

// ─── Super Admin ────────────────────────────────────────────────────────────

/**
 * List all orgs with pagination and optional search.
 */
async function listAllOrgs({ limit = 50, offset = 0, search } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit)));
  const safeOffset = Math.max(0, Number(offset));

  let query = supabaseAdmin
    .from("organizations")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (search) {
    query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { data, count, limit: safeLimit, offset: safeOffset };
}

/**
 * Get any single org by id.
 */
async function getOrgById(id) {
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Admin update any org by id.
 */
async function updateOrgById(id, body) {
  const patch = pickOrgFields(body);

  const { data, error } = await supabaseAdmin
    .from("organizations")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Activate or deactivate an org.
 */
async function toggleOrgById(id, isActive, reason) {
  const patch = {
    is_active: isActive,
    deactivated_at: isActive ? null : new Date().toISOString(),
    deactivation_reason: isActive ? null : (reason || null),
  };

  const { data, error } = await supabaseAdmin
    .from("organizations")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  createOrg,
  getOrgByUserId,
  updateOrgByUserId,
  uploadOrgLogo,
  listAllOrgs,
  getOrgById,
  updateOrgById,
  toggleOrgById,
};
