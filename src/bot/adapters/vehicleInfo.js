'use strict';
/** Vehicle names / seats come from the website's own vehicle_catalog (key = booking.vehicleClass). */
const { prisma } = require('../../config/prisma');

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
    ? { vehicleId: key, name: row.name, category: row.groupKey || row.key, seatingCapacity: row.seats, ac: true }
    : { vehicleId: key, name: key, category: key, seatingCapacity: 4, ac: true };
}

async function getAvailableVehicles() {
  return [...(await all()).values()].map((r) => ({ vehicleId: r.key, name: r.name, category: r.groupKey || r.key, seatingCapacity: r.seats, ac: true }));
}

module.exports = { vehicleInfo, getAvailableVehicles };
