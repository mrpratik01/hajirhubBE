const { supabaseAdmin } = require("../config/supabase");
const { adToBs } = require("../utils/nepaliDate");

/**
 * Handle ADMS getrequest (Command Polling)
 */
async function handleGetRequest(query) {
  const { SN, INFO } = query;
  console.log(`[ADMS Debug] GET Request from SN: ${SN}`);
  
  const now = new Date();
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
    // Don't send sync command if device not found
  }

  // 2. Update Heartbeat
  const { error: updErr } = await supabaseAdmin
    .from("biometric_devices")
    .update(patch)
    .eq("serial_number", SN);

  if (updErr) console.error(`[ADMS Debug] Heartbeat Update Error for ${SN}:`, updErr.message);

  // 3. Logic to send commands
  // Only send SETTIME if never synced or synced > 1 hour ago
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const lastSync = device?.last_synced_at ? new Date(device.last_synced_at) : null;

  if (!lastSync || lastSync < oneHourAgo) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    
    const serverTime = `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
    const setTimeCmd = `C:101:SETTIME ${serverTime}\n`;

    // Update last_synced_at to prevent immediate loop
    await supabaseAdmin
      .from("biometric_devices")
      .update({ last_synced_at: now.toISOString() })
      .eq("serial_number", SN);

    console.log(`[ADMS Debug] Syncing Time. Sending Command: ${setTimeCmd.trim()}`);
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
  const { SN } = query;
  console.log(`[ADMS Debug] Command ACK from SN: ${SN}`);
  console.log(`[ADMS Debug] ACK Body:\n${rawBody}`);
  
  return "OK";
}

/**
 * Handle ADMS cdata (Data Push)
 */
async function handlePostData(query, rawBody) {
  const { SN, table } = query;
  console.log(`[ADMS Debug] POST Request - SN: ${SN}, Table: ${table}`);
  
  if (table !== "ATTLOG") {
    console.log(`[ADMS Debug] Skipping non-ATTLOG table: ${table}`);
    return "OK";
  }

  console.log(`[ADMS Debug] Raw Body Received:\n${rawBody}`);

  // 1. Resolve Device & Org
  const { data: device, error: devError } = await supabaseAdmin
    .from("biometric_devices")
    .select("id, org_id, workplace_id")
    .eq("serial_number", SN)
    .single();

  if (devError || !device) {
    console.error(`[ADMS Debug] Device lookup failed for SN: ${SN}. Error: ${devError?.message || "Not Found"}`);
    return "OK";
  }

  const lines = rawBody.trim().split("\n");
  console.log(`[ADMS Debug] Processing ${lines.length} log lines...`);

  for (const line of lines) {
    if (!line.trim()) continue;
    
    console.log(`[ADMS Debug] Parsing line: ${line}`);
    const parts = line.split("\t");
    if (parts.length < 2) {
      console.warn(`[ADMS Debug] Line has insufficient parts: ${parts.length}`);
      continue;
    }

    const deviceUserId = parts[0].trim();
    const punchTimeStr = parts[1].trim();
    const verifyModeRaw = parts[2]?.trim();
    
    console.log(`[ADMS Debug] Mapped data - User: ${deviceUserId}, Time: ${punchTimeStr}, Mode: ${verifyModeRaw}`);

    let verificationMode = "finger";
    if (verifyModeRaw === "1" || verifyModeRaw === "finger") verificationMode = "finger";
    if (verifyModeRaw === "15" || verifyModeRaw === "face") verificationMode = "face";
    if (verifyModeRaw === "4") verificationMode = "card";
    if (verifyModeRaw === "3") verificationMode = "pin";

    // 2. Store Raw Log
    const { data: rawLog, error: logError } = await supabaseAdmin
      .from("biometric_raw_logs")
      .insert({
        org_id: device.org_id,
        device_id: device.id,
        device_user_id: deviceUserId,
        punch_time: new Date(punchTimeStr).toISOString(),
        verification_mode: verificationMode,
        processing_status: "pending",
        raw_payload: { raw_line: line.trim(), sn: SN }
      })
      .select("id")
      .single();

    if (logError) {
      console.error("[ADMS Debug] DB Error saving raw log:", logError.message);
      continue;
    }

    // 3. Process the Punch
    try {
      console.log(`[ADMS Debug] Starting attendance processing for Raw Log ID: ${rawLog.id}`);
      await processBiometricPunch(rawLog.id, device.org_id, deviceUserId, punchTimeStr, device.workplace_id);
      console.log(`[ADMS Debug] Successfully processed punch for User: ${deviceUserId}`);
    } catch (err) {
      console.error(`[ADMS Debug] Punch Processing Error:`, err.message);
      await supabaseAdmin
        .from("biometric_raw_logs")
        .update({ processing_status: "error", error_reason: err.message })
        .eq("id", rawLog.id);
    }
  }

  return "OK";
}

/**
 * Maps the raw punch to an employee and creates/updates attendance.
 */
async function processBiometricPunch(rawLogId, orgId, deviceUserId, timestampStr, workplaceId) {
  console.log(`[ADMS Debug] Looking up employee with biometric_user_id: ${deviceUserId} in Org: ${orgId}`);
  
  // 1. Find Employee by biometric_user_id
  const { data: employee, error: empError } = await supabaseAdmin
    .from("employees")
    .select("id, full_name, shift_id")
    .eq("org_id", orgId)
    .eq("biometric_user_id", deviceUserId)
    .single();

  if (empError || !employee) {
    console.error(`[ADMS Debug] Employee NOT FOUND for ID: ${deviceUserId}`);
    await supabaseAdmin
      .from("biometric_raw_logs")
      .update({ processing_status: "unmatched", error_reason: "Employee not found for this device_user_id" })
      .eq("id", rawLogId);
    return;
  }

  console.log(`[ADMS Debug] Found Employee: ${employee.full_name} (${employee.id})`);

  const punchTime = new Date(timestampStr);
  const dateAd = timestampStr.split(" ")[0];
  const dateBs = adToBs(dateAd);

  // 2. Attendance Upsert Logic (Check-in / Check-out)
  const { data: existing } = await supabaseAdmin
    .from("attendance")
    .select("id, check_in_time, check_out_time")
    .eq("employee_id", employee.id)
    .eq("date_bs", dateBs)
    .maybeSingle();

  let attendanceId;

  if (!existing) {
    console.log(`[ADMS Debug] No existing record for ${dateBs}. Creating Check-in.`);
    const { data: newAtt, error: insError } = await supabaseAdmin
      .from("attendance")
      .insert({
        org_id: orgId,
        employee_id: employee.id,
        workplace_id: workplaceId,
        shift_id: employee.shift_id,
        date_bs: dateBs,
        date_ad: dateAd,
        check_in_time: punchTime.toISOString(),
        status: "present",
        geofence_status: "inside",
        is_offline_record: false
      })
      .select("id")
      .single();
    
    if (insError) throw insError;
    attendanceId = newAtt.id;
  } else {
    console.log(`[ADMS Debug] Existing record found. Updating Check-out.`);
    attendanceId = existing.id;
    const checkInTime = new Date(existing.check_in_time);
    const workingMinutes = Math.round((punchTime - checkInTime) / (1000 * 60));

    const { error: updError } = await supabaseAdmin
      .from("attendance")
      .update({
        check_out_time: punchTime.toISOString(),
        working_minutes: Math.max(0, workingMinutes)
      })
      .eq("id", existing.id);
    
    if (updError) throw updError;
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
    // Find the current maximum biometric_user_id in this organization
    const { data: employees, error: fetchError } = await supabaseAdmin
      .from("employees")
      .select("biometric_user_id")
      .eq("org_id", orgId)
      .not("biometric_user_id", "is", null);

    if (fetchError) throw fetchError;

    // Filter for numeric IDs and find the max
    const numericIds = employees
      .map(e => parseInt(e.biometric_user_id))
      .filter(id => !isNaN(id));
    
    const maxId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    finalId = (maxId + 1).toString();
  }

  // Check if ID is already taken in this org
  const { data: existing } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("org_id", orgId)
    .eq("biometric_user_id", finalId)
    .not("id", "eq", employeeId)
    .maybeSingle();

  if (existing) throw new Error(`Biometric User ID ${finalId} is already assigned to another employee.`);

  // Update employee
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
  handlePostData,
  handleDeviceCmd,
  listDevices,
  registerDevice,
  updateDevice,
  deleteDevice,
  assignBiometricId
};
