'use strict';

/**
 * test-booking-sms.js — send ONE real "booking confirmed" SMS through MSG91
 * and print exactly what MSG91 answered. The companion to test-sms.js, which
 * does the same for the login code.
 *
 * Uses the SAME function the notification worker uses
 * (sms.service.sendBookingConfirmed), with the same env vars, so a pass here
 * means a real confirmation is sent the same way.
 *
 * Usage (from the backend folder):
 *   node test-booking-sms.js 9876543210
 *
 * Costs one SMS.
 */

require('dotenv').config();

const env = require('./src/config/env');
const sms = require('./src/services/sms.service');

const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)} (${String(v).length} chars)` : '(NOT SET)');

(async () => {
  const phone = process.argv[2];
  if (!sms.indianMobile(phone)) {
    console.error('Usage: node test-booking-sms.js <10-digit Indian mobile number>');
    process.exit(2);
  }

  console.log('--- MSG91 configuration the server sees ---');
  console.log('MSG91_AUTH_KEY            ', mask(env.msg91.authKey));
  console.log('MSG91_BOOKING_TEMPLATE_ID ', env.msg91.bookingTemplateId || '(NOT SET)');
  console.log('NOTIFY_PROVIDER           ', env.notify.provider);

  const missing = sms.missingConfig('BOOKING_CONFIRMED');
  if (missing.length) {
    console.error(`\nBooking SMS is OFF — missing ${missing.join(', ')}. Nothing was sent.`);
    process.exit(1);
  }
  if (env.notify.provider !== 'msg91') {
    console.warn(
      '\nNOTE: NOTIFY_PROVIDER is not "msg91", so the WORKER would only log this' +
        '\nmessage rather than send it. This script bypasses the provider and sends' +
        '\ndirectly, so it still tests MSG91 + the template.',
    );
  }

  // Shaped exactly like notification.job builds them: ASCII only, <= 30 chars.
  const vars = {
    var1: 'TEST-0000',
    var2: 'Koramangala to Mysuru',
    var3: '29 Oct 9:00 am, SEDAN',
    var4: '4,250.00',
  };

  console.log(`\nSending to ${sms.maskPhone(phone)} with:`);
  console.log(vars);

  try {
    const result = await sms.sendBookingConfirmed({ phone, vars });
    console.log('\nMSG91 ACCEPTED the request.');
    console.log('Raw response:', JSON.stringify(result.raw));
    console.log(`request_id:   ${result.requestId}`);
    console.log(`
  * SMS ARRIVED, variables filled    -> done; confirm a booking in the admin
                                        panel to see the real thing.
  * SMS ARRIVED with literal ##var2## -> MSG91's variable NAMES for this
                                        template are not var1..var4. Open the
                                        template in MSG91 -> SMS -> Templates
                                        and rename them, or map them in
                                        notification.job -> bookingConfirmedSmsVars.
  * NOTHING ARRIVED in 2 minutes      -> dropped AFTER MSG91 accepted it. Look
                                        up request_id ${result.requestId} in
                                        MSG91 -> Reports. Usual causes: the
                                        template text not matching DLT word for
                                        word, or the header not approved.`);
  } catch (err) {
    console.error('\nMSG91 REFUSED or could not be reached:');
    console.error(' ', err.message);
    process.exit(1);
  }
})();