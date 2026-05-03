const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const usersController = require("../controllers/users.controller");

const router = express.Router();

router.use(requireSupabaseUser);

router.get("/", usersController.listAll);
router.get("/me", usersController.getMe);
router.put("/me", usersController.putMe);

/** Staff only: super_admin | owner | hr_manager (from public.users.role) */
router.get("/", requireStaffRole, usersController.listAll);

module.exports = router;
