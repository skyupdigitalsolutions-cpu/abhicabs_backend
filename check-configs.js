const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  console.log('=== All fare configs for city 1, grouped by tripType ===\n');
  const configs = await prisma.fareConfig.findMany({
    where: { cityId: 1 },
    select: {
      vehicleClass: true, tripType: true, isActive: true,
      effectiveFrom: true, perKm: true, hourlyRate: true, airportSurcharge: true,
    },
    orderBy: [{ tripType: 'asc' }, { vehicleClass: 'asc' }],
  });

  const byType = {};
  for (const c of configs) {
    byType[c.tripType] = byType[c.tripType] || [];
    byType[c.tripType].push(c);
  }

  for (const [type, rows] of Object.entries(byType)) {
    console.log(`${type}: ${rows.length} configs`);
    for (const r of rows) {
      console.log(`   ${r.vehicleClass.padEnd(10)} active=${r.isActive} effFrom=${r.effectiveFrom.toISOString()} perKm=${r.perKm} hourly=${r.hourlyRate} airport=${r.airportSurcharge}`);
    }
  }

  console.log('\n=== Now the EXACT query quoteAllClasses runs for AIRPORT ===');
  const airport = await prisma.fareConfig.findMany({
    where: { cityId: 1, tripType: 'AIRPORT', isActive: true, effectiveFrom: { lte: new Date() } },
  });
  console.log(`AIRPORT matched: ${airport.length} rows`);

  const hourly = await prisma.fareConfig.findMany({
    where: { cityId: 1, tripType: 'HOURLY', isActive: true, effectiveFrom: { lte: new Date() } },
  });
  console.log(`HOURLY matched: ${hourly.length} rows`);

  console.log(`\nServer time now: ${new Date().toISOString()}`);

  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });