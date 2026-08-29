const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const past = new Date('2020-01-01T00:00:00Z');
  const r = await prisma.fareConfig.updateMany({
    where: { cityId: 1, tripType: { in: ['AIRPORT', 'HOURLY'] } },
    data: { effectiveFrom: past },
  });
  console.log(`Backdated ${r.count} AIRPORT/HOURLY configs to ${past.toISOString()}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });