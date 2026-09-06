'use strict';

/**
 * src/controllers/contact.controller.js
 *
 * `submit` is public (website form). The rest are staff-only and mounted behind
 * requireAuth + a role gate in the routes.
 */

const contactService = require('../services/contact.service');
const { asyncHandler } = require('../utils/helpers');

const meta = (req) => ({ ip: req.ip || '', userAgent: req.get('user-agent') || '' });

exports.submit = asyncHandler(async (req, res) => {
  const contact = await contactService.submit(req.body, meta(req));
  res.status(201).json({
    success: true,
    message: "Thanks for reaching out — we'll get back to you soon.",
    data: { id: contact.id, createdAt: contact.createdAt },
  });
});

exports.list = asyncHandler(async (req, res) => {
  const data = await contactService.list(req.validatedQuery || req.query);
  res.json({ success: true, data });
});

exports.getOne = asyncHandler(async (req, res) => {
  const contact = await contactService.getById(req.params.id);
  res.json({ success: true, data: { contact } });
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const contact = await contactService.updateStatus(req.params.id, req.body.status);
  res.json({ success: true, data: { contact } });
});