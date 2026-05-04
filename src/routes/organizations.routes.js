const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const orgsController = require("../controllers/organizations.controller");
const subscriptionsController = require("../controllers/subscriptions.controller");

const router = express.Router();

router.use(requireSupabaseUser);

router.post("/", orgsController.create);
router.get("/me", orgsController.getMe);
router.put("/me", orgsController.updateMe);
router.get("/me/subscription", subscriptionsController.getMySubscription);

// Raw binary upload — parse body as buffer instead of JSON
router.post(
  "/me/logo",
  express.raw({ type: "image/*", limit: "5mb" }),
  orgsController.uploadLogo
);

module.exports = router;
