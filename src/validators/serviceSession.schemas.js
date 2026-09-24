'use strict';

const { z } = require('zod');

/**
 * POST /auth/service/whatsapp-session
 *
 * `phone` MUST be the number from Meta's signed webhook payload, never text a
 * user typed — see the service for why that distinction is the whole security
 * model here. Nothing on this side can tell the difference, which is exactly
 * why it is stated at every layer.
 */
const whatsappSessionSchema = z.object({
  phone: z.string().trim().min(10).max(20),
  /** WhatsApp profile name. Optional; it only improves the account's display name. */
  profileName: z.string().trim().max(120).optional(),
});

module.exports = { whatsappSessionSchema };