const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Asia/Kolkata';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function now() {
  return dayjs().tz(TZ);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for date parsing
// ─────────────────────────────────────────────────────────────────────────────

/** "oct", "october", "sept" -> 9. Anything that isn't a real month name -> -1. */
function monthIndex(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 3) return -1;
  if (w === 'sept') return 8;
  return MONTHS_FULL.findIndex((m) => m.startsWith(w));
}

/** Builds a valid date in India time, or null (e.g. 31 November, 30 February). */
function makeDate(year, monthIdx, day) {
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const d = dayjs.tz(`${year}-${mm}-${dd}`, TZ);
  if (!d.isValid() || d.month() !== monthIdx || d.date() !== day) return null;
  return d.startOf('day');
}

/** Next occurrence of (month, day) that is today or later. */
function upcoming(monthIdx, day, today) {
  for (let y = today.year(); y <= today.year() + 4; y += 1) {
    const c = makeDate(y, monthIdx, day);
    if (c && !c.isBefore(today)) return c;
  }
  return null;
}

/** Next occurrence of a bare day-of-month ("27") that is today or later. */
function upcomingDayOfMonth(day, today) {
  for (let k = 0; k < 13; k += 1) {
    const base = today.add(k, 'month');
    const c = makeDate(base.year(), base.month(), day);
    if (c && !c.isBefore(today)) return c;
  }
  return null;
}

/**
 * Cleans customer wording so the parsers below only see simple shapes:
 * "25th of October" -> "25 october", "Sun, 4 Oct" -> "4 oct", "on 1st Nov" -> "1 nov".
 */
function normalizeDateText(raw) {
  let p = String(raw).trim().toLowerCase();
  p = p.replace(/,/g, ' ');
  p = p.replace(/(\d+)\s*(?:st|nd|rd|th)\b/g, '$1'); // 25th -> 25
  p = p.replace(/\b(\d{1,2})\s+of\s+/g, '$1 ');       // 25 of october -> 25 october
  p = p.replace(/^(on|for)\s+/, '');
  if (/\d/.test(p)) {
    // Leading weekday before a date: "sun 4 oct" -> "4 oct"
    p = p.replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\s+/, '');
  }
  return p.replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a natural-language date phrase to a concrete date, always
 * anchored to the CURRENT India date/time — never guessed from AI
 * training data, which could be stale. Returns null (never a guess)
 * if the phrase can't be confidently resolved, so the caller can ask
 * the customer to clarify instead of booking the wrong day.
 *
 * Understands: today, tomorrow, day after tomorrow, weekdays, "25 October",
 * "25th October", "October 25th", "25th of Oct", "25/10", "25-10-2026",
 * "2026-10-25" (calendar list replies), bare day numbers ("27"), and list
 * titles such as "Sun, 4 Oct".
 */
function resolveDatePhrase(phrase) {
  if (!phrase) return null;
  const p0 = String(phrase).trim().toLowerCase();
  if (!p0) return null;
  const today = now().startOf('day');

  if (/^(today|tonight)$|आज|ಇಂದು/.test(p0)) return today;
  if (/^(tomorrow|tmrw|tmr)$|कल|ನಾಳೆ|நாளை|రేపు/.test(p0)) return today.add(1, 'day');
  if (/day after tomorrow|परसों/.test(p0)) return today.add(2, 'day');

  const nextWeekdayMatch = p0.match(/next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (nextWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(nextWeekdayMatch[1]);
    let diff = targetDow - today.day();
    if (diff <= 0) diff += 7;
    return today.add(diff, 'day');
  }

  const thisWeekdayMatch = p0.match(/^(this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (thisWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(thisWeekdayMatch[2]);
    let diff = targetDow - today.day();
    if (diff < 0) diff += 7;
    return today.add(diff, 'day');
  }

  const p = normalizeDateText(phrase);
  let m;

  // "2026-10-25" (value sent back when the customer taps a date in the calendar list)
  if ((m = p.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return makeDate(+m[1], +m[2] - 1, +m[3]);
  }

  // "25/10", "25-10", "25.10", "25/10/2026", "25-10-26"  (day first)
  if ((m = p.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/))) {
    const day = +m[1];
    const mon = +m[2] - 1;
    if (m[3]) {
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return makeDate(year, mon, day);
    }
    return upcoming(mon, day, today);
  }

  // "25 october", "25october", "25 oct 2026"
  if ((m = p.match(/^(\d{1,2})\s*([a-z]+)(?:\s+(\d{4}))?$/))) {
    const mon = monthIndex(m[2]);
    if (mon >= 0) return m[3] ? makeDate(+m[3], mon, +m[1]) : upcoming(mon, +m[1], today);
  }

  // "october 25", "oct 25 2026"
  if ((m = p.match(/^([a-z]+)\s*(\d{1,2})(?:\s+(\d{4}))?$/))) {
    const mon = monthIndex(m[1]);
    if (mon >= 0) return m[3] ? makeDate(+m[3], mon, +m[2]) : upcoming(mon, +m[2], today);
  }

  // Bare day of the month: "27" -> the next 27th
  if ((m = p.match(/^(\d{1,2})$/))) {
    return upcomingDayOfMonth(+m[1], today);
  }

  return null;
}

/** Resolves a time phrase like "8am", "20:30", "10 o'clock", "8 in the evening" into {hour, minute}. */
function resolveTimePhrase(phrase) {
  if (!phrase) return null;
  let p = String(phrase).trim().toLowerCase();
  p = p.replace(/\b([ap])\.\s?m\.?/g, '$1m');                       // a.m. -> am
  p = p.replace(/o['’]?\s*clock|\bclock\b|\bhrs?\b|\bat\b/g, ' ');  // o'clock, hrs, at
  p = p.replace(/\s+/g, ' ').trim();

  const valid = (hour, minute) => hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  let m;

  if ((m = p.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (hour > 12 || minute > 59) return null;
    if (m[3] === 'pm' && hour < 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  if ((m = p.match(/^(\d{1,2})[:.](\d{2})$/))) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    return valid(hour, minute) ? { hour, minute } : null;
  }

  // "8 in the evening", "9 night", "6:30 morning"
  if ((m = p.match(/^(\d{1,2})(?::(\d{2}))?\s*(?:in the\s+)?(morning|afternoon|evening|night)$/))) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === 'afternoon' && hour >= 1 && hour <= 6) hour += 12;
    if (m[3] === 'evening' && hour >= 4 && hour <= 11) hour += 12;
    if (m[3] === 'night' && hour >= 6 && hour <= 11) hour += 12;
    return valid(hour, minute) ? { hour, minute } : null;
  }

  // Bare hour: "10" -> 10:00
  if ((m = p.match(/^(\d{1,2})$/))) {
    const hour = parseInt(m[1], 10);
    return valid(hour, 0) ? { hour, minute: 0 } : null;
  }

  if (/morning/.test(p)) return { hour: 9, minute: 0 };
  if (/afternoon/.test(p)) return { hour: 14, minute: 0 };
  if (/evening/.test(p)) return { hour: 18, minute: 0 };
  if (/night/.test(p)) return { hour: 21, minute: 0 };

  return null;
}

/** Combines a resolved date + time into a single dayjs instant in Asia/Kolkata. */
function combineDateTime(dateDayjs, time) {
  if (!dateDayjs || !time) return null;
  return dateDayjs.hour(time.hour).minute(time.minute).second(0).millisecond(0);
}

function isPast(instant) {
  return instant.isBefore(now());
}

function formatForConfirmation(instant, locale = 'en') {
  // Kept simple/locale-neutral here; locale-specific month/day names are
  // handled in utils/i18n.js when composing the full message.
  return instant.format('dddd, D MMMM YYYY, h:mm A');
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar: WhatsApp list message with the next 9 days + "Another date"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows for the calendar list: 9 days starting at `from` (default today, India
 * time) plus an "Another date" row. Ids look like DATE_2026-10-25 / DATE_OTHER.
 * `labels` lets the caller pass translated text for Today / Tomorrow / Another date.
 * Keeps within WhatsApp limits: 10 rows, title <= 24 chars, description <= 72 chars.
 */
function getDateListRows(opts = {}) {
  const L = {
    today: 'Today',
    tomorrow: 'Tomorrow',
    another: 'Another date',
    anotherHint: 'Type it, e.g. 25 October',
    ...(opts.labels || {}),
  };
  const base = now().startOf('day');
  let start = opts.from ? dayjs(opts.from).tz(TZ).startOf('day') : base;
  if (start.isBefore(base)) start = base;

  const rows = [];
  for (let i = 0; i < 9; i += 1) {
    const d = start.add(i, 'day');
    const diff = d.diff(base, 'day');
    const title = diff === 0 ? L.today : diff === 1 ? L.tomorrow : d.format('ddd, D MMM');
    rows.push({
      id: `DATE_${d.format('YYYY-MM-DD')}`,
      title: String(title).slice(0, 24),
      description: d.format('D MMMM YYYY').slice(0, 72),
    });
  }
  rows.push({
    id: 'DATE_OTHER',
    title: String(L.another).slice(0, 24),
    description: String(L.anotherHint).slice(0, 72),
  });
  return rows;
}

/**
 * Builds a complete WhatsApp interactive LIST payload (for senders that take a
 * raw payload). Dates are computed in India time, so "Today" is correct even
 * while the server (UTC) is still on the previous day.
 */
function buildDateListMessage(to, bodyText = 'Select your travel date') {
  return {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: 'Pick a date', sections: [{ title: 'Travel date', rows: getDateListRows() }] },
    },
  };
}

/** 'DATE_2026-10-25' -> '2026-10-25'. Anything else (including DATE_OTHER) -> null. */
function parseDateReply(replyId) {
  const m = /^DATE_(\d{4}-\d{2}-\d{2})$/.exec(replyId || '');
  return m ? m[1] : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Date / time pickers: 7 items per page + "Next 7 days" / "More times" (WhatsApp list)
// ─────────────────────────────────────────────────────────────────────────────

const TIMES_PER_PAGE = 7;
const SLOT_MINUTES = 30;     // gap between time slots
const DAY_START_HOUR = 6;    // first slot shown for a future date (customers can still type any time)

const pad2 = (n) => String(n).padStart(2, '0');

const CAL_MONTHS_AHEAD = 12; // how far ahead the calendar lets a customer go

/** Earliest allowed day, the first month shown, and the last month the arrows can reach. */
function getCalendarBounds({ from } = {}) {
  const base = now().startOf('day');
  let min = from ? dayjs(from).tz(TZ).startOf('day') : base;
  if (min.isBefore(base)) min = base;
  const firstMonth = min.startOf('month');
  return { min, firstMonth, lastMonth: firstMonth.add(CAL_MONTHS_AHEAD, 'month') };
}

/** 'YYYY-MM' -> first day of that month (India time). */
function parseMonthKey(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  return m ? dayjs.tz(`${m[1]}-${m[2]}-01`, TZ).startOf('day') : null;
}

/**
 * A text calendar for WhatsApp (shown in monospace). Days before `min` show as ··.
 * The month can move with the ◀ / ▶ buttons, running on into the next month and year.
 */
function renderMonthCalendar({ month, min, lastMonth }) {
  const first = month.startOf('month');
  const lines = [`   ${first.format('MMMM YYYY')}`, 'Su Mo Tu We Th Fr Sa'];
  let row = new Array(first.day()).fill('  '); // Sunday-first, like an Indian wall calendar
  let firstAvailable = null;
  for (let d = 1; d <= first.daysInMonth(); d += 1) {
    const day = first.date(d);
    const unavailable = day.isBefore(min);
    if (!unavailable && firstAvailable === null) firstAvailable = d;
    row.push(unavailable ? '··' : String(d).padStart(2, ' '));
    if (row.length === 7) { lines.push(row.join(' ')); row = []; }
  }
  if (row.length) lines.push(row.join(' '));

  const prev = first.subtract(1, 'month');
  const next = first.add(1, 'month');
  return {
    text: lines.join('\n'),
    monthLabel: first.format('MMMM YYYY'),
    firstAvailable,
    canPrev: !prev.isBefore(min.startOf('month')),
    canNext: !next.isAfter(lastMonth),
    prevLabel: prev.format('MMM YYYY'),
    nextLabel: next.format('MMM YYYY'),
  };
}


// ── Tap-only date picker (WhatsApp lists): month -> week -> day ─────────────
const MONTH_ROWS = 10; // a list holds at most 10 rows

/** Rows for the "pick a month" list, starting with the month of `min` and running on into next year. */
function getMonthRows({ min, count = MONTH_ROWS }) {
  const first = min.startOf('month');
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const m = first.add(i, 'month');
    rows.push({
      id: `CALMONTH_${m.format('YYYY-MM')}`,
      title: m.format('MMMM YYYY'),
      description: i === 0 ? `From ${min.format('ddd D MMM')}` : `${m.daysInMonth()} days`,
    });
  }
  return rows;
}

/** Calendar weeks (Sunday to Saturday) of a month, cut at the month's ends and at `min`. */
function getWeeksOfMonth({ month, min }) {
  const first = month.startOf('month');
  const last = month.endOf('month').startOf('day');
  const weeks = [];
  let start = first;
  while (!start.isAfter(last)) {
    let end = start.add(6 - start.day(), 'day'); // the Saturday
    if (end.isAfter(last)) end = last;
    if (!end.isBefore(min)) {
      weeks.push({ index: weeks.length, first: start.isBefore(min) ? min : start, last: end });
    }
    start = end.add(1, 'day');
  }
  return weeks;
}

function getWeekRows(weeks, labels = {}) {
  const L = { back: 'Other months', ...labels };
  const rows = weeks.map((w) => ({
    id: `CALWEEK_${w.index}`,
    title: (w.first.isSame(w.last, 'day') ? w.first.format('D MMM') : `${w.first.format('D')} – ${w.last.format('D MMM')}`).slice(0, 24),
    description: w.first.isSame(w.last, 'day') ? w.first.format('dddd') : `${w.first.format('ddd D')} – ${w.last.format('ddd D')}`,
  }));
  rows.push({ id: 'CAL_MONTHS', title: `⬅️ ${L.back}`.slice(0, 24) });
  return rows;
}

function getDatesOfWeek(week, labels = {}) {
  const L = { today: 'Today', tomorrow: 'Tomorrow', back: 'Other weeks', ...labels };
  const base = now().startOf('day');
  const rows = [];
  for (let d = week.first; !d.isAfter(week.last); d = d.add(1, 'day')) {
    const diff = d.diff(base, 'day');
    const label = d.format('ddd DD MMM'); // Thu 08 Oct
    const title = diff === 0 ? `${L.today} · ${label}` : diff === 1 ? `${L.tomorrow} · ${label}` : label;
    rows.push({ id: `DATE_${d.format('YYYY-MM-DD')}`, title: title.slice(0, 24), description: d.format('dddd') });
  }
  rows.push({ id: 'CAL_WEEKS', title: `⬅️ ${L.back}`.slice(0, 24) });
  return rows;
}

/**
 * All pickup-time slots (minutes since midnight) for `date`.
 * Today starts at the next slot after the current time; a later day starts at DAY_START_HOUR.
 * `notBefore` (e.g. the outbound pickup, for a return trip) pushes the start later on that same day.
 */
function getTimeSlots({ date, notBefore } = {}) {
  const day = date.tz(TZ).startOf('day');
  let lower = now();
  if (notBefore && dayjs(notBefore).isAfter(lower)) lower = dayjs(notBefore).tz(TZ);

  let startMin;
  if (lower.isSame(day, 'day')) {
    startMin = (Math.floor((lower.hour() * 60 + lower.minute()) / SLOT_MINUTES) + 1) * SLOT_MINUTES;
  } else if (lower.isBefore(day)) {
    startMin = DAY_START_HOUR * 60;
  } else {
    return []; // the day is already over
  }
  const slots = [];
  for (let m = startMin; m < 24 * 60; m += SLOT_MINUTES) slots.push(m);
  return slots;
}

function formatSlot(minutes) {
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  return `${h % 12 || 12}:${pad2(mi)} ${h < 12 ? 'AM' : 'PM'}`;
}

function partOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 21) return 'Evening';
  return 'Night';
}

/** One page of time slots plus the navigation rows (More times / Earlier times / Change date). */
function getTimePage({ slots, page = 0, labels = {}, nowLabel = null }) {
  const L = { more: 'More times', earlier: 'Earlier times', change: 'Change date', ...labels };
  const slice = slots.slice(page * TIMES_PER_PAGE, (page + 1) * TIMES_PER_PAGE);
  const timeRows = slice.map((m) => ({
    id: `TIME_${pad2(Math.floor(m / 60))}${pad2(m % 60)}`,
    title: formatSlot(m),
    description: partOfDay(Math.floor(m / 60)),
  }));
  // First page of today: the exact current time as the first choice.
  if (nowLabel && page === 0) timeRows.unshift({ id: 'TIME_NOW', title: `Now · ${nowLabel}`.slice(0, 24), description: 'Current time' });
  const moreRows = [];
  if (page > 0) moreRows.push({ id: 'TIME_EARLIER', title: `⬅️ ${L.earlier}`.slice(0, 24) });
  if ((page + 1) * TIMES_PER_PAGE < slots.length) moreRows.push({ id: 'TIME_MORE', title: `➡️ ${L.more}`.slice(0, 24) });
  moreRows.push({ id: 'TIME_CHANGE_DATE', title: `📅 ${L.change}`.slice(0, 24) });
  return { timeRows, moreRows, lastPage: Math.max(0, Math.ceil(slots.length / TIMES_PER_PAGE) - 1) };
}

/** 'TIME_0930' -> { hour: 9, minute: 30 }. Anything else -> null. */
function parseTimeReply(replyId) {
  const m = /^TIME_(\d{2})(\d{2})$/.exec(replyId || '');
  return m ? { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) } : null;
}

module.exports = {
  TZ,
  now,
  resolveDatePhrase,
  resolveTimePhrase,
  combineDateTime,
  isPast,
  formatForConfirmation,
  getDateListRows,
  buildDateListMessage,
  parseDateReply,
  getCalendarBounds,
  parseMonthKey,
  renderMonthCalendar,
  getMonthRows,
  getWeeksOfMonth,
  getWeekRows,
  getDatesOfWeek,
  getTimeSlots,
  getTimePage,
  parseTimeReply,
};
