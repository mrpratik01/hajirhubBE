const NepaliDateModule = require("nepali-date-converter");

const NepaliDate = NepaliDateModule.default || NepaliDateModule;

function assertDateString(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error(`${label} must be in YYYY-MM-DD format`);
  }
}

function formatAdDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatBsDate(bsDate) {
  return [
    bsDate.getYear(),
    String(bsDate.getMonth() + 1).padStart(2, "0"),
    String(bsDate.getDate()).padStart(2, "0"),
  ].join("-");
}

function adToBs(adDateStr) {
  assertDateString(adDateStr, "AD date");
  const [year, month, day] = adDateStr.split("-").map(Number);
  return formatBsDate(new NepaliDate(new Date(year, month - 1, day)));
}

function bsToAd(bsDateStr) {
  assertDateString(bsDateStr, "BS date");
  const [year, month, day] = bsDateStr.split("-").map(Number);
  const adDate = new NepaliDate(year, month - 1, day).toJsDate();
  return formatAdDate(adDate);
}

function getBsYear(adDateStr) {
  return Number(adToBs(adDateStr).split("-")[0]);
}

function todayBs() {
  const now = new Date();
  const adStr = formatAdDate(now);
  return adToBs(adStr);
}

function getDaysInBsMonth(year, month) {
  const start = new NepaliDate(year, month - 1, 1).toJsDate();
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 0 : month;
  const next = new NepaliDate(nextYear, nextMonth, 1).toJsDate();
  return Math.round((next.getTime() - start.getTime()) / 86400000);
}

module.exports = { adToBs, bsToAd, getBsYear, todayBs, getDaysInBsMonth };
