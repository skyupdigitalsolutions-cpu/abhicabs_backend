const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const TZ = 'Asia/Kolkata';

/**
 * Customer-facing dates and times are ALWAYS shown in India time. The server
 * runs in UTC, so plain dayjs(date).format() would show a 10:00 AM pickup as
 * 4:30 AM, and an early-morning pickup on the previous day.
 */
const ist = (d) => dayjs(d).tz(TZ);
const fmtDate = (d) => ist(d).format('DD MMM YYYY');
const fmtShortDate = (d) => ist(d).format('DD MMM');
const fmtTime = (d) => ist(d).format('h:mm A');
const fmtDateTime = (d) => ist(d).format('DD MMM YYYY, h:mm A');

/** 1890 -> "₹1,890" */
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

module.exports = { TZ, ist, fmtDate, fmtShortDate, fmtTime, fmtDateTime, inr };
