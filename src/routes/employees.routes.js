const express = require("express");
const { requireSupabaseUser } = require("../middleware/auth");
const { requireStaffRole } = require("../middleware/requireStaffRole");
const { requireOwnerRole } = require("../middleware/requireOwnerRole");
const employeesController = require("../controllers/employees.controller");

const router = express.Router();

router.use(requireSupabaseUser);

// ─── Employee CRUD ────────────────────────────────────────────────────────────

// GET  /api/employees          — owner + hr_manager (paginated, filterable)
router.get("/", requireStaffRole, employeesController.list);

// GET  /api/employees/me       — any authenticated user (employee self-service)
// NOTE: must be defined before /:id to avoid "me" being treated as a UUID
router.get("/me", employeesController.getMe);

// POST /api/employees          — owner only
router.post("/", requireOwnerRole, employeesController.create);

// GET  /api/employees/:id      — owner + hr_manager
router.get("/:id", requireStaffRole, employeesController.get);

// PUT  /api/employees/:id      — owner only
router.put("/:id", requireOwnerRole, employeesController.update);

// PUT  /api/employees/:id/deactivate  — owner only
router.put("/:id/deactivate", requireOwnerRole, employeesController.deactivate);

// ─── Salary ───────────────────────────────────────────────────────────────────

// PUT  /api/employees/:id/salary  — owner only
router.put("/:id/salary", requireOwnerRole, employeesController.updateSalary);

// ─── Assignments ──────────────────────────────────────────────────────────────

// PUT  /api/employees/:id/shift      — owner only
router.put("/:id/shift", requireOwnerRole, employeesController.assignShift);

// PUT  /api/employees/:id/workplace  — owner only
router.put("/:id/workplace", requireOwnerRole, employeesController.assignWorkplace);

// ─── App Invite ───────────────────────────────────────────────────────────────

// POST /api/employees/:id/invite  — owner only
router.post("/:id/invite", requireOwnerRole, employeesController.invite);

// POST /api/employees/:id/provision-auth  — owner only
router.post("/:id/provision-auth", requireOwnerRole, employeesController.provisionAuth);

// GET  /api/employees/:id/credentials  — owner + hr_manager
router.get("/:id/credentials", requireStaffRole, employeesController.getCredentials);

// ─── Photo ────────────────────────────────────────────────────────────────────

// PUT  /api/employees/:id/photo  — owner only
router.put("/:id/photo", requireOwnerRole, express.raw({ type: ["image/*"], limit: "5mb" }), employeesController.uploadPhoto);

// ─── Documents ────────────────────────────────────────────────────────────────

// GET  /api/employees/:id/documents          — owner + hr_manager
router.get("/:id/documents", requireStaffRole, employeesController.listDocuments);

// POST /api/employees/:id/documents          — owner + hr_manager
// Raw binary upload: Content-Type: image/* or application/pdf
router.post(
  "/:id/documents",
  requireStaffRole,
  express.raw({ type: ["image/*", "application/pdf"], limit: "10mb" }),
  employeesController.uploadDocument
);

// GET  /api/employees/:id/documents/:docId/signed-url  — owner + hr_manager
router.get("/:id/documents/:docId/signed-url", requireStaffRole, employeesController.getDocumentSignedUrl);

// DELETE /api/employees/:id/documents/:docId — owner only
router.delete("/:id/documents/:docId", requireOwnerRole, employeesController.deleteDocument);

module.exports = router;
