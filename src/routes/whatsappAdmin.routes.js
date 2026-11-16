'use strict';

/**
 * src/routes/whatsappAdmin.routes.js   -> mounted at /api/v1/admin/whatsapp
 *
 * The ERP's WhatsApp page, with the normal staff login.
 *
 * Why this exists: the page called `${API_BASE_URL}/bot-admin/...`, i.e.
 * /api/v1/bot-admin — but the bot mounts /bot-admin at the ROOT, so every
 * call was a 404. And /bot-admin only accepts the x-admin-key header; the page
 * fell back to the staff JWT, which it refuses (401). Putting ADMIN_API_KEY in
 * the ERP's VITE_ env would have shipped the secret inside the public JS
 * bundle. So the same handlers are served here behind requireAuth + role.
 *
 * The bot is loaded lazily and defensively: if src/bot fails to load, these
 * routes answer 503 instead of taking the whole API down at boot.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middlewares/auth');

let router;
try {
  const { buildAdminRouter } = require('../bot/routes/admin.routes');
  router = buildAdminRouter(requireAuth, requireRole('ADMIN', 'OPS', 'SUPPORT'));
} catch (err) {
  console.error('[whatsapp-admin] bot admin unavailable:', err.message);
  router = express.Router();
  router.use((req, res) =>
    res.status(503).json({ success: false, error: { code: 'BOT_UNAVAILABLE', message: 'The WhatsApp bot is not loaded on this server.' } })
  );
}

module.exports = router;
