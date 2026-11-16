'use strict';

/**
 * Vehicle classes are free text in three tables (vehicle_catalog.key,
 * fare_configs.vehicle_class, vehicles.vehicle_class) with no foreign key
 * between them. Older vehicles were typed as "Sedan" / "Swift Dzire" while
 * bookings carry the catalogue key "swift-dzire", and the dispatch check
 * compared them byte-for-byte — so a vehicle of the right class was refused
 * with "Vehicle is Swift-Dzire, booking needs swift-dzire".
 */

/** Comparison key: case, spaces, hyphens and underscores do not matter. */
const classKey = (c) => String(c == null ? '' : c).toLowerCase().replace(/[^a-z0-9]/g, '');

const sameClass = (a, b) => classKey(a) === classKey(b);

/** How a class is STORED from now on: lowercase, spaces -> hyphens ("Swift Dzire" -> "swift-dzire"). */
const normaliseClass = (c) => String(c == null ? '' : c).trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-');

module.exports = { classKey, sameClass, normaliseClass };
