'use strict';

/**
 * src/services/vehicleCatalog.service.js
 */

const crypto = require('crypto');

const { prisma } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const cache = require('./cache.service');
const storage = require('./storage.service');
const audit = require('./audit.service');

const vehicleModels = require('../data/vehicleModels.json');


const MODELS_FINGERPRINT = crypto
  .createHash('sha1')
  .update(JSON.stringify(vehicleModels.classes || {}))
  .digest('hex')
  .slice(0, 8);

// v5: `tripTypes` joined the serialised shape. A cached v4 entry has no such
// key, and a consumer reading `tripTypes` off it would see undefined and treat
// the class as unrestricted — the exact rule this release adds, silently
// disabled for six hours.
//
// v6: `bookingEnabled` joined it, and the same trap is waiting one level
// deeper. A cached v5 entry has no `bookingEnabled`, `isBookable` would read
// undefined as falsy, and EVERY class would go unbookable for six hours after
// deploy — the inverse of the v5 bug and a far louder one. Reading it as
// truthy instead would be no better: the admin flips the switch, the fare
// screen keeps selling the car, and the only evidence is a cache key.
const LIST_KEY = `catalog:vehicles:v6:${MODELS_FINGERPRINT}`;
const TTL = 6 * 60 * 60; // 6h; writes invalidate, so this is only a backstop

const FOLDER = 'vehicle-catalog';

/* ------------------------------------------------------------------ *
 * The global booking switch
 * ------------------------------------------------------------------ */

/**
 * "Stop taking bookings for everything", as ONE row in `settings` rather than
 * a bulk UPDATE across the catalogue.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST SET booking_enabled = false ON EVERY ROW
 * ---------------------------------------------------------------------------
 * Because that operation has no inverse. Suppose three classes are already
 * switched off individually — the Fortuner is in the workshop, two coaches are
 * on a long hire. An admin disables everything for a public holiday, then
 * re-enables everything on Monday. The bulk update has overwritten the three
 * deliberate decisions with one blanket one, and the Fortuner is now bookable
 * while it is still on a ramp. Nobody finds out until a dispatcher has no car
 * to send.
 *
 * A separate flag composes instead of overwriting: effective bookability is
 * `!allDisabled && row.bookingEnabled`, so the per-class state survives
 * untouched underneath the global one and Monday's re-enable restores exactly
 * the configuration Friday had.
 */
const GLOBAL_SETTING_KEY = 'vehicle_booking';
const GLOBAL_CACHE_KEY = 'catalog:booking:global:v1';

/**
 * 60 seconds, and short on purpose.
 *
 * This is the kill switch. It gets flipped when something is going wrong —
 * the fleet is stuck, a pricing bug is live, a festival surge was mispriced —
 * and the person flipping it is watching the app to see bookings stop. Writes
 * invalidate the key explicitly, so the minute is only the worst case when the
 * cache delete itself fails or another process wrote the row directly; even
 * then "a minute" is an answer an operator can live with and six hours is not.
 */
const GLOBAL_TTL = 60;

const GLOBAL_DEFAULT = Object.freeze({
  allDisabled: false,
  reason: null,
  disabledAt: null,
  disabledBy: null,
});

/**
 * Read the global switch.
 *
 * FAILS OPEN. If the settings table is missing (the migration has not run on
 * this environment yet) or the read errors, this returns "not disabled" —
 * which is exactly how the system behaved before this feature existed. The
 * alternative, failing closed, would turn one bad query into a total sales
 * outage with no admin action behind it, which is a far worse failure than the
 * one it would be guarding against.
 */
async function readGlobalSwitch() {
  const stored = await cache.getOrSet(
    GLOBAL_CACHE_KEY,
    async () => {
      try {
        const row = await prisma.setting.findUnique({ where: { key: GLOBAL_SETTING_KEY } });
        return row && row.value && typeof row.value === 'object' ? row.value : GLOBAL_DEFAULT;
      } catch (err) {
        console.warn('[vehicleCatalog] could not read the global booking switch:', err.message);
        return GLOBAL_DEFAULT;
      }
    },
    { ttl: GLOBAL_TTL, cacheNull: false },
  );

  const value = stored || GLOBAL_DEFAULT;

  return {
    // `=== true`, not truthy. The column is JSON and can hold anything a hand-
    // run UPDATE put there; only the literal boolean stops bookings.
    allDisabled: value.allDisabled === true,
    reason: value.reason || null,
    disabledAt: value.disabledAt || null,
    disabledBy: value.disabledBy || null,
  };
}

async function invalidateGlobalSwitch() {
  await cache.del(GLOBAL_CACHE_KEY);
}

/** True when bookings are switched off across the board. */
async function isBookingDisabledGlobally() {
  const { allDisabled } = await readGlobalSwitch();
  return allDisabled;
}


function carsFor(key) {
  const cars = vehicleModels.classes?.[key];
  return Array.isArray(cars) ? cars : [];
}

/** Keeps only entries the app can actually render. */
function usableImages(list) {
  return (Array.isArray(list) ? list : []).filter(
    (i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url),
  );
}

function classImagery(row) {
  const own = usableImages(row.images);
  if (own.length || row.heroUrl) {
    return { images: own, heroUrl: row.heroUrl || own[0]?.url || null };
  }

  const fromCars = carsFor(row.key).flatMap((c) => usableImages(c.images));
  return { images: fromCars, heroUrl: fromCars[0]?.url || null };
}

/** Every trip type a class can be restricted to. */
const TRIP_TYPES = Object.freeze(['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY']);

/**
 * The stored restriction, cleaned up for the wire.
 *
 * Total and forgiving: the column is JSON, so it can hold anything a bad write
 * or a hand-run UPDATE put there. Garbage reads as "[]" — unrestricted — which
 * is the same answer as an empty list and keeps a malformed row bookable
 * rather than making a vehicle disappear from every screen with no error.
 */
function tripTypesOf(row) {
  const raw = Array.isArray(row?.tripTypes) ? row.tripTypes : [];
  return raw
    .map((t) => String(t || '').trim().toUpperCase())
    .filter((t) => TRIP_TYPES.includes(t));
}

/**
 * May this class be booked for this trip type?
 *
 * EMPTY LIST MEANS ALL. Said once, here, so the rule cannot be half-remembered
 * at the three call sites that need it (the fare list, the single quote, and
 * the public catalogue filter).
 */
function allowsTripType(row, tripType) {
  const allowed = tripTypesOf(row);
  if (!allowed.length) return true;
  return allowed.includes(String(tripType || '').toUpperCase());
}

/**
 * Is this ROW switched on for booking — ignoring the global switch.
 *
 * `!== false` rather than `=== true`, and the distinction matters at exactly
 * one moment: the deploy. A row read from a cache entry written before this
 * column existed has no `bookingEnabled` key at all, and `=== true` would read
 * that undefined as "not bookable" and take the entire fleet off sale until
 * the cache expired. The cache version bump above is what should prevent that;
 * this is the belt to its braces, and it errs towards selling cars.
 *
 * The global switch is deliberately NOT consulted here, because this is a pure
 * function over a row and the global switch is an I/O read. Callers that need
 * both use `bookableClassesFor` or `assertBookable`, which combine them in one
 * place rather than in each caller.
 */
function isBookable(row) {
  return row?.bookingEnabled !== false;
}

/**
 * The set of class keys bookable for a trip type.
 *
 * Reads through the same cached list the fare screen uses, so this costs
 * nothing on the hot path. Returns a Set because every caller is doing
 * membership tests inside a loop.
 */
async function allowedClassesFor(tripType) {
  const rows = await list();
  return new Set(
    rows.filter((r) => allowsTripType(r, tripType)).map((r) => r.key),
  );
}

/**
 * The set of class keys a rider may ACTUALLY book right now: active, allowed
 * for the trip type, individually switched on, and not caught by the global
 * switch.
 *
 * Distinct from `allowedClassesFor`, which answers only the trip-type half.
 * Both exist because the two questions produce different errors — "we do not
 * run that car on airport trips" and "that car is off the road this week" need
 * different words and different fixes.
 *
 * @returns {Promise<Set<string>>} empty when the global switch is engaged
 */
async function bookableClassesFor(tripType) {
  if (await isBookingDisabledGlobally()) return new Set();

  const rows = await list();
  return new Set(
    rows
      .filter((r) => isBookable(r) && allowsTripType(r, tripType))
      .map((r) => r.key),
  );
}

/**
 * Refuse a quote or a booking for a class that is switched off.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NEEDED WHEN THE FARE LIST ALREADY FILTERS
 * ---------------------------------------------------------------------------
 * Same argument as the trip-type gate it sits next to. quoteAllClasses hides a
 * disabled class from the picker, so a rider tapping through the app cannot
 * reach this. The requests that CAN reach it are the ones that did not come
 * from the picker: a fare screen opened before the switch was flipped, a saved
 * deep link, "repeat my last booking", the WhatsApp bot resuming a conversation
 * from yesterday, or an admin re-classing a booking from the ERP.
 *
 * Without this, every one of those books a car the client has explicitly taken
 * off the road, and the first anyone knows is a dispatcher with nothing to
 * send.
 *
 * ---------------------------------------------------------------------------
 * AN UNKNOWN CLASS PASSES THROUGH, NOT OUT
 * ---------------------------------------------------------------------------
 * Exactly as assertClassAllowedForTripType does. A class with no active
 * catalogue row — retired, or an old rate card that never had one — must be
 * refused by getFareConfig with a message about pricing, not here with a
 * message about a switch nobody flipped.
 *
 * @throws {ApiError} BOOKING_DISABLED | VEHICLE_NOT_BOOKABLE
 */
async function assertBookable(vehicleClass) {
  const globalSwitch = await readGlobalSwitch();

  if (globalSwitch.allDisabled) {
    throw new ApiError(
      409,
      'BOOKING_DISABLED',
      globalSwitch.reason
        ? `We are not taking bookings at the moment. ${globalSwitch.reason}`
        : 'We are not taking bookings at the moment. Please try again shortly.',
      {
        allDisabled: true,
        reason: globalSwitch.reason,
        disabledAt: globalSwitch.disabledAt,
      },
    );
  }

  const rows = await list();
  const row = rows.find((r) => r.key === vehicleClass);

  // Not in the active catalogue. getFareConfig owns this refusal and words it
  // correctly — see the block comment above.
  if (!row) return;

  if (isBookable(row)) return;

  throw new ApiError(
    409,
    'VEHICLE_NOT_BOOKABLE',
    row.bookingDisabledReason
      ? `${row.name} is not available for booking right now. ${row.bookingDisabledReason}`
      : `${row.name} is not available for booking right now. Please choose another vehicle.`,
    {
      vehicleClass: row.key,
      name: row.name,
      reason: row.bookingDisabledReason || null,
      disabledAt: row.bookingDisabledAt || null,
    },
  );
}

function serialise(row) {
  if (!row) return null;
  const imagery = classImagery(row);
  return {
    key: row.key,
    name: row.name,
    seats: row.seats,
    blurb: row.blurb,
    detail: row.detail,
    luggage: row.luggage,
    glyph: row.glyph,
    transmission: row.transmission,
    fuel: row.fuel,
    /*
     * VARIANT GROUPING — two rows the app should draw as ONE card with a fuel
     * toggle (Swift Dzire Petrol / Swift Dzire CNG).
     *
     * `groupKey` falls back to the row's own key rather than staying null, so
     * the client can group unconditionally: every class belongs to exactly one
     * group, and a class with no variants is a group of one. The alternative —
     * null meaning "ungrouped" — makes every consumer write the same
     * `groupKey ?? key` branch, and the first one to forget it renders a card
     * with no title.
     *
     * `variantLabel` stays null when there is nothing to choose between. Null
     * is the signal to draw no toggle at all, which is not the same as drawing
     * a toggle with one button on it.
     */
    groupKey: row.groupKey || row.key,
    variantLabel: row.variantLabel || null,
    rating: row.rating == null ? null : Number(row.rating),
    trips: row.trips,
    /*
     * Which trip types this class may be booked for. ALWAYS AN ARRAY for the
     * client, whatever the column holds, and an empty one means no
     * restriction — the app must not read `[]` as "bookable for nothing".
     */
    tripTypes: tripTypesOf(row),
    heroUrl: imagery.heroUrl,
    // Always an array for the client, whatever the column holds.
    images: imagery.images,
    cars: carsFor(row.key),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    /*
     * THE BOOKING SWITCH, on the wire for every consumer.
     *
     * Serialised even on the PUBLIC catalogue, deliberately. A disabled class
     * is still part of the fleet the business shows off, so the browse screen
     * keeps rendering the card and greys it out with the reason — rather than
     * a car silently vanishing from the fleet page and the rider assuming it
     * was sold. The fare screen is where it actually disappears, because that
     * is the screen where picking it would lead somewhere.
     *
     * Coerced with `!== false` for the same reason isBookable is: a row read
     * from a pre-migration cache entry has no such key, and undefined must not
     * render as "unavailable" across the whole fleet.
     */
    bookingEnabled: row.bookingEnabled !== false,
    bookingDisabledReason: row.bookingDisabledReason || null,
    bookingDisabledAt: row.bookingDisabledAt || null,
  };
}

async function invalidate() {
  await cache.del(LIST_KEY);
}


async function list({ includeInactive = false, tripType = null, bookableOnly = false } = {}) {
  const rows = await listAll({ includeInactive });

  let out = rows;
  if (tripType) out = out.filter((r) => allowsTripType(r, tripType));

  /*
   * `bookableOnly` is OPT-IN and off by default, which is the opposite of what
   * it looks like it should be.
   *
   * The default has to stay "everything", because the admin panel, the audit
   * snapshots and the fleet browse screen all call this and all need to see a
   * disabled class — an admin cannot re-enable a car that the list it is
   * reading has filtered out. Only callers that are about to let someone BOOK
   * ask for the narrowed list, and they say so.
   */
  if (bookableOnly) {
    if (await isBookingDisabledGlobally()) return [];
    out = out.filter(isBookable);
  }

  return out;
}

async function listAll({ includeInactive = false } = {}) {
  if (includeInactive) {
    const rows = await prisma.vehicleCatalog.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(serialise);
  }

  return cache.getOrSet(
    LIST_KEY,
    async () => {
      const rows = await prisma.vehicleCatalog.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map(serialise);
    },
    { ttl: TTL, cacheNull: false },
  );
}

async function getByKey(key) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');
  return serialise(row);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function create(input, actor, meta = {}) {
  const existing = await prisma.vehicleCatalog.findUnique({ where: { key: input.key } });
  if (existing) {
    throw ApiError.conflict(
      `A vehicle class with the key "${input.key}" already exists`,
      'VEHICLE_CLASS_EXISTS',
    );
  }

  const row = await prisma.vehicleCatalog.create({ data: input });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_CREATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function update(key, input, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  /*
   * The bulk-edit form may carry `bookingEnabled` along with everything else.
   * Keep the two companion columns consistent with it here, so the switch
   * cannot end up on while a reason from last month is still attached to it —
   * that reason is shown to riders, and nothing else would ever clear it.
   *
   * The dedicated endpoint (setBookingEnabled) is still the one the toggle
   * should call; this only stops the general path leaving a mess behind.
   */
  const data = { ...input };
  if (Object.prototype.hasOwnProperty.call(data, 'bookingEnabled')) {
    if (data.bookingEnabled === true) {
      data.bookingDisabledReason = null;
      data.bookingDisabledAt = null;
    } else if (data.bookingEnabled === false && before.bookingEnabled !== false) {
      data.bookingDisabledAt = new Date();
    }
  }

  const row = await prisma.vehicleCatalog.update({ where: { key }, data });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_UPDATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/* ------------------------------------------------------------------ *
 * The booking switch — per class, and global
 * ------------------------------------------------------------------ */

/**
 * Switch booking on or off for ONE class.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `deactivate`
 * ---------------------------------------------------------------------------
 * `deactivate` retires a class from the catalogue, and it REFUSES while live
 * rate cards still price it — correctly, because a retired class that is still
 * priced can be quoted for something a rider cannot see.
 *
 * That refusal is exactly wrong for this operation. "Stop taking Innova
 * bookings, the cars are all out until Tuesday" has to work in one click on a
 * Saturday, with the rate cards left exactly where they are so Tuesday is also
 * one click. Routing it through deactivate would mean an admin deleting rate
 * cards to take a car off sale — and rebuilding them from memory afterwards.
 *
 * So there is NO rate-card check here, on purpose. There is nothing to protect
 * against: the class stays in the catalogue, the cards stay valid, and the
 * only thing that changes is whether a new booking can name it.
 *
 * EXISTING BOOKINGS ARE UNTOUCHED. A trip already agreed for this class runs
 * as agreed — this gate is on creating new ones, and silently cancelling
 * confirmed trips because a switch moved would be a far bigger decision than
 * the one the admin thinks they are making.
 */
async function setBookingEnabled(key, { enabled, reason = null }, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const row = await prisma.vehicleCatalog.update({
    where: { key },
    data: enabled
      ? {
          bookingEnabled: true,
          // CLEARED on re-enable, both of them. A stale reason left behind
          // would be shown to a rider the next time the switch is flipped,
          // explaining a closure that happened in March.
          bookingDisabledReason: null,
          bookingDisabledAt: null,
        }
      : {
          bookingEnabled: false,
          bookingDisabledReason: reason || null,
          // Stamped server-side. A client-supplied timestamp on an audit-
          // relevant field is a timestamp that can say anything.
          bookingDisabledAt: new Date(),
        },
  });

  await invalidate();

  audit.recordAsync({
    actor,
    action: enabled ? 'VEHICLE_CLASS_BOOKING_ENABLED' : 'VEHICLE_CLASS_BOOKING_DISABLED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/**
 * The global switch: stop (or resume) taking bookings for EVERYTHING.
 *
 * Writes one settings row. It does NOT touch `booking_enabled` on any class —
 * see the comment on GLOBAL_SETTING_KEY for why a bulk update is the wrong
 * implementation of this button.
 */
async function setAllBookingEnabled({ enabled, reason = null }, actor, meta = {}) {
  const before = await readGlobalSwitch();

  const value = enabled
    ? { ...GLOBAL_DEFAULT }
    : {
        allDisabled: true,
        reason: reason || null,
        disabledAt: new Date().toISOString(),
        // The id only, not the name or the email. An audit log is widely
        // readable inside the company and this row is read on the hot path.
        disabledBy: actor?.id ? String(actor.id) : null,
      };

  /*
   * NOT wrapped in try/catch, unlike the read.
   *
   * The read fails open because a missing settings table should not stop the
   * business selling. A WRITE that fails must be loud: an admin who presses
   * "stop all bookings" and is told it worked, while bookings keep arriving,
   * is in a far worse position than one who sees an error and escalates.
   */
  await prisma.setting.upsert({
    where: { key: GLOBAL_SETTING_KEY },
    update: { value },
    create: { key: GLOBAL_SETTING_KEY, value },
  });

  await invalidateGlobalSwitch();

  audit.recordAsync({
    actor,
    action: enabled ? 'VEHICLE_BOOKING_ENABLED_ALL' : 'VEHICLE_BOOKING_DISABLED_ALL',
    entityType: 'setting',
    entityId: GLOBAL_SETTING_KEY,
    before,
    after: value,
    meta,
  });

  return { ...value, allDisabled: value.allDisabled === true };
}

/**
 * Everything the admin screen needs to draw the switches: the global one, and
 * every class with its own state and whether it is EFFECTIVELY bookable.
 *
 * `effectivelyBookable` is computed here rather than left to the client. It is
 * the one piece of logic the admin UI, the rider app and the fare engine must
 * all agree on, and three copies of `!allDisabled && bookingEnabled` is three
 * chances for a screen to show a green toggle on a vehicle nobody can book.
 */
async function bookingStatus() {
  const [globalSwitch, rows] = await Promise.all([
    readGlobalSwitch(),
    listAll({ includeInactive: true }),
  ]);

  const classes = rows.map((r) => ({
    key: r.key,
    name: r.name,
    isActive: r.isActive,
    bookingEnabled: r.bookingEnabled,
    bookingDisabledReason: r.bookingDisabledReason,
    bookingDisabledAt: r.bookingDisabledAt,
    effectivelyBookable: r.isActive && r.bookingEnabled && !globalSwitch.allDisabled,
  }));

  return {
    global: globalSwitch,
    counts: {
      total: classes.length,
      active: classes.filter((c) => c.isActive).length,
      bookable: classes.filter((c) => c.effectivelyBookable).length,
      disabled: classes.filter((c) => c.isActive && !c.effectivelyBookable).length,
    },
    classes,
  };
}


async function deactivate(key, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const liveFares = await prisma.fareConfig.count({
    where: { vehicleClass: key, isActive: true },
  });
  if (liveFares > 0) {
    throw ApiError.badRequest(
      `${before.name} still has ${liveFares} active rate card(s). Retire those first, or riders can be quoted for a class they cannot see. ` +
        'If you only want to stop taking bookings for it, switch booking off instead — that keeps the rate cards and is one click to undo.',
      'VEHICLE_CLASS_IN_USE',
    );
  }

  const row = await prisma.vehicleCatalog.update({
    where: { key },
    data: { isActive: false },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_DEACTIVATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    before: serialise(before),
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

/**
 * PERMANENT delete of a vehicle class. No undo.
 *
 * ---------------------------------------------------------------------------
 * WHY RETIRING IS STILL THE NORMAL ANSWER
 * ---------------------------------------------------------------------------
 * `vehicleClass` is a free-text string, not a foreign key — it is written onto
 * bookings, vehicles, rate cards and rental packages as text. So nothing in the
 * database stops this delete, and that is exactly why the checks below have to
 * be explicit: deleting a class that bookings reference does not fail, it
 * silently leaves those bookings naming a class that no longer exists, and
 * every screen that joins the catalogue for a name and a photo renders a blank.
 *
 * Retiring (deactivate) keeps the row and takes the class off the fare screen,
 * which is the right move for a vehicle the business genuinely stopped
 * offering. This is for the other case: a class created by mistake, or a
 * placeholder like the old generic 'sedan' that was never sold and clutters
 * the admin list permanently.
 *
 * And for the third case — a car that is simply off the road this week — use
 * setBookingEnabled, which touches nothing but the switch.
 *
 * REFUSES IF ANYTHING AT ALL REFERENCES IT. Not just active things — a
 * cancelled booking from last year still names the class on its invoice.
 */
async function destroy(key, actor, meta = {}) {
  const before = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!before) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  /*
   * Counted in one round trip rather than four awaited in sequence, and
   * counting EVERY row rather than only active ones.
   *
   * The deactivate path above only checks active rate cards, which is correct
   * for retiring — an inactive card is already out of the way. It is wrong
   * here: an inactive card is still the evidence for what an old booking was
   * charged, and deleting the class it prices leaves that unreadable.
   */
  const [bookings, vehicles, fares, packages] = await Promise.all([
    prisma.booking.count({ where: { vehicleClass: key } }),
    prisma.vehicle.count({ where: { vehicleClass: key } }),
    prisma.fareConfig.count({ where: { vehicleClass: key } }),
    prisma.rentalPackage.count({ where: { vehicleClass: key } }),
  ]);

  const blockers = [
    bookings && `${bookings} booking(s)`,
    vehicles && `${vehicles} vehicle(s) in the fleet`,
    fares && `${fares} rate card(s)`,
    packages && `${packages} rental package(s)`,
  ].filter(Boolean);

  if (blockers.length) {
    throw ApiError.conflict(
      `${before.name} is still referenced by ${blockers.join(', ')}, so deleting it would leave those records naming a class that no longer exists. ` +
        'Retire it instead — it disappears from the app but keeps explaining the trips it priced.',
      'VEHICLE_CLASS_IN_USE',
    );
  }

  /*
   * Images are stored on Cloudinary, not in the row, so deleting the row alone
   * would orphan every file — paid-for storage nobody can reach or audit.
   *
   * Failures here are swallowed deliberately. A file that cannot be removed
   * (already gone, provider down) must not block the delete the admin asked
   * for, and leaving the row behind to keep the images tidy would be the wrong
   * trade. Worth logging so an orphan is at least visible.
   */
  for (const image of usableImages(before.images)) {
    if (!image.publicId) continue;
    try {
      await storage.destroy(image.publicId);
    } catch (err) {
      console.warn(`[vehicleCatalog] Could not delete image ${image.publicId}:`, err.message);
    }
  }

  await prisma.vehicleCatalog.delete({ where: { key } });
  await invalidate();

  /*
   * Audited with the FULL `before` and no `after`, which is what makes this
   * recoverable in practice: the row is gone from the table, but the audit
   * entry holds everything needed to recreate it if the delete was a mistake.
   */
  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_DELETED',
    entityType: 'vehicle_catalog',
    entityId: before.id,
    before: serialise(before),
    after: null,
    meta,
  });

  return serialise(before);
}

async function activate(key, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.update({
    where: { key },
    data: { isActive: true },
  });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_ACTIVATED',
    entityType: 'vehicle_catalog',
    entityId: row.id,
    after: serialise(row),
    meta,
  });

  return serialise(row);
}

async function addImage(key, { buffer, mimetype, label, asHero = false }, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const uploaded = await storage.uploadImage(buffer, {
    folder: `${FOLDER}/${key}`,
    mimetype,
  });

  let data;
  if (asHero) {
    const previous = row.heroPublicId;
    data = { heroUrl: uploaded.url, heroPublicId: uploaded.publicId };
    if (previous) {
      storage.destroy(previous).catch(() => {
      });
    }
  } else {
    const images = Array.isArray(row.images) ? row.images : [];
    data = {
      images: [
        ...images,
        {
          label: label || `View ${images.length + 1}`,
          url: uploaded.url,
          publicId: uploaded.publicId,
        },
      ],
    };
  }

  const updated = await prisma.vehicleCatalog.update({ where: { key }, data });
  await invalidate();

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_IMAGE_ADDED',
    entityType: 'vehicle_catalog',
    entityId: updated.id,
    after: { key, publicId: uploaded.publicId, asHero },
    meta,
  });

  return serialise(updated);
}


async function removeImage(key, publicId, actor, meta = {}) {
  const row = await prisma.vehicleCatalog.findUnique({ where: { key } });
  if (!row) throw ApiError.notFound('Vehicle not found', 'VEHICLE_CLASS_NOT_FOUND');

  const images = Array.isArray(row.images) ? row.images : [];
  const next = images.filter((i) => i.publicId !== publicId);

  if (next.length === images.length && row.heroPublicId !== publicId) {
    throw ApiError.notFound('That image is not on this vehicle', 'IMAGE_NOT_FOUND');
  }

  const data = { images: next };
  if (row.heroPublicId === publicId) {
    data.heroUrl = null;
    data.heroPublicId = null;
  }

  const updated = await prisma.vehicleCatalog.update({ where: { key }, data });
  await invalidate();
  storage.destroy(publicId).catch(() => {});

  audit.recordAsync({
    actor,
    action: 'VEHICLE_CLASS_IMAGE_REMOVED',
    entityType: 'vehicle_catalog',
    entityId: updated.id,
    after: { key, publicId },
    meta,
  });

  return serialise(updated);
}

module.exports = {
  TRIP_TYPES,
  list,
  allowsTripType,
  allowedClassesFor,
  getByKey,
  create,
  update,
  deactivate,
  destroy,
  activate,
  addImage,
  removeImage,

  /* booking switch */
  isBookable,
  isBookingDisabledGlobally,
  readGlobalSwitch,
  bookableClassesFor,
  assertBookable,
  setBookingEnabled,
  setAllBookingEnabled,
  bookingStatus,
};