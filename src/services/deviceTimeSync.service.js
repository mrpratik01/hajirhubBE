const ZKLib = require("node-zklib");
const { supabaseAdmin } = require("../config/supabase");

const ZK_TCP_PORT = 4370;
const ZK_TIMEOUT_MS = 10000;
const ZK_INPORT = 4000;
const NEPAL_OFFSET_MINUTES = 5 * 60 + 45;
const DEFAULT_SYNC_INTERVAL_MS = 30 * 1000;
const CMD_SET_TIME = 202;

let intervalHandle = null;
let isSyncRunning = false;

function getSyncIntervalMs() {
  const configured = Number(process.env.DEVICE_TIME_SYNC_INTERVAL_MS);
  if (Number.isFinite(configured) && configured >= 10000) {
    return configured;
  }

  return DEFAULT_SYNC_INTERVAL_MS;
}

function getNepalTimeParts(date = new Date()) {
  const nepalDate = new Date(date.getTime() + NEPAL_OFFSET_MINUTES * 60 * 1000);

  return {
    year: nepalDate.getUTCFullYear(),
    month: nepalDate.getUTCMonth() + 1,
    day: nepalDate.getUTCDate(),
    hour: nepalDate.getUTCHours(),
    minute: nepalDate.getUTCMinutes(),
    second: nepalDate.getUTCSeconds(),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTimeParts(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function encodeZkTime(parts) {
  const encoded =
    ((parts.year % 100) * 12 * 31 + (parts.month - 1) * 31 + parts.day - 1) *
      24 *
      60 *
      60 +
    (parts.hour * 60 + parts.minute) * 60 +
    parts.second;

  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(encoded, 0);
  return buffer;
}

async function fetchOnlineDevices() {
  const { data, error } = await supabaseAdmin
    .from("biometric_devices")
    .select("ip_address, serial_number, is_online")
    .eq("is_online", true);

  if (error) {
    throw error;
  }

  return (data || []).filter((device) => Boolean(device.ip_address));
}

async function syncDeviceTime(device) {
  const ipAddress = device.ip_address;
  const serialNumber = device.serial_number || "unknown";
  const timeParts = getNepalTimeParts();
  const timeSent = formatTimeParts(timeParts);
  const timePayload = encodeZkTime(timeParts);
  const zk = new ZKLib(ipAddress, ZK_TCP_PORT, ZK_TIMEOUT_MS, ZK_INPORT);

  try {
    await zk.createSocket();

    if (zk.connectionType !== "tcp") {
      throw new Error(`Expected TCP connection but got ${zk.connectionType || "none"}`);
    }

    await zk.executeCmd(CMD_SET_TIME, timePayload);
    console.log(
      `[DeviceTimeSync] Success syncing ${ipAddress} (${serialNumber}) with Nepal time ${timeSent}`
    );
  } catch (err) {
    console.error(
      `[DeviceTimeSync] Failed syncing ${ipAddress} (${serialNumber}) with Nepal time ${timeSent}:`,
      err.message || err
    );
  } finally {
    try {
      await zk.disconnect();
    } catch (_) {
      // Ignore disconnect failures; the sync result has already been logged.
    }
  }
}

async function syncOnlineDeviceTimes() {
  if (isSyncRunning) {
    console.warn("[DeviceTimeSync] Previous sync is still running; skipping this cycle.");
    return;
  }

  isSyncRunning = true;

  try {
    const devices = await fetchOnlineDevices();

    if (devices.length === 0) {
      console.log("[DeviceTimeSync] No online biometric devices found for time sync.");
      return;
    }

    for (const device of devices) {
      await syncDeviceTime(device);
    }
  } catch (err) {
    console.error("[DeviceTimeSync] Failed to run scheduled device time sync:", err.message || err);
  } finally {
    isSyncRunning = false;
  }
}

function startDeviceTimeSyncScheduler() {
  if (intervalHandle) {
    return intervalHandle;
  }

  const syncIntervalMs = getSyncIntervalMs();

  console.log(
    `[DeviceTimeSync] Starting scheduled Nepal time sync every ${Math.round(syncIntervalMs / 1000)} seconds.`
  );
  void syncOnlineDeviceTimes();

  intervalHandle = setInterval(() => {
    void syncOnlineDeviceTimes();
  }, syncIntervalMs);

  return intervalHandle;
}

function stopDeviceTimeSyncScheduler() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = {
  startDeviceTimeSyncScheduler,
  stopDeviceTimeSyncScheduler,
  syncOnlineDeviceTimes,
};
