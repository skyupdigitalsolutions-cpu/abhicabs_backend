const express = require('express');
const { requireAdminKey } = require('../middleware/adminAuth');
const { adminLimiter } = require('../middleware/rateLimiter');
const {
  getStats,
  getHandoffs,
  getSupportTickets,
  resolveHandoff,
} = require('../controllers/admin.controller');

const router = express.Router();

router.use(adminLimiter, requireAdminKey);

router.get('/stats', getStats);
router.get('/handoffs', getHandoffs);
router.get('/support-tickets', getSupportTickets);
router.post('/handoffs/:sessionId/resolve', resolveHandoff);

module.exports = router;
