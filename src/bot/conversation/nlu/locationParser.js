/**
 * Builds a normalized location object from either:
 *   - a WhatsApp "location" message (has real lat/long), or
 *   - typed free text (address only — lat/long left null; we never
 *     guess coordinates for a typed address without a geocoding call).
 *
 * If the typed text is too short/ambiguous (e.g. just "airport" with
 * multiple airports in the service area), the handler layer is
 * expected to ask a clarifying question rather than pick one.
 */
function fromWhatsAppLocationMessage(locationMessage) {
  return {
    address: locationMessage.name || locationMessage.address || null,
    latitude: locationMessage.latitude ?? null,
    longitude: locationMessage.longitude ?? null,
  };
}

function fromTypedText(text) {
  return {
    address: text.trim(),
    latitude: null,
    longitude: null,
  };
}

/** Very small heuristic — real deployments should back this with a geocoder/service-area lookup. */
function isAmbiguous(address) {
  if (!address) return true;
  const tooShort = address.trim().length < 3;
  const genericOnly = /^(airport|station|home|office)$/i.test(address.trim());
  return tooShort || genericOnly;
}

module.exports = { fromWhatsAppLocationMessage, fromTypedText, isAmbiguous };
