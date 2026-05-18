const express = require("express");
const hardwareController = require("../controllers/hardware.controller");

const router = express.Router();

/**
 * ZKTeco ADMS Push SDK endpoints.
 * These routes are intentionally unauthenticated because devices cannot send
 * Supabase bearer tokens.
 */
router.get("/getrequest", hardwareController.getRequest);
router.get("/cdata", hardwareController.getCData);
router.post("/cdata", hardwareController.postData);
router.post("/devicecmd", hardwareController.deviceCmd);

module.exports = router;
