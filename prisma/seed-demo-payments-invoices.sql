-- ===========================================================================
-- Demo data for the Payments and Invoices pages.
--
-- Attaches sample payments + GST invoices to bookings that ALREADY EXIST in
-- your database, so those admin pages have something realistic to render. It
-- invents no bookings and no customers, and amounts come from each booking's
-- own fare so the totals reconcile with the Bookings page.
--
-- Safe to re-run: inserts are guarded, and everything created is tagged so it
-- can be removed again (teardown at the bottom).
--   payments → provider = 'seed-demo'      invoices → series = 'DEMO'
--
-- invoice_number uses a DEMO/ prefix, NOT the production GST sequence, so this
-- cannot create a gap or a collision in the real series.
--
-- Run:  psql "$DATABASE_URL" -f prisma/seed-demo-payments-invoices.sql
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. PAYMENTS — one per booking, for up to 12 recent bookings
-- ---------------------------------------------------------------------------
INSERT INTO payments (
  id, booking_id, provider, provider_order_id, provider_payment_id,
  amount, currency, method, status, purpose, raw_response, paid_at,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  s.id,
  'seed-demo',
  'order_demo_' || substr(replace(s.id::text, '-', ''), 1, 12),
  'pay_demo_'   || substr(replace(s.id::text, '-', ''), 1, 12),
  s.amount,
  'INR',
  -- Spread across methods so the page's filters and charts have variety.
  (ARRAY['UPI','CARD','NETBANKING','CASH']::"PaymentMethod"[])[1 + (s.n % 4)],
  'CAPTURED'::"PaymentStatus",
  'FULL',
  '{"seeded": true}'::jsonb,
  s.created_at + interval '35 minutes',
  s.created_at + interval '30 minutes',
  now()
FROM (
  SELECT b.id,
         COALESCE(b.final_fare, b.estimated_fare, 1500.00) AS amount,
         b.created_at,
         (row_number() OVER (ORDER BY b.created_at DESC))::int AS n
  FROM bookings b
  WHERE NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.booking_id = b.id AND p.provider = 'seed-demo'
  )
  ORDER BY b.created_at DESC
  LIMIT 12
) s;

-- Two non-happy-path rows so the status filters aren't uniformly green.
UPDATE payments SET status = 'FAILED'::"PaymentStatus",
                    failure_reason = 'Insufficient funds',
                    paid_at = NULL
WHERE id = (SELECT id FROM payments
            WHERE provider = 'seed-demo' AND status = 'CAPTURED'
            ORDER BY created_at ASC LIMIT 1);

UPDATE payments SET status = 'REFUNDED'::"PaymentStatus"
WHERE id = (SELECT id FROM payments
            WHERE provider = 'seed-demo' AND status = 'CAPTURED'
            ORDER BY created_at ASC LIMIT 1);

-- ---------------------------------------------------------------------------
-- 2. INVOICES + LINES — one TAX invoice per captured demo payment
-- ---------------------------------------------------------------------------
-- GST is split 9% CGST + 9% SGST (intra-state) out of the gross, not added on
-- top: the fare the customer paid is inclusive of tax.
--
-- Invoices and their lines are created in ONE statement. invoices has no
-- booking_id column — the link lives on invoice_lines — so the mapping is
-- carried through a single CTE and recovered via RETURNING. Computing
-- row_number() twice over different joins could silently misalign lines with
-- the wrong invoice.
--
-- NOTE ON JOINS: bookings.customer_id references customers.user_id, which IS
-- the Customer primary key (there is no customers.id), and that value is also
-- the users.id. So users is joined directly on booking.customer_id.
WITH src AS (
  SELECT
    p.booking_id,
    p.amount AS gross,
    p.paid_at,
    b.customer_id,
    b.trip_type,
    b.distance_km,
    COALESCE(u.name, 'Walk-in Customer') AS bill_to,
    row_number() OVER (ORDER BY p.created_at) AS n
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id
  LEFT JOIN users u ON u.id = b.customer_id
  WHERE p.provider = 'seed-demo'
    AND p.status = 'CAPTURED'
    AND NOT EXISTS (
      SELECT 1 FROM invoice_lines il WHERE il.booking_id = p.booking_id
    )
),
ins AS (
  INSERT INTO invoices (
    id, invoice_number, series, financial_year, type, status,
    customer_id, bill_to_name, bill_to_address,
    subtotal, discount, taxable_value, cgst, sgst, igst, total_amount,
    place_of_supply, hsn_sac, notes, issued_at, paid_at, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    'DEMO/2026-27/' || lpad(src.n::text, 4, '0'),
    'DEMO',
    '2026-2027',
    'TAX'::"InvoiceType",
    'PAID'::"InvoiceStatus",
    src.customer_id,
    src.bill_to,
    'Bengaluru, Karnataka',
    round(src.gross / 1.18, 2),          -- subtotal (ex-GST)
    0,
    round(src.gross / 1.18, 2),          -- taxable value
    round(src.gross / 1.18 * 0.09, 2),   -- CGST 9%
    round(src.gross / 1.18 * 0.09, 2),   -- SGST 9%
    0,                                    -- IGST nil: intra-state
    src.gross,
    'Karnataka',
    '996601',                             -- SAC: rental of road vehicles
    'Demo invoice (seed-demo-payments-invoices.sql)',
    src.paid_at, src.paid_at, src.paid_at, now()
  FROM src
  RETURNING id, invoice_number, issued_at
)
INSERT INTO invoice_lines (
  id, invoice_id, booking_id, description, quantity, unit_price, amount, created_at
)
SELECT
  gen_random_uuid(),
  ins.id,
  src.booking_id,
  'Cab hire — ' || COALESCE(src.trip_type::text, 'ONE_WAY')
    || COALESCE(' (' || round(src.distance_km)::text || ' km)', ''),
  1,
  round(src.gross / 1.18, 2),
  round(src.gross / 1.18, 2),
  ins.issued_at
FROM ins
JOIN src ON ins.invoice_number = 'DEMO/2026-27/' || lpad(src.n::text, 4, '0');

COMMIT;

-- Sanity check
SELECT 'payments'      AS what, count(*) FROM payments WHERE provider = 'seed-demo'
UNION ALL
SELECT 'invoices',      count(*) FROM invoices WHERE series = 'DEMO'
UNION ALL
SELECT 'invoice_lines', count(*) FROM invoice_lines il
  JOIN invoices i ON i.id = il.invoice_id WHERE i.series = 'DEMO';

-- ===========================================================================
-- TEARDOWN — removes everything above and nothing else.
-- ===========================================================================
-- BEGIN;
-- DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE series = 'DEMO');
-- DELETE FROM invoices WHERE series = 'DEMO';
-- DELETE FROM payments WHERE provider = 'seed-demo';
-- COMMIT;
