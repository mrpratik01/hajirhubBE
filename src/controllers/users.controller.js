const usersService = require("../services/users.service");

async function getMe(req, res) {
  try {
    const row = await usersService.getUserRowById(req.user.id);
    return res.json({
      auth: { id: req.user.id, email: req.user.email },
      profile: row,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to load profile" });
  }
}

/**
 * Creates or updates the public.users row for the authenticated user.
 * Body should use snake_case keys matching the table (subset allowed).
 */
async function putMe(req, res) {
  try {
    const patch = usersService.pickProfilePatch(req.body);

    if (patch.email == null && req.user.email) {
      patch.email = req.user.email;
    }

    if (
      patch.full_name === undefined &&
      typeof req.user.user_metadata?.full_name === "string" &&
      req.user.user_metadata.full_name.length > 0
    ) {
      patch.full_name = req.user.user_metadata.full_name;
    }

    const row = await usersService.upsertUserProfile(req.user.id, patch);
    return res.json({ profile: row });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to save profile" });
  }
}

module.exports = { getMe, putMe };
