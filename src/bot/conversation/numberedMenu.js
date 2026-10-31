const EMOJI_DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/** "1️⃣" for 1-9, falls back to "10." style for anything larger. */
function emojiFor(number) {
  if (number >= 0 && number <= 9) return EMOJI_DIGITS[number];
  return `${number}.`;
}

/**
 * Turns a list of { id, number, label, description? } into:
 *   - rows/buttons ready for WhatsApp (title prefixed with the emoji digit)
 *   - a { "1": id, "2": id, ... } map remembered on the session, so that if
 *     the customer replies with the bare text "1" instead of tapping, the
 *     state machine can resolve it back to the same id (see
 *     resolveNumericSelection below).
 *
 * `number` is explicit (not auto-incremented) so menus can intentionally
 * skip a digit (e.g. the main menu skips 7️⃣, reserved for a future
 * "Offers" item) while still matching what's shown on screen.
 */
function toNumbered(items) {
  const rows = items.map((item) => ({
    id: item.id,
    title: `${emojiFor(item.number)} ${item.label}`.slice(0, item.maxTitleLength || 60),
    ...(item.description ? { description: item.description } : {}),
  }));
  const map = {};
  items.forEach((item) => {
    map[String(item.number)] = item.id;
  });
  return { rows, map };
}

/**
 * Persists the currently-valid number → id map on the session so a
 * follow-up bare-digit reply can be resolved. Overwrites whatever menu
 * was remembered before, so stale numbers from an earlier prompt can
 * never be misinterpreted once a new numbered menu has been shown.
 */
async function rememberOptions(session, map) {
  session.pendingOptionsMap = map;
  await session.save();
}

/**
 * If the inbound message is a bare number ("1", "2)", " 3 ") and the
 * session currently has a remembered numbered menu, returns the id it
 * maps to. Returns null for anything else — including states that are
 * expecting free text (a name, a reason, a passenger count) rather than
 * a menu choice, since callers only invoke this for states that
 * actually presented a numbered menu.
 */
function resolveNumericSelection(session, message) {
  if (message.interactiveId) return null; // an actual tap always wins
  const raw = (message.text || message.interactiveTitle || '').trim();

  // 1) bare number: "1", "2)", " 3 ", "4."
  let match = raw.match(/^(\d{1,2})[.)]?$/);
  // 2) a tapped list row echoed back as text, e.g. "1\uFE0F\u20E3 12 Seater Tempo Trav" (emoji digit first)
  if (!match) match = raw.match(/^(\d)\uFE0F?\u20E3/);
  // 3) the same for rows numbered 10+, which are shown as "10. Name"
  if (!match) match = raw.match(/^(\d{2})[.)]\s/);
  if (!match) return null;

  const map = session.pendingOptionsMap || {};
  const id = map[match[1]];
  return id || null;
}

module.exports = { emojiFor, toNumbered, rememberOptions, resolveNumericSelection };
