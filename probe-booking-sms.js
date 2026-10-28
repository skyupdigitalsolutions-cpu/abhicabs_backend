'use strict';

/**
 * probe-booking-sms.js — find out what MSG91 actually calls this template's
 * variables, in ONE SMS.
 *
 * WHY THIS EXISTS
 * ---------------
 * MSG91 substitutes variables BY NAME and ignores any key it does not
 * recognise, without complaining: the request comes back "type":"success" and
 * the message arrives with the fixed text intact and every field blank. That
 * is indistinguishable from a dozen other faults, and guessing names one
 * deploy at a time costs an SMS and a restart each.
 *
 * So send every plausible name AT ONCE, each carrying a value that identifies
 * which key it came from. MSG91 fills the ones that exist and drops the rest,
 * and the message that arrives spells out the answer.
 *
 * Usage:
 *   node probe-booking-sms.js 9876543210
 *
 * READING THE RESULT
 * ------------------
 *   Booking ID: 1-lc      -> lowercase var1..var6. Set:
 *                            MSG91_BOOKING_VARS=var1,var2,var3,var4,var5,var6
 *   Booking ID: 1-UC      -> uppercase. Set VAR1,VAR2,VAR3,VAR4,VAR5,VAR6
 *   Booking ID: 0-bare    -> and EVERY line shows 0-bare: the template has ONE
 *                            variable named "var", repeated six times, because
 *                            it was imported with six identical ##var##
 *                            placeholders. No env value can fix that — the six
 *                            must be given distinct names in
 *                            MSG91 -> SMS -> Templates before the fields can
 *                            differ from each other.
 *   all still blank       -> the names are something custom. Open the template
 *                            in the panel and read them off the body.
 *
 * Costs one SMS.
 */

require('dotenv').config();

const env = require('./src/config/env');
const sms = require('./src/services/sms.service');

(async () => {
  const phone = process.argv[2];
  if (!sms.indianMobile(phone)) {
    console.error('Usage: node probe-booking-sms.js <10-digit Indian mobile number>');
    process.exit(2);
  }

  const missing = sms.missingConfig('BOOKING_CONFIRMED');
  if (missing.length) {
    console.error(`Booking SMS is OFF — missing ${missing.join(', ')}. Nothing was sent.`);
    process.exit(1);
  }

  /*
   * Every candidate, each value naming its own key. Values stay short and
   * ASCII — a probe that trips the 30-character limit or the GSM-7 rule would
   * fail for a reason unrelated to what it is testing.
   */
  const vars = { var: '0-bare' };
  for (let i = 1; i <= 6; i += 1) {
    vars[`var${i}`] = `${i}-lc`;
    vars[`VAR${i}`] = `${i}-UC`;
    vars[`Var${i}`] = `${i}-Cap`;
  }

  console.log(`Template ${env.msg91.bookingTemplateId}`);
  console.log(`Probing ${Object.keys(vars).length} candidate names in one message to ${sms.maskPhone(phone)}…`);

  try {
    const result = await sms.sendTemplate({ kind: 'BOOKING_CONFIRMED', phone, vars });
    console.log('\nMSG91 accepted it:', JSON.stringify(result.raw));
    console.log(`
Now read the SMS and compare against the key at the top of this file. Whatever
pattern the filled fields show IS the naming — put those six names, in the
order booking id, pickup, drop, date, vehicle, fare, into MSG91_BOOKING_VARS.`);
  } catch (err) {
    console.error('\nMSG91 refused it:', err.message);
    process.exit(1);
  }
})();