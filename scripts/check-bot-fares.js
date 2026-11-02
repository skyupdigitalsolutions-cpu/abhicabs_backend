#!/usr/bin/env node
'use strict';

/**
 * scripts/check-bot-fares.js
 *
 * "Why does the WhatsApp bot not show vehicles and prices?" in one command.
 *
 *   cd ~/abhicabs_backend && node scripts/check-bot-fares.js
 *
 * READ-ONLY. It never writes to the database and never sends a WhatsApp message.
 * It runs the bot's OWN fare function (src/bot/adapters/fareAdapter.js) on two sample trips,
 * exactly the way the bot does, and prints either the vehicle list with prices or the real error
 * together with what to change.
 */

require('dotenv').config();
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const line = (c = '-') => console.log(c.repeat(78));
const title = (t) => { console.log(''); line('='); console.log(t); line('='); };
const ok = (t) => console.log(`  OK    ${t}`);
const bad = (t) => console.log(`  FIX   ${t}`);
const info = (t) => console.log(`        ${t}`);

/** Turns an error from the fare engine into "what to change". */
function explain(err, ctx) {
  const code = err && err.code;
  const msg = (err && err.message) || String(err);
  if (code === 'LOCAL_SWITCH') {
    return 'This trip is inside one city, so the backend prices it as a LOCAL rental. The bot asks for hours instead. '
      + 'That needs an active HOURLY rate card (hourly_rate) for the city. This is not a failure of the setup.';
  }
  if (code === 'LOCAL_PACKAGE_REQUIRED') {
    return 'The backend wants a rental package for an in-city trip and the bot is not handling that yet. '
      + 'Copy the two files from the "local trip" fix (fareAdapter.js and booking.handler.js) and restart.';
  }
  if (code === 'CITY_NOT_SERVICED') {
    return `City id ${ctx.cityId} (BOT_DEFAULT_CITY_ID) is not a city that has active fare cards. `
      + `Set BOT_DEFAULT_CITY_ID in .env to one of: ${ctx.priceableCities.join(', ') || '(none found: add fare cards first)'} , then restart.`;
  }
  if (/OUTSIDE_SERVICE_STATES|service state|not served|do not operate/i.test(code + ' ' + msg)) {
    return `The pickup's state is not in the service-states list. Active states: ${ctx.states.join(', ') || '(none)'}. Add the state in the admin.`;
  }
  if (/REQUEST_DENIED|ZERO_RESULTS|OVER_QUERY|routes?|directions?|distance|geocod|maps|ECONN|ENOTFOUND|timeout/i.test(msg)) {
    return 'The route / distance lookup failed. Check MAPS_PROVIDER=google and MAPS_API_KEY in .env, that the Directions / '
      + 'Distance Matrix API is enabled for the key, and that the key is not restricted to another server address '
      + '(allow this server\'s public IP).';
  }
  return 'Unrecognised error. Send this whole output to your developer.';
}

async function main() {
  title('1. Settings the bot reads');
  const cityId = Number(process.env.BOT_DEFAULT_CITY_ID) || 1;
  info(`BOT_DEFAULT_CITY_ID   = ${process.env.BOT_DEFAULT_CITY_ID || '(not set, bot uses 1)'}`);
  info(`MAPS_PROVIDER         = ${process.env.MAPS_PROVIDER || '(not set)'}`);
  info(`MAPS_API_KEY          = ${process.env.MAPS_API_KEY ? 'set' : 'NOT SET'}`);
  info(`BOT_ENABLED           = ${process.env.BOT_ENABLED || '(default: on)'}`);
  if (process.env.MAPS_PROVIDER !== 'google') bad('MAPS_PROVIDER is not "google": fares use a mock distance.');
  if (!process.env.MAPS_API_KEY) bad('MAPS_API_KEY is empty: the distance lookup cannot work.');

  const { prisma } = require(path.join(ROOT, 'src/config/prisma'));

  title('2. Cities and rate cards');
  const cities = await prisma.city.findMany({ orderBy: { id: 'asc' } });
  const cards = await prisma.fareConfig.findMany({ where: { isActive: true } });
  const priceableCities = [...new Set(cards.filter((c) => c.cityId != null).map((c) => c.cityId))].sort((a, b) => a - b);
  const stateCards = [...new Set(cards.filter((c) => c.scope === 'STATE').map((c) => c.state))];
  console.table(cities.map((c) => ({
    id: c.id, name: c.name, state: c.state, active: c.isActive,
    'cards (city)': cards.filter((x) => x.cityId === c.id).length,
    'used by bot': c.id === cityId ? '<== BOT_DEFAULT_CITY_ID' : '',
  })));
  if (stateCards.length) info(`Statewide cards exist for: ${stateCards.join(', ')}`);
  const botCity = cities.find((c) => c.id === cityId);
  if (!botCity) bad(`There is no city with id ${cityId}. Set BOT_DEFAULT_CITY_ID to one of: ${cities.map((c) => c.id).join(', ')}`);
  else if (!botCity.isActive) bad(`City ${cityId} (${botCity.name}) is not active.`);
  else if (!priceableCities.includes(cityId) && !stateCards.includes(botCity.state)) bad(`City ${cityId} (${botCity.name}) has no active fare cards.`);
  else ok(`City ${cityId} (${botCity.name}) exists and has fare cards.`);

  title('3. Vehicle catalogue against rate cards (what can appear in the bot)');
  const catalog = await prisma.vehicleCatalog.findMany({ orderBy: { sortOrder: 'asc' } });
  const rows = catalog.map((v) => {
    const mine = cards.filter((c) => c.vehicleClass === v.key);
    const oneWay = mine.find((c) => c.tripType === 'ONE_WAY');
    const hourly = mine.find((c) => c.tripType === 'HOURLY');
    const trips = Array.isArray(v.tripTypes) ? v.tripTypes : [];
    let problem = '';
    if (!v.isActive) problem = 'catalogue row is not active';
    else if (!oneWay) problem = 'NO active ONE_WAY rate card';
    else if (trips.length && !trips.includes('ONE_WAY')) problem = 'catalogue does not allow ONE_WAY';
    else if (oneWay.effectiveFrom && new Date(oneWay.effectiveFrom) > new Date()) problem = 'rate card starts in the future';
    return {
      key: v.key, name: v.name, seats: v.seats, active: v.isActive,
      'ONE_WAY Rs/km': oneWay ? Number(oneWay.perKm) : '-',
      'HOURLY Rs/hr': hourly ? Number(hourly.hourlyRate) : '-',
      problem: problem || 'ok',
    };
  });
  console.table(rows);
  const shown = rows.filter((r) => r.problem === 'ok').length;
  if (!catalog.length) bad('vehicle_catalog is empty: no vehicle can be shown.');
  else if (!shown) bad('No catalogue vehicle has an active ONE_WAY rate card. The bot will say there are no vehicles.');
  else ok(`${shown} of ${catalog.length} catalogue vehicles can be shown for a one-way trip.`);
  const orphan = [...new Set(cards.map((c) => c.vehicleClass))].filter((k) => !catalog.some((v) => v.key === k));
  if (orphan.length) info(`Rate cards for classes that are NOT in the catalogue (never shown): ${orphan.join(', ')}`);

  title('4. Service states');
  const stateRows = await prisma.serviceState.findMany({ where: { isActive: true } }).catch(() => []);
  const states = stateRows.map((s) => s.name);
  info(`Active states: ${states.join(', ') || '(none)'}`);

  title('5. The bot\'s own fare lookup on two sample trips');
  const fare = require(path.join(ROOT, 'src/bot/adapters/fareAdapter'));
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  const trips = [
    { label: 'Outstation  Bengaluru (MG Road) -> Mysuru', tripType: 'ONE_WAY',
      pickup: { latitude: 12.9757, longitude: 77.6061, address: 'MG Road, Bengaluru, Karnataka' },
      drop: { latitude: 12.2958, longitude: 76.6394, address: 'Mysuru, Karnataka' } },
    { label: 'In the city Hebbal -> Koramangala (the bot switches this to Local)', tripType: 'ONE_WAY',
      pickup: { latitude: 13.0358, longitude: 77.5970, address: 'Hebbal, Bengaluru, Karnataka' },
      drop: { latitude: 12.9352, longitude: 77.6245, address: 'Koramangala, Bengaluru, Karnataka' } },
  ];
  const ctx = { cityId, priceableCities, states };
  let anyShown = false;
  for (const t of trips) {
    console.log(`\n  ${t.label}`);
    try {
      const options = await fare.getFareOptions({ tripType: t.tripType, pickup: t.pickup, drop: t.drop, pickupAt: tomorrow, cityId });
      if (!options.length) { bad('The lookup worked but returned NO vehicles.'); continue; }
      anyShown = true;
      ok(`${options.length} vehicles with prices:`);
      console.table(options.map((o) => ({ vehicle: o.vehicleName, seats: o.seatingCapacity, km: o.distanceKm, total: `Rs ${o.fare.total}` })));
    } catch (err) {
      if (err.code === 'LOCAL_SWITCH') {
        console.log('  NOTE  The backend turned this into a LOCAL rental, so the bot asks the customer for hours instead.');
        info('That is normal for a trip inside one city. It needs an active HOURLY rate card (hourly_rate) for the city.');
        continue;
      }
      console.log(`  ERROR  code=${err.code || '-'}  message=${err.message}`);
      bad(explain(err, ctx));
    }
  }

  title('Result');
  if (anyShown) ok('The bot can get vehicles and prices from this backend. If the chat still shows none, the bot code on the server is older than the fix: copy the files and restart.');
  else bad('The bot cannot get prices yet. Read the FIX lines above, change one thing, restart, and run this again.');
  await prisma.$disconnect();
  process.exit(anyShown ? 0 : 1);
}

main().catch((err) => {
  console.error('\nThe check itself failed:', err.message);
  process.exit(2);
});