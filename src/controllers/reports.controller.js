const reportsService = require("../services/reports.service");
const { handleError } = require("../middleware/errorHandler");

async function listReports(req, res) {
  try {
    const data = await reportsService.listReports(req.user.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "List reports");
  }
}

async function generateReport(req, res) {
  try {
    const { type, parameters } = req.body;
    if (!type) return res.status(400).json({ error: "Report type is required" });
    
    const data = await reportsService.generateReport(req.user.id, type, parameters || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, err, "Generate report");
  }
}

async function deleteReport(req, res) {
  try {
    const data = await reportsService.deleteReport(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Delete report");
  }
}

module.exports = {
  listReports,
  generateReport,
  deleteReport,
};
