const { supabaseAdmin } = require("../config/supabase");

// Fields allowed for general workplace create/update
const WORKPLACE_FIELDS = new Set([
  "name",
  "name_nepali",
  "address",
  "ward_no",
  "municipality",
  "district",
  "latitude",
  "longitude",
  "radius_meters",
  "geofence_enabled",
  "qr_enabled",
  "is_primary",
  "is_active",
]);

// Fields allowed for geofence-only update
const GEOFENCE_FIELDS = new Set([
  "latitude",
  "longitude",
  "radius_meters",
  "geofence_enabled",
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
 * Verify a workplace exists and belongs to the given org.
 * Returns the workplace row or throws.
 */
async function assertWorkplaceOwnership(workplaceId, orgId) {
  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .select("*")
    .eq("id", workplaceId)
    .eq("org_id", orgId)   // cross-tenant guard
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Workplace not found");
  return data;
}

// ─── Workplaces ──────────────────────────────────────────────────────────────

/**
 * List all workplaces for the user's org.
 */
async function listWorkplaces(userId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .select("*")
    .eq("org_id", orgId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Get a single workplace — must belong to the user's org.
 */
async function getWorkplace(userId, workplaceId) {
  const orgId = await resolveOrgId(userId);
  return assertWorkplaceOwnership(workplaceId, orgId);
}

/**
 * Create a workplace under the user's org.
 */
async function createWorkplace(userId, body) {
  const orgId = await resolveOrgId(userId);
  const fields = pickFields(body, WORKPLACE_FIELDS);

  // Required field validation
  if (!fields.name) throw new Error("name is required");
  if (fields.latitude == null) throw new Error("latitude is required");
  if (fields.longitude == null) throw new Error("longitude is required");

  // radius_meters constraint mirrors DB CHECK (10–500)
  if (fields.radius_meters != null) {
    const r = Number(fields.radius_meters);
    if (r < 10 || r > 500) throw new Error("radius_meters must be between 10 and 500");
  }

  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .insert({ ...fields, org_id: orgId })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update general info (name, address, flags, etc.) — org-scoped.
 */
async function updateWorkplace(userId, workplaceId, body) {
  const orgId = await resolveOrgId(userId);
  await assertWorkplaceOwnership(workplaceId, orgId);

  const patch = pickFields(body, WORKPLACE_FIELDS);
  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  if (patch.radius_meters != null) {
    const r = Number(patch.radius_meters);
    if (r < 10 || r > 500) throw new Error("radius_meters must be between 10 and 500");
  }

  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .update(patch)
    .eq("id", workplaceId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update geofence fields only (lat, lng, radius, geofence_enabled) — org-scoped.
 */
async function updateGeofence(userId, workplaceId, body) {
  const orgId = await resolveOrgId(userId);
  await assertWorkplaceOwnership(workplaceId, orgId);

  const patch = pickFields(body, GEOFENCE_FIELDS);
  if (Object.keys(patch).length === 0) throw new Error("No valid geofence fields to update");

  if (patch.radius_meters != null) {
    const r = Number(patch.radius_meters);
    if (r < 10 || r > 500) throw new Error("radius_meters must be between 10 and 500");
  }

  const { data, error } = await supabaseAdmin
    .from("workplaces")
    .update(patch)
    .eq("id", workplaceId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── QR Tokens ───────────────────────────────────────────────────────────────
// QR tokens live in the qr_tokens table (separate from workplaces).
// Schema: id, org_id, workplace_id, token, version, is_active,
//         issued_at, expires_at, last_used_at, use_count

/**
 * Get the active, non-expired QR token for a workplace.
 * If none exists, generates one automatically.
 */
async function getOrCreateQRToken(userId, workplaceId) {
  const orgId = await resolveOrgId(userId);
  const workplace = await assertWorkplaceOwnership(workplaceId, orgId);

  if (!workplace.qr_enabled) {
    throw new Error("QR check-in is not enabled for this workplace");
  }

  // Look for an existing active, non-expired token
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("qr_tokens")
    .select("*")
    .eq("workplace_id", workplaceId)
    .eq("org_id", orgId)
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (existing) return existing;

  // None found — generate a fresh one
  return _issueQRToken(orgId, workplaceId, 1);
}

/**
 * Rotate (invalidate current + issue new) QR token for a workplace.
 */
async function rotateQRToken(userId, workplaceId) {
  const orgId = await resolveOrgId(userId);
  const workplace = await assertWorkplaceOwnership(workplaceId, orgId);

  if (!workplace.qr_enabled) {
    throw new Error("QR check-in is not enabled for this workplace");
  }

  // Deactivate all existing tokens for this workplace
  const { error: deactivateError } = await supabaseAdmin
    .from("qr_tokens")
    .update({ is_active: false })
    .eq("workplace_id", workplaceId)
    .eq("org_id", orgId);

  if (deactivateError) throw deactivateError;

  // Get the latest version number to increment
  const { data: latest } = await supabaseAdmin
    .from("qr_tokens")
    .select("version")
    .eq("workplace_id", workplaceId)
    .eq("org_id", orgId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = latest ? latest.version + 1 : 1;
  return _issueQRToken(orgId, workplaceId, nextVersion);
}

/**
 * Internal: insert a new qr_tokens row.
 * Token value is generated by the DB default (gen_random_bytes).
 */
async function _issueQRToken(orgId, workplaceId, version) {
  const { data, error } = await supabaseAdmin
    .from("qr_tokens")
    .insert({
      org_id: orgId,
      workplace_id: workplaceId,
      version,
      is_active: true,
      // token and expires_at use DB defaults
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  listWorkplaces,
  getWorkplace,
  createWorkplace,
  updateWorkplace,
  updateGeofence,
  getOrCreateQRToken,
  rotateQRToken,
};
