const express = require("express");
const usersRoutes = require("./routes/users.routes");

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

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/users", usersRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

module.exports = { createApp };
