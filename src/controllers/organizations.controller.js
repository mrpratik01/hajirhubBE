const orgsService = require("../services/organizations.service");

/**
 * POST /api/organizations
 * Create a new org for the authenticated user.
 */
async function create(req, res) {
  try {
    const org = await orgsService.createOrg(req.user.id, req.body);
    return res.status(201).json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to create organization" });
  }
}

/**
 * GET /api/organizations/me
 * Get the org linked to the authenticated user.
 */
async function getMe(req, res) {
  try {
    const org = await orgsService.getOrgByUserId(req.user.id);
    if (!org) {
      return res.status(404).json({ error: "No organization found for this user" });
    }
    return res.json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch organization" });
  }
}

/**
 * PUT /api/organizations/me
 * Update the org linked to the authenticated user.
 */
async function updateMe(req, res) {
  try {
    const org = await orgsService.updateOrgByUserId(req.user.id, req.body);
    return res.json({ data: org });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to update organization" });
  }
}

/**
 * POST /api/organizations/me/logo
 * Upload logo for the authenticated user's org.
 * Expects: multipart/form-data with field "logo" OR raw body with Content-Type image/*
 */
async function uploadLogo(req, res) {
  try {
    let fileBuffer, mimeType;

    // Support raw binary upload (Content-Type: image/png or image/jpeg)
    if (req.headers["content-type"]?.startsWith("image/")) {
      fileBuffer = req.body;
      mimeType = req.headers["content-type"].split(";")[0].trim();

      if (!fileBuffer || fileBuffer.length === 0 || !Buffer.isBuffer(fileBuffer)) {
        return res.status(400).json({ 
          error: "Invalid or missing file body", 
          details: "Ensure the raw binary body is not empty and matches the Content-Type."
        });
      }
    } else {
      return res.status(400).json({ error: "Send image as raw binary with Content-Type: image/png or image/jpeg" });
    }

    const org = await organizationsService.uploadOrgLogo(req.user.id, fileBuffer, mimeType);
    return res.json({ data: { logo_url: org.logo_url } });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to upload logo" });
  }
}

module.exports = { create, getMe, updateMe, uploadLogo };
