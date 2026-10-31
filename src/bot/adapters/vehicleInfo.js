'use strict';
/** Vehicle names / seats come from the website's own vehicle_catalog (key = booking.vehicleClass). */
const { prisma } = require('../../config/prisma');

// The cab types of the "Select Cab Type" list: the same six the old bot used (Sedan, SUV, Premium, Luxury,
// Tempo Traveller, Bus). With more than ten vehicles WhatsApp cannot show them in one list, so they are grouped.
// A vehicle that is not named here is placed by its seats.
const CATEGORY = {
  'swift-dzire': 'SEDAN', 'swift-dzire-cng': 'SEDAN',
  ertiga: 'SUV', innova: 'SUV',
  'innova-crysta': 'PREMIUM', 'innova-hycross': 'PREMIUM',
  fortuner: 'LUXURY', 'mercedes-e': 'LUXURY',
  'tempo-12': 'TEMPO_TRAVELLER', 'urbania-maharaja': 'TEMPO_TRAVELLER', 'urbania-13': 'TEMPO_TRAVELLER',
  'urbania-16': 'TEMPO_TRAVELLER', 'tempo-17': 'TEMPO_TRAVELLER',
  'benz-22': 'BUS', 'benz-28': 'BUS', 'benz-33': 'BUS',
};
function categoryFor(key, seats) {
  if (CATEGORY[key]) return CATEGORY[key];
  const n = Number(seats) || 4;
  if (n <= 4) return 'SEDAN';
  if (n <= 8) return 'SUV';
  if (n <= 17) return 'TEMPO_TRAVELLER';
  return 'BUS';
}

let cache = { at: 0, byKey: new Map() };
const TTL = 5 * 60 * 1000;

async function all() {
  if (Date.now() - cache.at < TTL && cache.byKey.size) return cache.byKey;
  const rows = await prisma.vehicleCatalog.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  cache = { at: Date.now(), byKey: new Map(rows.map((r) => [r.key, r])) };
  return cache.byKey;
}

async function vehicleInfo(key) {
  const row = (await all()).get(key);
  return row
    ? { vehicleId: key, name: row.name, category: categoryFor(key, row.seats), seatingCapacity: row.seats, ac: true }
    : { vehicleId: key, name: key, category: categoryFor(key, 4), seatingCapacity: 4, ac: true };
}

async function getAvailableVehicles() {
  return [...(await all()).values()].map((r) => ({ vehicleId: r.key, name: r.name, category: categoryFor(r.key, r.seats), seatingCapacity: r.seats, ac: true }));
}

module.exports = { vehicleInfo, getAvailableVehicles };