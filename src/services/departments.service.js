const { supabaseAdmin } = require("../config/supabase");

// sort_order is intentionally excluded — it is auto-assigned, never sent by FE
const ALLOWED_FIELDS = new Set([
  "name",
  "name_nepali",
  "description",
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
 * Throws if the user has no linked org.
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
 * Get the next sort_order for a given org.
 * Scoped strictly to org_id so Org A's count never affects Org B.
 * Returns MAX(sort_order) + 1, or 1 if the org has no departments yet.
 */
async function nextSortOrder(orgId) {
  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? data.sort_order + 1 : 1;
}

/**
 * After a delete, close any gaps in sort_order for the org.
 * Fetches all remaining rows ordered by current sort_order and
 * reassigns 1, 2, 3 … in sequence — all scoped to the org.
 */
async function resequenceSortOrder(orgId) {
  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("id, sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return;

  // Build batch updates only for rows whose position changed
  const updates = data
    .map((row, index) => ({ id: row.id, sort_order: index + 1 }))
    .filter((row, index) => row.sort_order !== data[index].sort_order);

  for (const row of updates) {
    await supabaseAdmin
      .from("departments")
      .update({ sort_order: row.sort_order })
      .eq("id", row.id)
      .eq("org_id", orgId); // extra safety: never touch another org's rows
  }
}

/**
 * List all departments for the user's org.
 * Accessible by owner and hr_manager.
 */
async function listDepartments(userId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("*")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Create a department under the user's org.
 * sort_order is auto-assigned as MAX(org's sort_order) + 1.
 * Owner only.
 */
async function createDepartment(userId, body) {
  const orgId = await resolveOrgId(userId);
  const fields = pickFields(body);

  if (!fields.name) throw new Error("name is required");

  const sort_order = await nextSortOrder(orgId);

  const { data, error } = await supabaseAdmin
    .from("departments")
    .insert({ ...fields, org_id: orgId, sort_order })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error(`Department "${fields.name}" already exists`);
    throw error;
  }
  return data;
}

/**
 * Update a department. Verifies it belongs to the user's org.
 * sort_order cannot be changed via this endpoint.
 * Owner only.
 */
async function updateDepartment(userId, departmentId, body) {
  const orgId = await resolveOrgId(userId);
  const patch = pickFields(body);

  if (Object.keys(patch).length === 0) throw new Error("No valid fields to update");

  const { data, error } = await supabaseAdmin
    .from("departments")
    .update(patch)
    .eq("id", departmentId)
    .eq("org_id", orgId)   // scoped to org — prevents cross-tenant writes
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("Department name already exists");
    throw error;
  }
  if (!data) throw new Error("Department not found");
  return data;
}

/**
 * Delete a department and resequence sort_order for the org.
 * Owner only.
 */
async function deleteDepartment(userId, departmentId) {
  const orgId = await resolveOrgId(userId);

  const { data, error } = await supabaseAdmin
    .from("departments")
    .delete()
    .eq("id", departmentId)
    .eq("org_id", orgId)
    .select("id")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Department not found");

  // Close gaps left by the deletion — scoped to this org only
  await resequenceSortOrder(orgId);

  return data;
}

module.exports = {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
