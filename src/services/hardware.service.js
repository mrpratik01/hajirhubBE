const { supabaseAdmin } = require("../config/supabase");
const { adToBs } = require("../utils/nepaliDate");

const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000; // 5 hours 45 mins in ms
const DEFAULT_DEVICE_TIME_SYNC_INTERVAL_HOURS = 6;
const DELAYED_LOG_THRESHOLD_HOURS = 24;

/**
 * Helper to get current Nepal Time (UTC + 5:45)
 */
function getNepalTime(date = new Date()) {
  return new Date(date.getTime() + NEPAL_OFFSET_MS);
}

/**
 * Helper to convert Nepal Time string from device back to UTC Date object
 * input: "2026-05-17 18:03:57" (Nepal Time)
 * output: Date Object (UTC)
 */
function deviceTimeToUTC(timeStr) {
  // Regex to parse "YYYY-MM-DD HH:mm:ss"
  const match = String(timeStr || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
  );

  if (!match) {
    console.error(`[ADMS] Invalid timestamp format: ${timeStr}`);
    return null;
  }

  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    console.error(`[ADMS] Invalid timestamp value: ${timeStr}`);
    return null;
  }

  // Store the device-provided timestamp as a UTC ISO instant. Do not manually
  // add or subtract the Nepal offset before saving.
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function getDeviceTimeSyncIntervalMs() {
  const hours = Number(process.env.DEVICE_TIME_SYNC_INTERVAL_HOURS);
  const safeHours = Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_DEVICE_TIME_SYNC_INTERVAL_HOURS;
  return safeHours * 60 * 60 * 1000;
}

function isDeviceTimeSyncEnabled() {
  return String(process.env.ENABLE_DEVICE_TIME_SYNC || "false").toLowerCase() === "true";
}

function getBodyParams(body) {
  if (!body || Buffer.isBuffer(body) || typeof body !== "object") return {};
  return body;
}

function normalizeQuery(query = {}, body = {}) {
  const bodyParams = getBodyParams(body);
  return {
    SN: query.SN || query.sn || query.SerialNumber || query.serial_number || bodyParams.SN || bodyParams.sn,
    table: query.table || query.Table || query.TABLE || bodyParams.table || bodyParams.Table || bodyParams.TABLE,
    INFO: query.INFO || query.info || bodyParams.INFO || bodyParams.info,
  };
}

function normalizeRawBody(rawBody) {
  if (!rawBody) return "";
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8").replace(/\\t/g, "\t").replace(/\r\n/g, "\n").trim();
  if (typeof rawBody === "object") {
    const payload = rawBody.data || rawBody.payload || rawBody.raw || rawBody.ATTLOG || rawBody.attlog;
    if (payload) return normalizeRawBody(payload);

    const entries = Object.entries(rawBody);
    if (entries.length === 1 && entries[0][1] === "") return normalizeRawBody(entries[0][0]);
    return new URLSearchParams(rawBody).toString();
  }
  return String(rawBody).replace(/\\t/g, "\t").replace(/\r\n/g, "\n").trim();
}

/**
 * Handle ADMS getrequest (Command Polling)
 */
async function handleGetRequest(query, body) {
  const { SN, INFO } = normalizeQuery(query, body);
  console.log("[ADMS] GET /iclock/getrequest", { SN, query, body });

  if (!SN) {
    console.warn("[ADMS] getrequest missing SN");
    return "OK";
  }
  
  const now = new Date(); // Actual UTC now
  const nepalNow = getNepalTime(now); // Local Display Time for Machine
  
  const patch = {
    last_heartbeat_at: now.toISOString(),
    is_online: true 
  };

  if (INFO) {
    const parts = INFO.split(",");
    if (parts.length > 4) {
      const deviceIp = parts[4];
      if (deviceIp && deviceIp.includes(".")) {
        patch.ip_address = deviceIp;
      }
    }
  }

  // 1. Fetch current device status to check last sync
  const { data: device, error: fetchErr } = await supabaseAdmin
    .from("biometric_devices")
    .select("last_synced_at")
    .eq("serial_number", SN)
    .single();

  if (fetchErr) {
    console.error(`[ADMS Debug] Device lookup failed:`, fetchErr.message);
  }

  // 2. Update Heartbeat
  const { error: updErr } = await supabaseAdmin
    .from("biometric_devices")
    .update(patch)
    .eq("serial_number", SN);

  if (updErr) console.error(`[ADMS Debug] Heartbeat Update Error for ${SN}:`, updErr.message);

  if (!isDeviceTimeSyncEnabled()) {
    return "OK";
  }

  // 3. Logic to send commands
  // Only send SETTIME if never synced or synced after configured interval.
  const syncCutoff = new Date(now.getTime() - getDeviceTimeSyncIntervalMs());
  const lastSync = device?.last_synced_at ? new Date(device.last_synced_at) : null;

  if (!lastSync || lastSync < syncCutoff) {
    // We use UTC methods on the nepalNow object because it already has the +5:45 added
    const year = nepalNow.getUTCFullYear();
    const month = String(nepalNow.getUTCMonth() + 1).padStart(2, '0');
    const day = String(nepalNow.getUTCDate()).padStart(2, '0');
    const hours = String(nepalNow.getUTCHours()).padStart(2, '0');
    const mins = String(nepalNow.getUTCMinutes()).padStart(2, '0');
    const secs = String(nepalNow.getUTCSeconds()).padStart(2, '0');
    
    const serverTime = `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
    const setTimeCmd = `C:101:SETTIME ${serverTime}\n`;

    // Update last_synced_at to prevent immediate loop
    await supabaseAdmin
      .from("biometric_devices")
      .update({ last_synced_at: now.toISOString() })
      .eq("serial_number", SN);

    console.log(`[ADMS] Sending SETTIME to ${SN}: ${serverTime}`);
    return setTimeCmd;
  }

  // No pending commands
  return "OK";
}

/**
 * Handle ADMS devicecmd (Acknowledgment)
 * The device tells us if the command was successful.
 */
async function handleDeviceCmd(query, rawBody) {
  const { SN } = normalizeQuery(query, rawBody);
  console.log("[ADMS] POST /iclock/devicecmd", { SN, body: normalizeRawBody(rawBody) });
  
  return "OK";
}

async function handleGetCData(query, body) {
  const { SN, table } = normalizeQuery(query, body);
  console.log("[ADMS] GET /iclock/cdata", { SN, table, query, body });
  return "OK";
}

/**
 * Handle ADMS cdata (Data Push)
 */
async function handlePostData(query, rawBody) {
  const { SN, table } = normalizeQuery(query, rawBody);
  const bodyText = normalizeRawBody(rawBody);
  console.log("[ADMS] POST /iclock/cdata", { SN, table, bytes: Buffer.byteLength(bodyText) });
  
  if (!SN) {
    console.warn("[ADMS] cdata missing SN");
    return "OK";
  }

  if (String(table || "").toUpperCase() !== "ATTLOG") {
    return "OK";
  }

  console.log(`[ADMS] ATTLOG body from ${SN}:\n${bodyText}`);

  // 1. Resolve Device & Org
  const { data: device, error: devError } = await supabaseAdmin
    .from("biometric_devices")
    .select("id, org_id, workplace_id")
    .eq("serial_number", SN)
    .single();

  if (devError || !device) {
    console.error(`[ADMS Debug] Device lookup failed for SN: ${SN}`);
    return "OK";
  }

  const lines = bodyText.split("\n");

  for (const line of lines) {
    try {
      if (!line.trim()) continue;

      const parts = line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/);
      if (parts.length < 2) {
        console.warn(`[ADMS] Ignoring malformed ATTLOG line from ${SN}: ${line}`);
        continue;
      }

      const deviceUserId = parts[0].trim();
      const punchTimeStr = parts.length >= 3 && /^\d{2}:\d{2}:\d{2}$/.test(parts[2])
        ? `${parts[1].trim()} ${parts[2].trim()}`
        : parts[1].trim();
      const verifyModeRaw = parts.length >= 3 && /^\d{2}:\d{2}:\d{2}$/.test(parts[2])
        ? parts[3]?.trim()
        : parts[2]?.trim();

      const punchTimeUTC = deviceTimeToUTC(punchTimeStr);
      if (!punchTimeUTC) {
        console.warn(`[ADMS] Ignoring ATTLOG line with invalid time from ${SN}: ${line}`);
        continue;
      }

      const ageHours = (Date.now() - punchTimeUTC.getTime()) / (1000 * 60 * 60);
      if (ageHours > DELAYED_LOG_THRESHOLD_HOURS) {
        console.log(`[ADMS] Delayed biometric log accepted`, {
          SN,
          deviceUserId,
          punchTime: punchTimeUTC.toISOString(),
          ageHours: Math.round(ageHours),
        });
      }

      let verificationMode = "finger";
      if (verifyModeRaw === "1" || verifyModeRaw === "finger") verificationMode = "finger";
      if (verifyModeRaw === "15" || verifyModeRaw === "face") verificationMode = "face";
      if (verifyModeRaw === "4") verificationMode = "card";
      if (verifyModeRaw === "3") verificationMode = "pin";

      const duplicateRawLog = await findDuplicateRawLog(device.id, deviceUserId, punchTimeUTC);
      if (duplicateRawLog) {
        console.log("[ADMS] Duplicate biometric punch ignored", {
          SN,
          deviceUserId,
          punchTime: punchTimeUTC.toISOString(),
          rawLogId: duplicateRawLog.id,
        });
        continue;
      }

      // 2. Store Raw Log
      const { data: rawLog, error: logError } = await supabaseAdmin
        .from("biometric_raw_logs")
        .insert({
          org_id: device.org_id,
          device_id: device.id,
          device_user_id: deviceUserId,
          punch_time: punchTimeUTC.toISOString(), 
          verification_mode: verificationMode,
          processing_status: "pending",
          raw_payload: { raw_line: line.trim(), sn: SN }
        })
        .select("id")
        .single();

      if (logError) {
        console.error("[ADMS] DB error saving raw log:", logError.message);
        continue;
      }

      // 3. Process the Punch
      await processBiometricPunch(rawLog.id, device.org_id, deviceUserId, punchTimeUTC, device.workplace_id);
    } catch (err) {
      console.error("[ADMS] Punch line processing error:", err.message);
    }
  }

  return "OK";
}

async function findDuplicateRawLog(deviceId, deviceUserId, punchTimeUTC) {
  const { data, error } = await supabaseAdmin
    .from("biometric_raw_logs")
    .select("id")
    .eq("device_id", deviceId)
    .eq("device_user_id", deviceUserId)
    .eq("punch_time", punchTimeUTC.toISOString())
    .maybeSingle();

  if (error) {
    console.error("[ADMS] Duplicate raw log lookup failed:", error.message);
    return null;
  }

  return data;
}

/**
 * Maps the raw punch to an employee and creates/updates attendance.
 */
async function processBiometricPunch(rawLogId, orgId, deviceUserId, punchTimeUTC, workplaceId) {
  // 1. Find Employee by biometric_user_id
  const { data: employee, error: empError } = await supabaseAdmin
    .from("employees")
    .select("id, full_name, shift_id")
    .eq("org_id", orgId)
    .eq("biometric_user_id", deviceUserId)
    .single();

  if (empError || !employee) {
    await supabaseAdmin
      .from("biometric_raw_logs")
      .update({ processing_status: "unmatched", error_reason: "Employee not found for this device_user_id" })
      .eq("id", rawLogId);
    return;
  }

  const dateAd = punchTimeUTC.toISOString().split("T")[0];
  const dateBs = adToBs(dateAd);

  // 2. Attendance upsert logic. Delayed logs are accepted: the earliest punch
  // becomes check-in, and the latest punch becomes check-out.
  const { data: existing } = await supabaseAdmin
    .from("attendance")
    .select("id, check_in_time, check_out_time")
    .eq("employee_id", employee.id)
    .eq("date_bs", dateBs)
    .maybeSingle();

  let attendanceId;

  if (!existing) {
    const { data: newAtt, error: insError } = await supabaseAdmin
      .from("attendance")
      .insert({
        org_id: orgId,
        employee_id: employee.id,
        workplace_id: workplaceId,
        shift_id: employee.shift_id,
        date_bs: dateBs,
        date_ad: dateAd,
        check_in_time: punchTimeUTC.toISOString(),
        status: "present",
        geofence_status: "inside",
        is_offline_record: false
      })
      .select("id")
      .single();
    
    if (insError) throw insError;
    attendanceId = newAtt.id;
  } else {
    attendanceId = existing.id;
    const existingCheckIn = existing.check_in_time ? new Date(existing.check_in_time) : null;
    const existingCheckOut = existing.check_out_time ? new Date(existing.check_out_time) : null;
    const punchIso = punchTimeUTC.toISOString();

    if (
      (existingCheckIn && existingCheckIn.getTime() === punchTimeUTC.getTime()) ||
      (existingCheckOut && existingCheckOut.getTime() === punchTimeUTC.getTime())
    ) {
      console.log("[ADMS] Duplicate attendance punch ignored", {
        employeeId: employee.id,
        punchTime: punchIso,
      });
    } else {
      const patch = {};
      const nextCheckIn = !existingCheckIn || punchTimeUTC < existingCheckIn
        ? punchTimeUTC
        : existingCheckIn;
      const nextCheckOut = !existingCheckOut || punchTimeUTC > existingCheckOut
        ? punchTimeUTC
        : existingCheckOut;

      if (!existingCheckIn || nextCheckIn.getTime() !== existingCheckIn.getTime()) {
        patch.check_in_time = nextCheckIn.toISOString();
      }

      if (
        nextCheckOut &&
        nextCheckIn &&
        nextCheckOut.getTime() !== nextCheckIn.getTime() &&
        (!existingCheckOut || nextCheckOut.getTime() !== existingCheckOut.getTime())
      ) {
        patch.check_out_time = nextCheckOut.toISOString();
      }

      const workingMinutes = nextCheckIn && nextCheckOut && nextCheckOut > nextCheckIn
        ? Math.round((nextCheckOut - nextCheckIn) / (1000 * 60))
        : null;
      if (workingMinutes !== null) {
        patch.working_minutes = Math.max(0, workingMinutes);
      }

      if (Object.keys(patch).length > 0) {
        const { error: updError } = await supabaseAdmin
          .from("attendance")
          .update(patch)
          .eq("id", existing.id);

        if (updError) throw updError;
      }
    }
  }

  // 3. Mark raw log as processed
  await supabaseAdmin
    .from("biometric_raw_logs")
    .update({ 
      employee_id: employee.id,
      attendance_id: attendanceId,
      processing_status: "processed", 
      processed_at: new Date().toISOString() 
    })
    .eq("id", rawLogId);
}

/**
 * Resolve organization ID from user ID.
 */
async function resolveOrgId(userId) {
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!user?.org_id) throw new Error("Organization not found for this user");
  return user.org_id;
}

// ─── Device Management ────────────────────────────────────────────────────────

async function listDevices(userId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("biometric_devices")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}

async function registerDevice(userId, body) {
  const orgId = await resolveOrgId(userId);
  const { serial_number, device_name, workplace_id, device_model, device_type = "zkteco", sync_mode = "push", ip_address } = body;

  const { data, error } = await supabaseAdmin
    .from("biometric_devices")
    .insert({
      org_id: orgId,
      workplace_id,
      serial_number,
      label: device_name,
      device_model,
      device_type,
      sync_mode,
      ip_address,
      is_active: true
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("A device with this Serial Number is already registered.");
    throw error;
  }
  return data;
}

async function updateDevice(userId, deviceId, body) {
  const orgId = await resolveOrgId(userId);
  const { device_name, workplace_id, device_model, is_active, sync_mode, ip_address } = body;

  const patch = {};
  if (device_name !== undefined) patch.label = device_name;
  if (workplace_id !== undefined) patch.workplace_id = workplace_id;
  if (device_model !== undefined) patch.device_model = device_model;
  if (is_active !== undefined) patch.is_active = is_active;
  if (sync_mode !== undefined) patch.sync_mode = sync_mode;
  if (ip_address !== undefined) patch.ip_address = ip_address;

  const { data, error } = await supabaseAdmin
    .from("biometric_devices")
    .update(patch)
    .eq("id", deviceId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new Error("Device not found or access denied.");
  return data;
}

async function deleteDevice(userId, deviceId) {
  const orgId = await resolveOrgId(userId);
  const { data, error } = await supabaseAdmin
    .from("biometric_devices")
    .delete()
    .eq("id", deviceId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ─── Employee Biometric Mapping ───────────────────────────────────────────────

/**
 * Generates the next numeric biometric_user_id for an organization
 * and assigns it to an employee.
 */
async function assignBiometricId(userId, employeeId, requestedId = null) {
  const orgId = await resolveOrgId(userId);

  let finalId = requestedId;

  if (!finalId) {
    const { data: employees, error: fetchError } = await supabaseAdmin
      .from("employees")
      .select("biometric_user_id")
      .eq("org_id", orgId)
      .not("biometric_user_id", "is", null);

    if (fetchError) throw fetchError;

    const numericIds = employees
      .map(e => parseInt(e.biometric_user_id))
      .filter(id => !isNaN(id));
    
    const maxId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    finalId = (maxId + 1).toString();
  }

  const { data: existing } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("org_id", orgId)
    .eq("biometric_user_id", finalId)
    .not("id", "eq", employeeId)
    .maybeSingle();

  if (existing) throw new Error(`Biometric User ID ${finalId} is already assigned to another employee.`);

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({ biometric_user_id: finalId })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("id, full_name, biometric_user_id")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  handleGetRequest,
  handleGetCData,
  handlePostData,
  handleDeviceCmd,
  listDevices,
  registerDevice,
  updateDevice,
  deleteDevice,
  assignBiometricId
};
