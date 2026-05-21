const { supabaseAdmin } = require("../config/supabase");
const {
  adToBs,
  bsToAd,
  getDaysInBsMonth,
} = require("../utils/nepaliDate");

const DAY_BITS = [1, 2, 4, 8, 16, 32, 64]; // Sun..Sat
const DEFAULT_WORKING_DAYS = 62; // Mon-Fri, used only when no shift/default shift exists.

function compareYmd(left, right) {
  return left.localeCompare(right);
}

function addAdDays(dateAd, days) {
  const [year, month, day] = dateAd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function nextBsDate(dateBs) {
  const [year, month, day] = dateBs.split("-").map(Number);
  const daysInMonth = getDaysInBsMonth(year, month);
  if (day < daysInMonth) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`;
  }
  if (month < 12) return `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return `${year + 1}-01-01`;
}

function enumerateBsRange(startDateBs, endDateBs, maxDays = 370) {
  const dates = [];
  let cursor = startDateBs;
  while (compareYmd(cursor, endDateBs) <= 0) {
    dates.push({ date_bs: cursor, date_ad: bsToAd(cursor) });
    cursor = nextBsDate(cursor);
    if (dates.length > maxDays) throw new Error("Date range cannot exceed 370 days");
  }
  return dates;
}

function enumerateAdRange(startDateAd, endDateAd, maxDays = 370) {
  const dates = [];
  let cursor = startDateAd;
  while (compareYmd(cursor, endDateAd) <= 0) {
    dates.push({ date_ad: cursor, date_bs: adToBs(cursor) });
    cursor = addAdDays(cursor, 1);
    if (dates.length > maxDays) throw new Error("Date range cannot exceed 370 days");
  }
  return dates;
}

function getWeekdayBit(dateAd) {
  const [year, month, day] = dateAd.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return DAY_BITS[weekday];
}

function isShiftWorkingDay(workingDays, dateAd) {
  const mask = Number.isFinite(Number(workingDays)) ? Number(workingDays) : DEFAULT_WORKING_DAYS;
  return (mask & getWeekdayBit(dateAd)) !== 0;
}

function indexAttendance(records = []) {
  const map = new Map();
  for (const record of records) {
    map.set(`${record.employee_id}_${record.date_bs}`, record);
  }
  return map;
}

function indexLeaves(leaves = []) {
  const map = new Map();
  for (const leave of leaves) {
    if (!map.has(leave.employee_id)) map.set(leave.employee_id, []);
    map.get(leave.employee_id).push(leave);
  }
  return map;
}

function indexHolidays(holidays = []) {
  const map = new Map();
  for (const holiday of holidays) {
    if (!map.has(holiday.date_bs)) map.set(holiday.date_bs, holiday);
  }
  return map;
}

async function getDefaultShift(orgId) {
  const { data, error } = await supabaseAdmin
    .from("shifts")
    .select("id, name, start_time, end_time, working_days")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function fetchPublicHolidays(orgId, startDateBs, endDateBs) {
  const { data, error } = await supabaseAdmin
    .from("public_holidays")
    .select("id, org_id, date_bs, date_ad, name, name_nepali, is_national")
    .gte("date_bs", startDateBs)
    .lte("date_bs", endDateBs)
    .or(`org_id.is.null,org_id.eq.${orgId}`);

  if (error) throw error;
  return data || [];
}

async function fetchLeaveRequests(orgId, employeeIds, startDateAd, endDateAd) {
  if (!employeeIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, from_date_ad, to_date_ad, leave_type:leave_type_id(name)")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .lte("from_date_ad", endDateAd)
    .gte("to_date_ad", startDateAd)
    .in("employee_id", employeeIds);

  if (error) throw error;
  return data || [];
}

async function fetchAttendanceRecords(orgId, employeeIds, startDateBs, endDateBs) {
  if (!employeeIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from("attendance")
    .select(
      `id, employee_id, date_bs, date_ad, check_in_time, check_out_time,
       working_minutes, status, geofence_status, is_offline_record,
       is_manual_correction`
    )
    .eq("org_id", orgId)
    .gte("date_bs", startDateBs)
    .lte("date_bs", endDateBs)
    .in("employee_id", employeeIds)
    .order("date_bs", { ascending: true })
    .order("employee_id", { ascending: true });

  if (error) throw error;
  return data || [];
}

function getActiveLeave(leaves, dateAd) {
  return leaves.find((leave) =>
    compareYmd(leave.from_date_ad, dateAd) <= 0 &&
    compareYmd(leave.to_date_ad, dateAd) >= 0
  );
}

function resolveEmployeeShift(employee, defaultShift) {
  return (employee.shift && typeof employee.shift === "object")
    ? employee.shift
    : defaultShift || null;
}

function classifyCalendarDay({
  employee,
  defaultShift,
  date,
  dateAd,
  attendance,
  holiday,
  leaves,
  todayAd,
}) {
  const shift = resolveEmployeeShift(employee, defaultShift);

  if (!shift) {
    return {
      status: "no_record",
      is_working_day: false,
      is_paid_day: false,
      reason: "No shift assigned",
      shift,
    };
  }

  if (holiday) {
    return {
      status: "holiday",
      is_working_day: false,
      is_paid_day: true,
      reason: holiday.name,
      holiday,
      shift,
    };
  }

  if (!isShiftWorkingDay(shift.working_days, dateAd)) {
    return {
      status: "weekend",
      is_working_day: false,
      is_paid_day: true,
      reason: "Weekly off",
      shift,
    };
  }

  const activeLeave = getActiveLeave(leaves, dateAd);
  if (activeLeave) {
    return {
      status: "leave",
      is_working_day: true,
      is_paid_day: true,
      reason: activeLeave.leave_type?.name || "On approved leave",
      leave: activeLeave,
      shift,
    };
  }

  if (attendance) {
    return {
      status: attendance.status || "no_record",
      is_working_day: true,
      is_paid_day: attendance.status !== "absent",
      attendance,
      shift,
    };
  }

  if (todayAd && compareYmd(dateAd, todayAd) > 0) {
    return {
      status: "no_record",
      is_working_day: true,
      is_paid_day: false,
      reason: "Upcoming date",
      shift,
    };
  }

  return {
    status: "absent",
    is_working_day: true,
    is_paid_day: false,
    reason: "No check-in record",
    shift,
  };
}

function summarizeCalendarDays(calendarDays) {
  const stats = {
    calendar_days: calendarDays.length,
    working_days: 0,
    present: 0,
    late: 0,
    half_day: 0,
    absent: 0,
    leave: 0,
    holiday: 0,
    weekend: 0,
    manual: 0,
    no_record: 0,
    paid_days: 0,
    unpaid_days: 0,
  };

  for (const day of calendarDays) {
    if (day.is_working_day) stats.working_days++;
    if (stats[day.status] !== undefined) stats[day.status]++;

    if (day.status === "half_day") {
      stats.paid_days += 0.5;
      stats.unpaid_days += 0.5;
    } else if (day.status === "present" || day.status === "late" || day.status === "leave" || day.status === "manual") {
      stats.paid_days += 1;
    } else if (day.status === "absent") {
      stats.unpaid_days += 1;
    }
  }

  return stats;
}

async function buildEmployeeCalendar({
  orgId,
  employees,
  allDates,
  startDateBs,
  endDateBs,
  startDateAd,
  endDateAd,
  todayAd,
  attendanceRecords,
  leaveRequests,
  holidays,
}) {
  const employeeIds = employees.map((employee) => employee.id);
  const defaultShift = await getDefaultShift(orgId);
  const attendance = attendanceRecords || await fetchAttendanceRecords(orgId, employeeIds, startDateBs, endDateBs);
  const leaves = leaveRequests || await fetchLeaveRequests(orgId, employeeIds, startDateAd, endDateAd);
  const holidayRows = holidays || await fetchPublicHolidays(orgId, startDateBs, endDateBs);

  const attendanceMap = indexAttendance(attendance);
  const leaveMap = indexLeaves(leaves);
  const holidayMap = indexHolidays(holidayRows);
  const byEmployee = new Map();

  for (const employee of employees) {
    const days = allDates.map(({ date_bs: date, date_ad: dateAd }) => {
      const key = `${employee.id}_${date}`;
      const classified = classifyCalendarDay({
        employee,
        defaultShift,
        date,
        dateAd,
        attendance: attendanceMap.get(key),
        holiday: holidayMap.get(date),
        leaves: leaveMap.get(employee.id) || [],
        todayAd,
      });

      return {
        date_bs: date,
        date_ad: dateAd,
        ...classified,
      };
    });

    byEmployee.set(employee.id, {
      employee,
      days,
      stats: summarizeCalendarDays(days),
    });
  }

  return {
    byEmployee,
    defaultShift,
    attendanceRecords: attendance,
    leaveRequests: leaves,
    holidays: holidayRows,
  };
}

module.exports = {
  DEFAULT_WORKING_DAYS,
  compareYmd,
  addAdDays,
  enumerateBsRange,
  enumerateAdRange,
  isShiftWorkingDay,
  fetchPublicHolidays,
  fetchLeaveRequests,
  fetchAttendanceRecords,
  buildEmployeeCalendar,
  summarizeCalendarDays,
};
