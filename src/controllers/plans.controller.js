const plansService = require("../services/plans.service");

async function list(req, res) {
  try {
    const plans = await plansService.getAllPlans();
    return res.json({ data: plans });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch plans" });
  }
}

async function create(req, res) {
  try {
    const plan = await plansService.createPlan(req.body);
    return res.status(201).json({ data: plan });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to create plan" });
  }
}

async function update(req, res) {
  try {
    const plan = await plansService.updatePlan(req.params.id, req.body);
    return res.json({ data: plan });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to update plan" });
  }
}

async function toggle(req, res) {
  try {
    const plan = await plansService.togglePlan(req.params.id, req.body.is_active);
    return res.json({ data: plan });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to toggle plan" });
  }
}

module.exports = { list, create, update, toggle };
