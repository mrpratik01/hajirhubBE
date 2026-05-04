const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireAdminPlanRole } = require("../middleware/requireAdminRole");
const plansController = require("../controllers/plans.controller");

const router = express.Router();

router.use(requireSupabaseUser, requireAdminPlanRole);

router.get("/", plansController.list);
router.post("/", plansController.create);
router.patch("/:id/toggle", plansController.toggle);
router.put("/:id", plansController.update);

module.exports = router;
