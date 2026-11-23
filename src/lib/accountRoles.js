'use strict';

/**
 * src/lib/accountRoles.js
 *
 * ONE ACCOUNT, TWO CAPABILITIES
 * ---------------------------------------------------------------------------
 * A person may be a rider and a driver at the same time. That used to be
 * impossible because `users.role` carried two different meanings at once:
 *
 *   1. WHICH STAFF POWERS this account has        (ADMIN / OPS / FINANCE / …)
 *   2. WHETHER this person is a rider or a driver (USER / DRIVER)
 *
 * Meaning 2 is now carried by the PROFILE ROWS instead — `customers.user_id`
 * and `drivers.user_id`. Both hang off the same User, so one account can own
 * both, and `users.role` goes back to meaning only "staff powers".
 *
 * ---------------------------------------------------------------------------
 * EFFECTIVE ROLE
 * ---------------------------------------------------------------------------
 * Dozens of services scope a query with `actor.role === 'USER'` to mean "this
 * is an ordinary person, show them only their own data". A DRIVER-role account
 * failed that test and was therefore treated as STAFF — a driver calling
 * GET /bookings got EVERY booking in the system. That hole closes here:
 *
 *   effectiveRole('ADMIN')  -> 'ADMIN'     staff keep their role
 *   effectiveRole('USER')   -> 'USER'
 *   effectiveRole('DRIVER') -> 'USER'      a driver browsing as a rider is
 *                                          scoped to their own records
 *
 * requireAuth puts the effective role on `req.user.role` and keeps the stored
 * one on `req.user.baseRole`. The driver-only routers put 'DRIVER' back on
 * `req.user.role` for the duration of that request (see requireDriverProfile),
 * which is what keeps the driver-specific rules in lifecycle.service — start
 * OTP, odometer photo — firing exactly as before.
 */

/** Roles that act on OTHER people's data. Everything else is self-service. */
const STAFF_ROLES = Object.freeze(['ADMIN', 'OPS', 'FINANCE', 'FLEET', 'SUPPORT']);

const STAFF_ROLE_SET = new Set(STAFF_ROLES);

/** @param {string} role a value of the Role enum */
function isStaffRole(role) {
  return STAFF_ROLE_SET.has(role);
}

/**
 * Staff check for an actor object. Reads baseRole first, because a driver
 * route has deliberately overwritten `role` with 'DRIVER' by then and a
 * driver is never staff.
 */
function isStaffActor(actor) {
  if (!actor) return false;
  return isStaffRole(actor.baseRole || actor.role);
}

/** The role every downstream ownership check should see. */
function effectiveRole(role) {
  return isStaffRole(role) ? role : 'USER';
}

module.exports = {
  STAFF_ROLES,
  isStaffRole,
  isStaffActor,
  effectiveRole,
};