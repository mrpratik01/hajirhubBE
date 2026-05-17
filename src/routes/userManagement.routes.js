const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireSuperAdminRole } = require("../middleware/requireSuperAdminRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const userManagementController = require("../controllers/userManagement.controller");

const router = express.Router();

router.use(requireSupabaseUser);

// ─── User Creation Endpoints ───────────────────────────────────────────────────

// POST /api/users/owner - Super Admin only
router.post("/owner", requireSuperAdminRole, (req, res, next) => {
  console.log('[Route] POST /api/users/management/owner - Request received');
  console.log('[Route] Request body:', req.body);
  console.log('[Route] Request headers:', req.headers);
  next();
}, userManagementController.createOwner);

// POST /api/users/hr-manager - Owner only
router.post("/hr-manager", requireOwnerRole, userManagementController.createHRManager);

// ─── User Management Endpoints ─────────────────────────────────────────────────

// GET /api/users/roles - Get creatable roles for current user
router.get("/roles", userManagementController.getCreatableRoles);

// GET /api/users/:userId/credentials - Get user credentials (role-based access)
router.get("/:userId/credentials", userManagementController.getUserCredentials);

// GET /api/users/organization/:orgId/users - Get organization users (role-based access)
router.get("/organization/:orgId/users", userManagementController.getOrganizationUsers);

// POST /api/users/:userId/reset-password - Admin password reset (role-based access)
router.post("/:userId/reset-password", userManagementController.adminResetPassword);

module.exports = router;
