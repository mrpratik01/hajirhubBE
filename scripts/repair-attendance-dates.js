require("dotenv").config();

const { supabaseAdmin } = require("../src/config/supabase");
const { adToBs } = require("../src/utils/nepaliDate");

function shouldApply() {
  return process.argv.includes("--apply");
}

function pickEarliest(left, right) {
  if (!left) return right || null;
  if (!right) return left || null;
  return new Date(left) <= new Date(right) ? left : right;
}

function pickLatest(left, right) {
  if (!left) return right || null;
  if (!right) return left || null;
  return new Date(left) >= new Date(right) ? left : right;
}

function calculateWorkingMinutes(checkInTime, checkOutTime) {
  if (!checkInTime || !checkOutTime) return null;
  const minutes = Math.round((new Date(checkOutTime) - new Date(checkInTime)) / 60000);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : null;
}

async function fetchAttendanceRows() {
  const { data, error } = await supabaseAdmin
    .from("attendance")
    .select(
      `id, employee_id, date_ad, date_bs, check_in_time, check_out_time,
       working_minutes, status, updated_at, created_at`
    )
    .order("date_ad", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function updateDateBs(row, expectedDateBs) {
  const { error } = await supabaseAdmin
    .from("attendance")
    .update({ date_bs: expectedDateBs })
    .eq("id", row.id);

  if (error) throw error;
}

async function mergeAndDelete(source, target, expectedDateBs) {
  const checkInTime = pickEarliest(source.check_in_time, target.check_in_time);
  const checkOutTime = pickLatest(source.check_out_time, target.check_out_time);
  const workingMinutes = calculateWorkingMinutes(checkInTime, checkOutTime);

  const patch = {
    date_bs: expectedDateBs,
    check_in_time: checkInTime,
    check_out_time: checkOutTime,
  };

  if (workingMinutes !== null) patch.working_minutes = workingMinutes;
  if (target.status === "absent" && source.status && source.status !== "absent") {
    patch.status = source.status;
  }

  const { error: updateError } = await supabaseAdmin
    .from("attendance")
    .update(patch)
    .eq("id", target.id);

  if (updateError) throw updateError;

  const { error: deleteError } = await supabaseAdmin
    .from("attendance")
    .delete()
    .eq("id", source.id);

  if (deleteError) throw deleteError;
}

async function main() {
  const apply = shouldApply();
  const rows = await fetchAttendanceRows();
  const byEmployeeDateBs = new Map(rows.map((row) => [`${row.employee_id}:${row.date_bs}`, row]));
  const mismatches = rows.filter((row) => row.date_ad && row.date_bs !== adToBs(row.date_ad));

  let updated = 0;
  let merged = 0;

  for (const row of mismatches) {
    const expectedDateBs = adToBs(row.date_ad);
    const target = byEmployeeDateBs.get(`${row.employee_id}:${expectedDateBs}`);

    if (!apply) {
      console.log(
        `${target ? "MERGE" : "UPDATE"} ${row.id}: ${row.date_ad} ${row.date_bs} -> ${expectedDateBs}`
      );
      continue;
    }

    if (target && target.id !== row.id) {
      await mergeAndDelete(row, target, expectedDateBs);
      merged += 1;
    } else {
      await updateDateBs(row, expectedDateBs);
      updated += 1;
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    checked: rows.length,
    mismatches: mismatches.length,
    updated,
    merged,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
