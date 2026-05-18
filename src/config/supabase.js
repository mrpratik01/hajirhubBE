// src/config/supabase.js
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabaseOptions = {
  realtime: {
    transport: ws,
  },
};

// Admin
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, supabaseOptions);

// Verify JWTs
const supabaseAnon = createClient(supabaseUrl, anonKey, supabaseOptions);

// User scoped
function supabaseForUser(accessToken) {
  return createClient(supabaseUrl, anonKey, {
    ...supabaseOptions,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

module.exports = { supabaseAdmin, supabaseAnon, supabaseForUser };