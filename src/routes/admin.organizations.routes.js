const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireAdminPlanRole } = require("../middleware/requireAdminRole");
const adminOrgsController = require("../controllers/admin.organizations.controller");

const router = express.Router();

// Both middlewares required — must be logged in AND be admin/super_admin
router.use(requireSupabaseUser, requireAdminPlanRole);

router.get("/", adminOrgsController.listAll);
router.get("/:id", adminOrgsController.getById);
router.put("/:id", adminOrgsController.updateById);
router.patch("/:id/toggle", adminOrgsController.toggle);

module.exports = router;
