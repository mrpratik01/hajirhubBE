const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireAdminPlanRole } = require("../middleware/requireAdminRole");
const usersController = require("../controllers/users.controller");

const router = express.Router();

router.use(requireSupabaseUser);

router.get("/me", usersController.getMe);
router.put("/me", usersController.putMe);

/**
 * POST /api/users/management/owner
 * Called after Supabase Auth signup to set up the owner profile.
 * Body: { full_name, email, phone, create_org_later? }
 * Sets role = 'owner' on the public.users row.
 */
router.post("/management/owner", usersController.setupOwner);

/** Staff only: super_admin | owner | hr_manager (from public.users.role) */
router.get("/", requireStaffRole, usersController.listAll);

module.exports = router;
