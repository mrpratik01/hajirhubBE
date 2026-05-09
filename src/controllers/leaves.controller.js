const leavesService = require("../services/leaves.service");

function handleError(res, err, context = "Operation") {
  const msg = err.message || `${context} failed`;

  if (msg.includes("not found")) return res.status(404).json({ error: msg });
  if (
    msg.includes("required") ||
    msg.includes("must be") ||
    msg.includes("greater than") ||
    msg.includes("only available") ||
    msg.includes("YYYY-MM")
  ) {
    return res.status(400).json({ error: msg });
  }
  if (msg.includes("already exists")) return res.status(409).json({ error: msg });
  if (msg.includes("Insufficient leave balance")) return res.status(422).json({ error: msg });
  if (
    msg.includes("Cannot approve") ||
    msg.includes("Cannot reject") ||
    msg.includes("Cannot cancel") ||
    msg.includes("own requests") ||
    msg.includes("not active")
  ) {
    return res.status(422).json({ error: msg });
  }
  if (msg.includes("overlapping")) return res.status(409).json({ error: msg });

  console.error(`[leaves] ${context}:`, err);
  return res.status(500).json({ error: msg });
}

// ─── Leave Types ──────────────────────────────────────────────────────────────

/**
 * GET /api/leaves/types
 * Owner/HR: all types (including inactive with ?include_inactive=true)
 * Employee: active types only
 */
async function listTypes(req, res) {
  try {
    const includeInactive = req.query.include_inactive === "true";
    const data = await leavesService.listLeaveTypes(req.user.id, includeInactive);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "List leave types");
  }
}

/**
 * POST /api/leaves/types
 * Owner only: create a leave type.
 */
async function createType(req, res) {
  try {
    const data = await leavesService.createLeaveType(req.user.id, req.body);
    return res.status(201).json({ data });
  } catch (err) {
    return handleError(res, err, "Create leave type");
  }
}

/**
 * PUT /api/leaves/types/:id
 * Owner only: update a leave type.
 */
async function updateType(req, res) {
  try {
    const data = await leavesService.updateLeaveType(req.user.id, req.params.id, req.body);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Update leave type");
  }
}

// ─── Leave Balances ───────────────────────────────────────────────────────────

/**
 * GET /api/leaves/balances/my?year=2082
 * Employee: own leave balances for a BS year.
 */
async function getMyBalances(req, res) {
  try {
    const bsYear = parseInt(req.query.year);
    if (!bsYear) return res.status(400).json({ error: "year query param is required (BS year, e.g. 2082)" });
    const data = await leavesService.getMyLeaveBalances(req.user.id, bsYear);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get my leave balances");
  }
}

/**
 * GET /api/leaves/balances/:employeeId?year=2082
 * Owner/HR: leave balances for any employee.
 */
async function getEmployeeBalances(req, res) {
  try {
    const bsYear = parseInt(req.query.year);
    if (!bsYear) return res.status(400).json({ error: "year query param is required (BS year, e.g. 2082)" });
    const data = await leavesService.getEmployeeLeaveBalances(req.user.id, req.params.employeeId, bsYear);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get employee leave balances");
  }
}

// ─── Leave Requests ───────────────────────────────────────────────────────────

/**
 * POST /api/leaves/apply
 * Employee: submit a leave request.
 */
async function apply(req, res) {
  try {
    const data = await leavesService.applyLeave(req.user.id, req.body);
    return res.status(201).json({ data });
  } catch (err) {
    return handleError(res, err, "Apply leave");
  }
}

/**
 * GET /api/leaves
 * Owner/HR: all leave requests with filters.
 * Query: ?status=pending&employee_id=uuid&month=2025-04&page=1&limit=20
 */
async function list(req, res) {
  try {
    const result = await leavesService.listLeaveRequests(req.user.id, req.query);
    return res.json(result);
  } catch (err) {
    return handleError(res, err, "List leave requests");
  }
}

/**
 * GET /api/leaves/my
 * Employee: own leave requests.
 * Query: ?status=pending&page=1&limit=20
 */
async function listMy(req, res) {
  try {
    const result = await leavesService.getMyLeaveRequests(req.user.id, req.query);
    return res.json(result);
  } catch (err) {
    return handleError(res, err, "Get my leave requests");
  }
}

/**
 * PUT /api/leaves/:id/approve
 * Owner/HR: approve a leave request.
 * Body: { review_note } (optional)
 */
async function approve(req, res) {
  try {
    const data = await leavesService.approveLeave(req.user.id, req.params.id, req.body.review_note);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Approve leave");
  }
}

/**
 * PUT /api/leaves/:id/reject
 * Owner/HR: reject a leave request.
 * Body: { review_note } (optional but recommended)
 */
async function reject(req, res) {
  try {
    const data = await leavesService.rejectLeave(req.user.id, req.params.id, req.body.review_note);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Reject leave");
  }
}

/**
 * PUT /api/leaves/:id/cancel
 * Employee: cancel own pending request.
 */
async function cancel(req, res) {
  try {
    const data = await leavesService.cancelLeave(req.user.id, req.params.id);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Cancel leave");
  }
}

/**
 * GET /api/leaves/calendar?month=2025-04
 * Owner/HR: all employees' leaves for a month (calendar view).
 */
async function calendar(req, res) {
  try {
    const data = await leavesService.getLeaveCalendar(req.user.id, req.query.month);
    return res.json({ data });
  } catch (err) {
    return handleError(res, err, "Get leave calendar");
  }
}

module.exports = {
  listTypes, createType, updateType,
  getMyBalances, getEmployeeBalances,
  apply, list, listMy,
  approve, reject, cancel,
  calendar,
};
