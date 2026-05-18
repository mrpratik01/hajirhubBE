require("dotenv").config();

const { createApp } = require("./src/app");
const { startDeviceTimeSyncScheduler } = require("./src/services/deviceTimeSync.service");

const port = Number(process.env.PORT) || 3001; // Main API Port
const biometricPort = 8081; // Dedicated Biometric ADMS Port
const app = createApp();

startDeviceTimeSyncScheduler();

// Start main listener
const mainServer = app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 HAJIR HUB API listening on http://0.0.0.0:${port}`);
});

mainServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Main API Port ${port} is already in use.`);
  } else {
    console.error(`❌ Main API Server Error:`, err);
  }
  process.exit(1);
});

// Start dedicated biometric listener on port 8081
const biometricServer = app.listen(biometricPort, "0.0.0.0", () => {
  console.log(`📡 BIOMETRIC ADMS listening on http://0.0.0.0:${biometricPort}`);
});

biometricServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Biometric Port ${biometricPort} is already in use. Please close the other project running on this port.`);
  } else {
    console.error(`❌ Biometric ADMS Server Error:`, err);
  }
  // We don't exit(1) here to allow the main API to continue if only the biometric port fails
});
