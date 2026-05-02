const { supabaseAnon } = require("../config/supabase");

/**
 * Expects: Authorization: Bearer <supabase_access_token>
 * Attaches req.user (Supabase Auth user) and req.accessToken.
 */
async function requireSupabaseUser(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization bearer token" });
  }

  const accessToken = header.slice("Bearer ".length).trim();
  if (!accessToken) {
    return res.status(401).json({ error: "Empty bearer token" });
  }

  const {
    data: { user },
    error,
  } = await supabaseAnon.auth.getUser(accessToken);

  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.accessToken = accessToken;
  req.user = user;
  return next();
}

module.exports = { requireSupabaseUser };
