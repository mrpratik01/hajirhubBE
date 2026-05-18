const express = require("express");
const cors = require("cors");
const usersRoutes = require("./routes/users.routes");
const adminPlansRoutes = require("./routes/admin.plans.routes");
const organizationsRoutes = require("./routes/organizations.routes");
const adminOrganizationsRoutes = require("./routes/admin.organizations.routes");
const adminSubscriptionsRoutes = require("./routes/admin.subscriptions.routes");
const departmentsRoutes = require("./routes/departments.routes");
const shiftsRoutes = require("./routes/shifts.routes");
const workplacesRoutes = require("./routes/workplaces.routes");
const employeesRoutes = require("./routes/employees.routes");
const attendanceRoutes = require("./routes/attendance.routes");
const authRoutes = require("./routes/auth.routes");
const leavesRoutes = require("./routes/leaves.routes");
const payrollRoutes = require("./routes/payroll.routes");
const reportsRoutes = require("./routes/reports.routes");
const hardwareRoutes = require("./routes/hardware.routes");
const iclockRoutes = require("./routes/iclock.routes");
const userManagementRoutes = require("./routes/userManagement.routes");

function parseCorsOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createCorsOptions() {
  const configuredOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
  const allowAllInDevelopment = configuredOrigins.length === 0 && process.env.NODE_ENV !== "production";

  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowAllInDevelopment) return callback(null, true);
      if (configuredOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  };
}

function isDeviceTextBody(req) {
  const contentType = req.headers["content-type"];
  if (!contentType) return true;
  return contentType.startsWith("text/plain") || contentType.startsWith("application/octet-stream");
}

function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(cors(createCorsOptions()));
  app.options(/.*/, cors(createCorsOptions()));

  // Special raw text parser for ADMS Biometric devices
  app.use("/iclock", express.text({ type: isDeviceTextBody, limit: "10mb" }));

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(express.text({ type: ["text/plain", "application/octet-stream"], limit: "10mb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "OK", time: new Date().toISOString() });
  });

  app.use("/iclock", iclockRoutes);

  app.use("/api/users/management", userManagementRoutes);
  app.use("/api/users", usersRoutes);
  app.use("/api/admin/plans", adminPlansRoutes);
  app.use("/api/organizations", organizationsRoutes);
  app.use("/api/admin/organizations", adminOrganizationsRoutes);
  app.use("/api/admin/subscriptions", adminSubscriptionsRoutes);
  app.use("/api/departments", departmentsRoutes);
  app.use("/api/shifts", shiftsRoutes);
  app.use("/api/workplaces", workplacesRoutes);
  app.use("/api/employees", employeesRoutes);
  app.use("/api/attendance", attendanceRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/leaves", leavesRoutes);
  app.use("/api/payroll", payrollRoutes);
  app.use("/api/reports", reportsRoutes);
  app.use("/api/hardware", hardwareRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, req, res, next) => {
    console.error("[GlobalError]", {
      method: req.method,
      path: req.originalUrl,
      message: err.message,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
    });

    if (req.path.startsWith("/iclock")) {
      return res.status(200).send("OK");
    }

    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;
    return res.status(status).json({
      error: status >= 500 ? "Internal server error" : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
