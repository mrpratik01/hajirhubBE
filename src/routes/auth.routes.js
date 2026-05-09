const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { checkSuspension } = require("../middleware/checkSuspension");
const authController = require("../controllers/auth.controller");

const router = express.Router();

router.use(requireSupabaseUser);

// GET /api/auth/me — employee profile + password_changed, activates on first call
router.get("/me", checkSuspension, authController.getMe);

// PUT /api/auth/change-password — verify current password, set new password
// Note: checkSuspension NOT applied here — suspended employees must still be
// able to change their password if they need to (edge case: suspended but not terminated)
router.put("/change-password", authController.changePassword);

module.exports = router;
