'use strict';

/**
 * test-sms.js — send ONE real login-code SMS through MSG91 and print exactly
 * what MSG91 answered. Settles "is it our code or MSG91?" in one command.
 *
 * Uses the SAME function the login uses (sms.service.sendOtp), with the same
 * env vars, so a pass here means the app's login SMS is sent the same way.
 *
 * Usage (from the backend folder):
 *   With Railway's variables:   railway run node test-sms.js 9876543210
 *   With a local .env file:      node test-sms.js 9876543210
 *
 * The code in the SMS is random and is NOT a valid login code — this only
 * tests delivery. It costs one SMS.
 */

require('dotenv').config();

const env = require('./src/config/env');
const sms = require('./src/services/sms.service');

const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)} (${String(v).length} chars)` : '(NOT SET)');

(async () => {
  const phone = process.argv[2];
  if (!sms.indianMobile(phone)) {
    console.error('Usage: node test-sms.js <10-digit Indian mobile number>');
    process.exit(2);
  }

  console.log('--- MSG91 configuration the server sees ---');
  console.log('MSG91_AUTH_KEY        ', mask(env.msg91.authKey));
  console.log('MSG91_OTP_TEMPLATE_ID ', env.msg91.templateId || '(NOT SET)');
  console.log('Country code          ', env.msg91.countryCode);
  const missing = sms.missingConfig('LOGIN');
  if (missing.length) {
    console.error(`\nSMS is OFF — missing ${missing.join(', ')}. Nothing was sent.`);
    process.exit(1);
  }

  const code = String(1000 + Math.floor(Math.random() * 9000));
  console.log(`\nSending test code ${code} to ${sms.maskPhone(phone)} ...`);

  try {
    const result = await sms.sendOtp({ kind: 'LOGIN', phone, code, expiryMinutes: 5 });
    console.log('\nMSG91 ACCEPTED the request.');
    console.log('Raw response:', JSON.stringify(result.raw));
    console.log(`request_id:   ${result.requestId}`);
    console.log(`
Our code did its job: MSG91 took the SMS. Now:
  * SMS ARRIVED with code ${code}  -> SMS works; retry the app login.
  * NOTHING ARRIVED in 2 minutes  -> the message was dropped AFTER MSG91
    accepted it. Look up request_id ${result.requestId} in MSG91 -> Reports
    (OTP / Delivery logs). The status and failure reason shown there come
    from the operator; the usual ones are DLT problems: template text not
    matching the approved DLT text, sender ID (header) not approved, or the
    template not linked to your DLT entity.`);
  } catch (err) {
    console.error('\nMSG91 REFUSED or could not be reached:');
    console.error(' ', err.message);
    console.error(`
MSG91's own message above says why (bad authkey, template not found, no
balance, invalid number...). Fix that in the MSG91 panel or the env vars.`);
    process.exit(1);
  }
})();