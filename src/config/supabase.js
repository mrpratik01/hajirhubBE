// src/config/supabase.js
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env");
}

// Admin (bypasses RLS). Use carefully.
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

// Verify JWTs from the frontend (auth.getUser)
const supabaseAnon = createClient(supabaseUrl, anonKey);

// User-scoped (RLS enforced) for DB queries using the user's JWT
function supabaseForUser(accessToken) {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = { supabaseAdmin, supabaseAnon, supabaseForUser };