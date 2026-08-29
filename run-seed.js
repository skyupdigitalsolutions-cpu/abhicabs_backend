const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

(async () => {
  const raw = fs.readFileSync('prisma/seed-airport-hourly.sql', 'utf8');
  const cleaned = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = cleaned.split(';').map((s) => s.trim()).filter(Boolean);

  console.log(`Found ${statements.length} statements.\n`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    console.log(`--- Statement ${i + 1} (first 60 chars): ${stmt.slice(0, 60).replace(/\n/g, ' ')}`);
    try {
      await prisma.$executeRawUnsafe(stmt);
      console.log(`    ✓ ok`);
    } catch (e) {
      console.error(`    ✗ FAILED: ${e.message}`);
      throw e;
    }
  }
  console.log(`\n✓ All done.`);
  await prisma.$disconnect();
})().catch(async (e) => {
  await prisma.$disconnect();
  process.exit(1);
});