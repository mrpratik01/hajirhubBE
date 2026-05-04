/**
 * Manual API smoke tests. Start the server first: npm start
 *
 * Auth (pick one):
 *   - Set TEST_ACCESS_TOKEN to a Supabase JWT, or
 *   - Set TEST_EMAIL + TEST_PASSWORD (uses SUPABASE_URL + SUPABASE_ANON_KEY from .env)
 *
 * Optional: API_BASE_URL (default http://localhost:3000)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { createClient } = require("@supabase/supabase-js");

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";

async function getToken() {
  if (process.env.TEST_ACCESS_TOKEN) {
    return process.env.TEST_ACCESS_TOKEN.trim();
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  if (!url || !anon || !email || !password) {
    console.error(
      "Missing auth: set TEST_ACCESS_TOKEN, or SUPABASE_URL + SUPABASE_ANON_KEY + TEST_EMAIL + TEST_PASSWORD in .env"
    );
    process.exit(1);
  }

  const supabase = createClient(url, anon);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("signInWithPassword:", error.message);
    process.exit(1);
  }
  const token = data.session?.access_token;
  if (!token) {
    console.error("No access_token in session (confirm email / check Supabase settings).");
    process.exit(1);
  }
  return token;
}

async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function label(name, ok) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}`);
}

async function main() {
  console.log(`API_BASE=${API_BASE}\n`);

  const rHealth = await request("GET", "/health");
  label("GET /health", rHealth.status === 200 && rHealth.json?.ok === true);

  const token = await getToken();

  const rMeGet = await request("GET", "/api/users/me", { token });
  label("GET /api/users/me (200)", rMeGet.status === 200);

  const rMePut = await request("PUT", "/api/users/me", {
    token,
    body: {
      full_name: "API Test User",
      preferred_lang: "en",
      timezone: "Asia/Kathmandu",
    },
  });
  label("PUT /api/users/me (200)", rMePut.status === 200);

  const rList = await request("GET", "/api/users?limit=10&offset=0", { token });
  const listOk = rList.status === 200 && Array.isArray(rList.json?.data);
  const listForbidden = rList.status === 403;
  if (listOk) {
    label("GET /api/users (200, staff)", true);
  } else if (listForbidden) {
    label("GET /api/users (403 — expected if your user.role is employee only)", true);
    console.log("       To get 200, set public.users.role to super_admin, owner, or hr_manager for this user.");
  } else {
    label(`GET /api/users (unexpected ${rList.status})`, false);
    console.log(JSON.stringify(rList.json, null, 2));
  }

  const rPlans = await request("GET", "/api/admin/plans", { token });
  if (rPlans.status === 200 && Array.isArray(rPlans.json?.data)) {
    label("GET /api/admin/plans (200, super_admin|owner)", true);
  } else if (rPlans.status === 403) {
    label("GET /api/admin/plans (403 — need owner or super_admin)", true);
  } else {
    label(`GET /api/admin/plans (${rPlans.status})`, false);
    console.log(JSON.stringify(rPlans.json, null, 2));
  }

  const r404 = await request("GET", "/api/nope", { token });
  label("GET unknown (404)", r404.status === 404);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
