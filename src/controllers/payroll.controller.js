const payrollService = require("../services/payroll.service");
const { handleError } = require("../middleware/errorHandler");

async function getConfig(req, res) {
  try {
    const data = await payrollService.getPayrollConfig(req.user.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get payroll config");
  }
}

async function updateConfig(req, res) {
  try {
    const data = await payrollService.updatePayrollConfig(req.user.id, req.body);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Update payroll config");
  }
}

async function listAdvances(req, res) {
  try {
    const data = await payrollService.listAdvances(req.user.id, req.query);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "List advances");
  }
}

async function createAdvance(req, res) {
  try {
    const data = await payrollService.createAdvance(req.user.id, req.body);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Create advance");
  }
}

async function updateAdvanceStatus(req, res) {
  try {
    const data = await payrollService.updateAdvanceStatus(
      req.user.id,
      req.params.id,
      req.body.status,
      req.body.note
    );
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Update advance status");
  }
}

async function getTdsSlabs(req, res) {
  try {
    const { year, status } = req.query;
    if (!year || !status) {
      return res.status(400).json({ error: "year and status are required" });
    }
    const data = await payrollService.getTdsSlabs(parseInt(year), status);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get TDS slabs");
  }
}

async function listRuns(req, res) {
  try {
    const data = await payrollService.listRuns(req.user.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "List payroll runs");
  }
}

async function getRunDetails(req, res) {
  try {
    const data = await payrollService.getRunDetails(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get payroll run details");
  }
}

async function generateRun(req, res) {
  try {
    const { month_bs } = req.body;
    if (!month_bs) return res.status(400).json({ error: "month_bs is required" });
    const data = await payrollService.generatePayrollRun(req.user.id, month_bs);
    return res.json(data);
  } catch (err) {
    return handleError(res, err, "Generate payroll run");
  }
}

async function finalizeRun(req, res) {
  try {
    const data = await payrollService.finalizeRun(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Finalize payroll run");
  }
}

async function deleteRun(req, res) {
  try {
    const data = await payrollService.deleteRun(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Delete payroll run");
  }
}

module.exports = {
  getConfig,
  updateConfig,
  listAdvances,
  createAdvance,
  updateAdvanceStatus,
  getTdsSlabs,
  listRuns,
  getRunDetails,
  generateRun,
  finalizeRun,
  deleteRun,
};
