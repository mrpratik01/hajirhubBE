const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const usersController = require("../controllers/users.controller");

const router = express.Router();

router.use(requireSupabaseUser);

router.get("/me", usersController.getMe);
router.put("/me", usersController.putMe);

module.exports = router;
