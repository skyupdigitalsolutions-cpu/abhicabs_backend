'use strict';

/**
 * src/controllers/serviceSession.controller.js
 */

const service = require('../services/serviceSession.service');
const { asyncHandler } = require('../utils/helpers');

exports.startWhatsAppSession = asyncHandler(async (req, res) => {
  const data = await service.startWhatsAppSession(req.body, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.json({ success: true, data });
});