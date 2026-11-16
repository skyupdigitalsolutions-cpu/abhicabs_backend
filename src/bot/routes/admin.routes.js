const express = require('express');
const { requireAdminKey } = require('../middleware/adminAuth');
const { adminLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/admin.controller');

/** Builds the bot-admin routes. The auth middleware is passed in so the same routes serve two doors. */
function buildAdminRouter(...auth) {
  const router = express.Router();
  router.use(...auth);
  router.get('/stats', ctrl.getStats);
  router.get('/conversations', ctrl.getConversations);
  router.get('/handoffs', ctrl.getHandoffs);
  router.post('/handoffs/:sessionId/resolve', ctrl.resolveHandoff);
  router.get('/support-tickets', ctrl.getSupportTickets);
  router.patch('/support-tickets/:id', ctrl.updateSupportTicket);
  return router;
}

// /bot-admin/* — x-admin-key, for scripts and monitoring.
const router = buildAdminRouter(adminLimiter, requireAdminKey);

module.exports = router;
module.exports.buildAdminRouter = buildAdminRouter;
