'use strict';

/**
 * src/jobs/report.job.js   — Day 13
 *
 * The DOCUMENTS queue handler for CSV report exports.
 *
 * WHY THIS IS A JOB, NOT AN INLINE RESPONSE
 * -----------------------------------------
 * A full-period report can scan a lot of rows and take seconds. Building the
 * CSV inside the HTTP request would tie up an API worker and risk a timeout for
 * a big export. Instead the controller enqueues here and returns immediately
 * with a token; this job does the heavy read (on the reporting client) and the
 * CSV build off the request path, then stores the file for retrieval.
 *
 * IDEMPOTENT via runOnce, keyed by the export token (a deterministic hash of
 * report type + window). A redelivered job — worker killed mid-build — produces
 * exactly one stored export, not two, and re-requesting the same export reuses
 * the same token rather than regenerating.
 */

const { runOnce } = require('./runOnce');
const reportService = require('../services/report.service');
const reportCsv = require('../services/reportCsv');
const reportProvider = require('../services/providers/report.provider');

/**
 * @param {import('bullmq').Job} job  data: { token, type, range }
 */
async function handle(job) {
  const { token, type, range = {} } = job.data;
  if (!reportService.isValidReport(type)) {
    throw new Error(`[report.job] unknown report type "${type}"`);
  }

  const key = `export:${token}`;

  const outcome = await runOnce(
    key,
    'documents',
    async () => {
      // Heavy read + CSV build — the whole point of doing this off the request
      // path. Reads go through the reporting client inside report.service.
      const report = await reportService.runReport(type, range);
      const { filename, csv } = reportCsv.build(type, report);

      // Store the file (mock provider -> Redis; real -> object storage).
      const stored = await reportProvider.getProvider().store({ token, filename, csv });

      return {
        token,
        type,
        filename,
        url: stored.url,
        bytes: stored.bytes,
        expiresInSeconds: stored.expiresInSeconds,
        builtAt: new Date().toISOString(),
      };
    },
    job.data
  );

  if (outcome.skipped) {
    return { skipped: true, token };
  }
  return { generated: true, ...outcome.result };
}

module.exports = { handle };