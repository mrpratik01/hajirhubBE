const employeesService = require("../services/employees.service");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function handleError(res, err, context = "Operation") {
  const msg = err.message || `${context} failed`;

  if (msg === "Employee not found" || msg === "Document not found") {
    return res.status(404).json({ error: msg });
  }
  if (
    msg.includes("required") ||
    msg.includes("Invalid doc_type") ||
    msg.includes("Unsupported file type") ||
    msg.includes("File too large") ||
    msg.includes("No valid fields") ||
    msg.includes("No salary fields") ||
    msg.includes("Empty file")
  ) {
    return res.status(400).json({ error: msg });
  }
  if (msg.includes("No organization linked")) {
    return res.status(403).json({ error: msg });
  }
  if (msg.includes("already registered") || msg.includes("Duplicate")) {
    return res.status(409).json({ error: msg });
  }
  if (msg.includes("limit reached")) {
    return res.status(402).json({ error: msg });
  }
  if (msg.includes("Cannot invite") || msg.includes("already has active")) {
    return res.status(422).json({ error: msg });
  }

  console.error(`[employees] ${context}:`, err);
  return res.status(500).json({ error: msg });
}

// ─── Employee CRUD ────────────────────────────────────────────────────────────

/**
 * GET /api/employees
 * Owner + HR: paginated list with search & filters.
 * Query: ?search=&department_id=&status=&page=1&limit=20
 */
async function list(req, res) {
  try {
    const result = await employeesService.listEmployees(req.user.id, req.query);
    return res.json(result);
  } catch (err) {
    return handleError(res, err, "List employees");
  }
}

/**
 * POST /api/employees
 * Owner only: create a new employee.
 */
async function create(req, res) {
  try {
    const employee = await employeesService.createEmployee(req.user.id, req.body);
    return res.status(201).json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Create employee");
  }
}

/**
 * GET /api/employees/me
 * Employee: own profile.
 */
async function getMe(req, res) {
  try {
    const employee = await employeesService.getMyProfile(req.user.id);
    return res.json({ data: employee });
  } catch (err) {
    if (err.message?.includes("No employee profile")) {
      return res.status(404).json({ error: err.message });
    }
    return handleError(res, err, "Get own profile");
  }
}

/**
 * GET /api/employees/:id
 * Owner + HR: full employee profile.
 */
async function get(req, res) {
  try {
    const employee = await employeesService.getEmployee(req.user.id, req.params.id);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Get employee");
  }
}

/**
 * PUT /api/employees/:id
 * Owner only: update profile fields.
 */
async function update(req, res) {
  try {
    const employee = await employeesService.updateEmployee(req.user.id, req.params.id, req.body);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Update employee");
  }
}

/**
 * PUT /api/employees/:id/deactivate
 * Owner only: soft-terminate an employee.
 * Body: { exit_date_bs, exit_date_ad, termination_reason }
 */
async function deactivate(req, res) {
  try {
    const employee = await employeesService.deactivateEmployee(req.user.id, req.params.id, req.body);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Deactivate employee");
  }
}

// ─── Salary ───────────────────────────────────────────────────────────────────

/**
 * PUT /api/employees/:id/salary
 * Owner only: update salary with revision log.
 * Body: { basic_salary, hra, travel_allowance, medical_allowance,
 *         effective_date_bs, effective_date_ad, reason }
 */
async function updateSalary(req, res) {
  try {
    const employee = await employeesService.updateSalary(req.user.id, req.params.id, req.body);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Update salary");
  }
}

// ─── Assignments ──────────────────────────────────────────────────────────────

/**
 * PUT /api/employees/:id/shift
 * Owner only: assign a shift.
 * Body: { shift_id } — pass null to unassign.
 */
async function assignShift(req, res) {
  try {
    const { shift_id } = req.body;
    const employee = await employeesService.assignShift(req.user.id, req.params.id, shift_id ?? null);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Assign shift");
  }
}

/**
 * PUT /api/employees/:id/workplace
 * Owner only: assign a workplace.
 * Body: { workplace_id } — pass null to unassign.
 */
async function assignWorkplace(req, res) {
  try {
    const { workplace_id } = req.body;
    const employee = await employeesService.assignWorkplace(req.user.id, req.params.id, workplace_id ?? null);
    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Assign workplace");
  }
}

// ─── App Invite ───────────────────────────────────────────────────────────────

/**
 * POST /api/employees/:id/invite
 * Owner only: mark employee as invited (SMS/WhatsApp handled by notification service).
 */
async function invite(req, res) {
  try {
    const employee = await employeesService.inviteEmployee(req.user.id, req.params.id);
    return res.json({ data: employee, message: "Invite sent successfully" });
  } catch (err) {
    return handleError(res, err, "Invite employee");
  }
}

// ─── Photo ────────────────────────────────────────────────────────────────────

/**
 * PUT /api/employees/:id/photo
 * Owner only: upload employee photo.
 * Expects raw binary body with Content-Type: image/*
 */
async function uploadPhoto(req, res) {
  try {
    const mimeType = req.headers["content-type"]?.split(";")[0].trim();
    const fileBuffer = req.body;

    if (!fileBuffer || fileBuffer.length === 0 || !Buffer.isBuffer(fileBuffer)) {
      return res.status(400).json({ 
        error: "Invalid or missing file body", 
        details: "Ensure Content-Type is image/* and the body is not empty."
      });
    }

    if (!mimeType?.startsWith("image/")) {
      return res.status(400).json({ error: "Invalid file type. Only images are allowed" });
    }

    const employee = await employeesService.uploadPhoto(req.user.id, req.params.id, {
      fileBuffer,
      mimeType,
    });

    return res.json({ data: employee });
  } catch (err) {
    return handleError(res, err, "Upload photo");
  }
}

// ─── Documents ────────────────────────────────────────────────────────────────

/**
 * GET /api/employees/:id/documents
 * Owner + HR: list all documents for an employee.
 */
async function listDocuments(req, res) {
  try {
    const docs = await employeesService.listDocuments(req.user.id, req.params.id);
    return res.json({ data: docs });
  } catch (err) {
    return handleError(res, err, "List documents");
  }
}

/**
 * POST /api/employees/:id/documents
 * Owner + HR: upload a document.
 * Expects raw binary body with Content-Type: image/* or application/pdf
 * Query params: ?doc_type=citizenship&label=Front+Side&original_name=file.pdf
 */
async function uploadDocument(req, res) {
  try {
    const mimeType = req.headers["content-type"]?.split(";")[0].trim();
    const fileBuffer = req.body;

    if (!fileBuffer || fileBuffer.length === 0 || !Buffer.isBuffer(fileBuffer)) {
      return res.status(400).json({ 
        error: "Invalid or missing file body", 
        details: "Ensure Content-Type is image/* or application/pdf and the body is not empty."
      });
    }

    const { doc_type, label, original_name } = req.query;
    if (!doc_type) return res.status(400).json({ error: "doc_type query param is required" });

    const doc = await employeesService.uploadDocument(req.user.id, req.params.id, {
      fileBuffer,
      mimeType,
      originalName: original_name ?? null,
      docType: doc_type,
      label: label ?? null,
    });

    return res.status(201).json({ data: doc });
  } catch (err) {
    return handleError(res, err, "Upload document");
  }
}

/**
 * GET /api/employees/:id/documents/:docId/signed-url
 * Owner + HR: get signed URL for private document access.
 */
async function getDocumentSignedUrl(req, res) {
  try {
    const signedUrlData = await employeesService.getDocumentSignedUrl(req.user.id, req.params.id, req.params.docId);
    return res.json({ signedUrl: signedUrlData.signedUrl });
  } catch (err) {
    return handleError(res, err, "Get document signed URL");
  }
}

/**
 * DELETE /api/employees/:id/documents/:docId
 * Owner only: delete a document.
 */
async function deleteDocument(req, res) {
  try {
    await employeesService.deleteDocument(req.user.id, req.params.id, req.params.docId);
    return res.status(204).send();
  } catch (err) {
    return handleError(res, err, "Delete document");
  }
}

module.exports = {
  list,
  create,
  getMe,
  get,
  update,
  deactivate,
  updateSalary,
  assignShift,
  assignWorkplace,
  invite,
  uploadPhoto,
  listDocuments,
  uploadDocument,
  getDocumentSignedUrl,
  deleteDocument,
};
