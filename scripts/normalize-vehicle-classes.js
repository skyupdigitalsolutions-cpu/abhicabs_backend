#!/usr/bin/env node
'use strict';

/**
 * One-time clean-up: rewrite every vehicle's class to the catalogue spelling.
 *
 *   node scripts/normalize-vehicle-classes.js           # dry run: shows what would change
 *   node scripts/normalize-vehicle-classes.js --apply   # writes the changes
 *
 * "Swift Dzire", "SWIFT-DZIRE", "swift_dzire" all become the catalogue key
 * "swift-dzire". A class with no catalogue match is only lower-cased and
 * hyphenated, and listed at the end so you can add it to the catalogue or fix it.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { classKey, normaliseClass } = require('../src/utils/vehicleClass');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

(async () => {
  const catalogue = await prisma.vehicleCatalog.findMany({ select: { key: true } });
  const byKey = new Map(catalogue.map((c) => [classKey(c.key), c.key]));

  const vehicles = await prisma.vehicle.findMany({ select: { id: true, registrationNumber: true, vehicleClass: true } });
  const changes = [];
  const unknown = new Set();

  for (const v of vehicles) {
    const target = byKey.get(classKey(v.vehicleClass)) || normaliseClass(v.vehicleClass);
    if (!byKey.has(classKey(v.vehicleClass))) unknown.add(target);
    if (target && target !== v.vehicleClass) changes.push({ ...v, target });
  }

  for (const c of changes) console.log(`${c.registrationNumber.padEnd(14)} "${c.vehicleClass}" -> "${c.target}"`);
  console.log(`\n${changes.length} of ${vehicles.length} vehicles ${APPLY ? 'updated' : 'would change'}.`);
  if (unknown.size) console.log(`Classes not in the vehicle catalogue (no rate card match): ${[...unknown].join(', ')}`);

  if (APPLY) {
    for (const c of changes) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.vehicle.update({ where: { id: c.id }, data: { vehicleClass: c.target } });
    }
  } else if (changes.length) {
    console.log('Dry run only. Re-run with --apply to write.');
  }
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
