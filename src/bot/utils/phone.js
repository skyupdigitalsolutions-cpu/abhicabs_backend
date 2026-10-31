/** Normalizes WhatsApp's wa_id (digits only, country code, no +) to a stable format. */
function normalizeWhatsAppNumber(waId) {
  return waId.replace(/[^\d]/g, '');
}

function isValidIndianMobile(input) {
  const digits = input.replace(/[^\d]/g, '');
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10);
}

module.exports = { normalizeWhatsAppNumber, isValidIndianMobile };
