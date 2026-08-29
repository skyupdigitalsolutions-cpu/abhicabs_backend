-- Add the AIRPORT and HOURLY trip types. Enum-value additions must run in their
-- own migration (Postgres cannot add and then use an enum value in one txn).
ALTER TYPE "TripType" ADD VALUE IF NOT EXISTS 'AIRPORT';
ALTER TYPE "TripType" ADD VALUE IF NOT EXISTS 'HOURLY';