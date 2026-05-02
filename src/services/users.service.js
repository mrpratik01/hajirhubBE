const { supabaseAdmin } = require("../config/supabase");

/**
 * Fields the API is allowed to write. id always comes from the verified JWT.
 * role / security counters are not client-writable here.
 */
const PROFILE_PATCH_KEYS = new Set([
  "full_name",
  "full_name_nepali",
  "phone",
  "email",
  "avatar_url",
  "org_id",
  "employee_id",
  "expo_push_token",
  "push_enabled",
  "preferred_lang",
  "timezone",
  "is_active",
  "last_login_at",
]);

function pickProfilePatch(body) {
  if (!body || typeof body !== "object") return {};
  const patch = {};
  for (const key of PROFILE_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  return patch;
}

async function getUserRowById(userId) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertUserProfile(userId, patch) {
  const { data, error } = await supabaseAdmin
    .from("users")
    .upsert(
      { id: userId, ...patch },
      { onConflict: "id" }
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  pickProfilePatch,
  getUserRowById,
  upsertUserProfile,
};
