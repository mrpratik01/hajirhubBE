const subscriptionsService = require("../services/subscriptions.service");

/**
 * GET /api/organizations/me/subscription
 * Returns the subscription for the authenticated owner's org.
 */
async function getMySubscription(req, res) {
  try {
    const subscription = await subscriptionsService.getSubscriptionByUserId(req.user.id);
    return res.json({ data: subscription });
  } catch (err) {
    if (err.message === "No organization linked to this user") {
      return res.status(404).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message || "Failed to fetch subscription" });
  }
}

/**
 * GET /api/admin/subscriptions
 * List all subscriptions. Supports ?status=active&org_id=&limit=&offset=
 */
async function listAll(req, res) {
  try {
    const { limit, offset, status, org_id } = req.query;
    const result = await subscriptionsService.listAllSubscriptions({ limit, offset, status, org_id });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch subscriptions" });
  }
}

/**
 * GET /api/admin/subscriptions/:id
 * Get a single subscription by id.
 */
async function getById(req, res) {
  try {
    const subscription = await subscriptionsService.getSubscriptionById(req.params.id);
    return res.json({ data: subscription });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch subscription" });
  }
}

module.exports = { getMySubscription, listAll, getById };
