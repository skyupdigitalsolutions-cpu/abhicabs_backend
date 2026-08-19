'use strict';

/**
 * src/services/webhook.service.js
 *
 * Turns an at-least-once, out-of-order stream of gateway webhooks into exactly
 * one state change per real event.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE  (order matters, each step defends the next)
 * ---------------------------------------------------------------------------
 *   1. VERIFY the signature over the RAW bytes. An unsigned or wrongly-signed
 *      body is rejected before it can touch anything. (The route is mounted
 *      with express.raw() so we have the exact bytes — see app.js.)
 *   2. PARSE into the provider-neutral shape.
 *   3. DEDUPE by inserting the event id first. A unique violation means we have
 *      already SEEN this event; if we also already PROCESSED it, stop. If we
 *      saw it but processing failed last time, reprocess it.
 *   4. APPLY the event through the forward-only payment machine, and mark the
 *      event processed — in ONE transaction, so a crash mid-apply leaves the
 *      event un-processed and a retry redoes it cleanly.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT ENQUEUE-AND-RETURN YET
 * ---------------------------------------------------------------------------
 * The gateway wants a 200 within a couple of seconds. The durable way to hit
 * that is: insert the event, return 200, and let a BullMQ worker apply it. That
 * queue arrives on Day 12. Until then the apply is synchronous — which is fine
 * because the mock is instant and the work is a couple of indexed writes. The
 * structure here (dedupe, then a self-contained apply step) is exactly what
 * Day 12 will lift onto the queue: `enqueue(eventRow.id)` replaces the inline
 * `process()` call and nothing else moves.
 */

const { prisma, isUniqueViolation } = require('../config/prisma');
const { ApiError } = require('../utils/helpers');
const paymentProvider = require('./providers/payment.provider');
const paymentService = require('./payment.service');

/**
 * Ingests one raw webhook.
 *
 * @param {object} args
 *   provider   short name, from the route (e.g. 'mock', 'razorpay')
 *   rawBody    Buffer of the exact request bytes
 *   signature  the signature header value
 *   headers    the full header map (some providers carry the event id here)
 *
 * @returns {Promise<{ duplicate:boolean, changed:boolean, status?:string, reason?:string }>}
 */
async function ingest({ provider: providerName, rawBody, signature, headers = {} }) {
  const provider = paymentProvider.getProvider();

  // 1. VERIFY over the raw bytes. Reject anything we cannot authenticate.
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    throw ApiError.unauthorized('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID');
  }

  // 2. PARSE. Only now is it safe to interpret the bytes as JSON.
  let parsed;
  try {
    const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const payload = JSON.parse(bodyText);
    // Some gateways carry the event id in a header rather than the body.
    if (headers['x-razorpay-event-id']) payload.__eventId = headers['x-razorpay-event-id'];
    parsed = provider.parseWebhook(payload);
  } catch (err) {
    throw ApiError.badRequest('Malformed webhook body', 'WEBHOOK_BODY_INVALID');
  }

  if (!parsed.eventId) {
    throw ApiError.badRequest('Webhook has no event id to dedupe on', 'WEBHOOK_NO_EVENT_ID');
  }

  // 3. DEDUPE — insert the event id FIRST.
  let eventRow;
  try {
    eventRow = await prisma.webhookEvent.create({
      data: {
        provider: provider.name,
        eventId: parsed.eventId,
        eventType: parsed.eventType || 'unknown',
        payload: parsed.raw || {},
        signature: signature ? String(signature).slice(0, 255) : null,
      },
      select: { id: true, processedAt: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Seen before. Was it actually processed?
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: provider.name, eventId: parsed.eventId } },
      select: { id: true, processedAt: true },
    });

    if (existing?.processedAt) {
      // True duplicate of a completed event. This is THE replay case — return
      // without changing anything. Sending it five times lands here four times.
      return { duplicate: true, changed: false, reason: 'already_processed' };
    }
    // Seen but never finished (a prior attempt crashed). Reprocess it.
    eventRow = existing;
  }

  // 4. APPLY + mark processed, atomically.
  return process(eventRow.id, parsed);
}

/**
 * Applies a parsed event and marks the webhook row processed in one
 * transaction. On failure, records the error out-of-band and rethrows so the
 * gateway retries (and step 3 will reprocess, since processedAt stays null).
 */
async function process(eventRowId, parsed) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const applied = await paymentService.applyGatewayEvent(tx, parsed);

      await tx.webhookEvent.update({
        where: { id: eventRowId },
        data: {
          processedAt: new Date(),
          attempts: { increment: 1 },
          eventType: parsed.eventType || undefined,
        },
      });

      return applied;
    });

    return { duplicate: false, changed: result.changed, status: result.status, reason: result.reason };
  } catch (err) {
    // Leave processedAt null so a retry reprocesses; record why it failed.
    await prisma.webhookEvent
      .update({
        where: { id: eventRowId },
        data: {
          failedAt: new Date(),
          attempts: { increment: 1 },
          error: String(err.message || err).slice(0, 500),
        },
      })
      .catch(() => {});
    throw err;
  }
}

module.exports = { ingest };