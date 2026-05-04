const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireAdminPlanRole } = require("../middleware/requireAdminRole");
const subscriptionsController = require("../controllers/subscriptions.controller");

const router = express.Router();

router.use(requireSupabaseUser, requireAdminPlanRole);

router.get("/", subscriptionsController.listAll);
router.get("/:id", subscriptionsController.getById);

module.exports = router;
