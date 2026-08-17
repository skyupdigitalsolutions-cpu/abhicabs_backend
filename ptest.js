const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiVVNFUiIsInR5cCI6ImFjY2VzcyIsImlhdCI6MTc4Njk2NDAwMSwiZXhwIjoxNzg2OTY0OTAxLCJzdWIiOiJkYmNlNDA1OC01M2YyLTQ5MTEtYTdlOC1hNTkzYWIzYjFhMDUifQ.auApVQKXklBOxhuHBQX0mKROl5X2xR5tv99NkVdegQ4';
const KEY = 'par-' + Date.now();

const body = {
  cityId: 1,
  vehicleClass: 'sedan',
  tripType: 'ONE_WAY',
  pickup: { lat: 12.9716, lng: 77.5946 },
  drop: { lat: 12.2958, lng: 76.6394 },
  pickupAt: '2026-09-01T04:30:00.000Z',
  paymentMode: 'PARTIAL',
};

(async () => {
  console.log('Idempotency-Key:', KEY, '\n');

  const rs = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch('http://localhost:5000/api/v1/bookings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Idempotency-Key': KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const j = await r.json();
          return {
            s: r.status,
            rep: r.headers.get('idempotency-replayed') === 'true',
            n: j?.data?.booking?.bookingNumber ?? (j?.error?.code || 'none'),
          };
        })
        .catch((e) => ({ s: 'ERR', n: e.message }))
    )
  );

  rs.forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.s}  ${r.n}${r.rep ? '  (replayed)' : ''}`)
  );

  const nums = rs.map((r) => r.n).filter((n) => n.startsWith('ABH'));
  const unique = new Set(nums);
  console.log('\n  responses with a booking number:', nums.length);
  console.log('  distinct booking numbers:', unique.size);
  console.log('  ->', unique.size === 1 ? 'PASS' : 'FAIL');
})();