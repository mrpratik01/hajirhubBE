const { supabaseAdmin } = require("../config/supabase");

const ALLOWED_FIELDS = new Set([
  "name",
  "name_nepali",
  "start_time",
  "end_time",
  "working_days",  // bitmask: Sun=1,Mon=2,Tue=4,Wed=8,Thu=16,Fri=32,Sat=64
  "is_default",
  "is_active",
]);

function pickFields(body) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const key of ALLOWED_FIELDS) {
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
 * If a shift is being set as default, clear the existing default first.
 */
async function clearDefaultShift(orgId) {
  await supabaseAdmin
    .from("shifts")
    .update({ is_default: false })
    .eq("org_id", orgId)
    .eq("is_default", true);
}

/**
 * List all shifts for the user's org.
 * Accessible by owner and hr_manager.
 */
async function listShifts(userId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("shifts")
    .select("*")
    .eq("org_id", orgId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Create a shift under the user's org.
 * Owner only.
 */
async function createShift(userId, body) {
  const orgId = await resolveOrgId(userId);
  const fields = pickFields(body);

  if (!fields.name) throw new Error("name is required");
  if (!fields.start_time) throw new Error("start_time is required");
  if (!fields.end_time) throw new Error("end_time is required");

  // Only one default shift per org
  if (fields.is_default) await clearDefaultShift(orgId);

  const { data, error } = await supabaseAdmin
    .from("shifts")
    .insert({ ...fields, org_id: orgId })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error(`Shift "${fields.name}" already exists`);
    throw error;
  }
  return data;
}

/**
 * Update a shift. Verifies it belongs to the user's org.
 * Owner only.
 */
async function updateShift(userId, shiftId, body) {
  const orgId = await resolveOrgId(userId);
  const patch = pickFields(body);

  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  // Only one default shift per org
  if (patch.is_default === true) await clearDefaultShift(orgId);

  const { data, error } = await supabaseAdmin
    .from("shifts")
    .update(patch)
    .eq("id", shiftId)
    .eq("org_id", orgId)   // scoped to org — prevents cross-tenant writes
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("Shift name already exists");
    throw error;
  }
  if (!data) throw new Error("Shift not found");
  return data;
}

/**
 * Delete a shift. Verifies it belongs to the user's org.
 * Owner only.
 */
async function deleteShift(userId, shiftId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("shifts")
    .delete()
    .eq("id", shiftId)
    .eq("org_id", orgId)
    .select("id")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Shift not found");
  return data;
}

module.exports = {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
};
