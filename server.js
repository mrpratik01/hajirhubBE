require("dotenv").config();

const { createApp } = require("./src/app");
const { startDeviceTimeSyncScheduler } = require("./src/services/deviceTimeSync.service");

const REQUIRED_ENVS = [
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "CORS_ORIGIN",
];

function validateEnvironment() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);

  if (missing.length === 0) return;

  const message = `Missing required environment variables: ${missing.join(", ")}`;
  if (process.env.NODE_ENV === "production") {
    console.error(`[Startup] ${message}`);
    process.exit(1);
  }

  console.warn(`[Startup] ${message}`);
}

process.on("uncaughtException", (err) => {
  console.error("[Process] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Process] unhandledRejection:", reason);
});

validateEnvironment();

const app = createApp();
const PORT = process.env.PORT || 3001;

startDeviceTimeSyncScheduler();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`HAJIR HUB API listening on http://0.0.0.0:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[Server] Port ${PORT} is already in use.`);
  } else {
    console.error("[Server] Listener error:", err);
  }
  process.exit(1);
});
