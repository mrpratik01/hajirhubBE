const express = require("express");
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
const userManagementRoutes = require("./routes/userManagement.routes");

function createApp() {
  const app = express();

  app.disable("x-powered-by");

  const corsOrigin = process.env.CORS_ORIGIN || "*";
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    return next();
  });

  // Special raw text parser for ADMS Biometric devices
  // We use */* to ensure we catch the body regardless of what Content-Type the device sends
  app.use("/iclock", express.text({ type: "*/*", limit: "1mb" }));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(express.text({ type: "text/plain", limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

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
  app.use("/iclock", hardwareRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

module.exports = { createApp };
