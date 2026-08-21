'use strict';

/**
 * src/validators/report.schemas.js   — Day 13
 */

const { z } = require('zod');

const REPORT_TYPES = ['executive', 'fleet', 'driver-performance', 'business-trend', 'gst'];

// A date range. Both optional — the service defaults to the last 30 days.
// Accepts full ISO datetimes or plain YYYY-MM-DD dates. An empty-string param
// (e.g. `?from=&to=` from a form or a blank template var) is treated as absent
// rather than rejected.
const emptyToUndef = (v) => (v === '' || v == null ? undefined : v);

const isoOrDate = z.preprocess(
  emptyToUndef,
  z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid date' })
    .optional()
);

const rangeQuerySchema = z
  .object({
    from: isoOrDate,
    to: isoOrDate,
  })
  .refine((v) => !(v.from && v.to) || Date.parse(v.from) < Date.parse(v.to), {
    message: '`from` must be before `to`',
    path: ['from'],
  });

const typeParamSchema = z.object({
  type: z.enum(REPORT_TYPES),
});

const exportTokenParamSchema = z.object({
  token: z.string().min(8).max(120),
});

module.exports = {
  REPORT_TYPES,
  rangeQuerySchema,
  typeParamSchema,
  exportTokenParamSchema,
};