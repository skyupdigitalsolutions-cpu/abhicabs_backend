require('dotenv').config();

function required(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return v;
}

const env = {
  NODE_ENV: required('NODE_ENV', 'development'),
  PORT: parseInt(required('PORT', '3000'), 10),

  DATABASE_URL: required('DATABASE_URL', 'mongodb://127.0.0.1:27017/abhicabs_whatsapp'),

  // ─── MSG91 (WhatsApp BSP) ─────────────────────────────────
  // This deployment sends/receives WhatsApp messages through MSG91
  // rather than talking to Meta's Graph API directly. MSG91 wraps
  // Meta's own message JSON inside its own envelope — see
  // integrations/whatsapp/client.js for the exact shape.
  MSG91_AUTH_KEY: required('MSG91_AUTH_KEY'),
  MSG91_INTEGRATED_NUMBER: required('MSG91_INTEGRATED_NUMBER'), // e.g. 918096000182
  MSG91_WEBHOOK_SECRET: required('MSG91_WEBHOOK_SECRET'), // custom header value you set when creating the MSG91 webhook

  // Which service carries the WhatsApp messages: 'msg91' (default), 'meta' = Meta's WhatsApp Cloud API directly with no
  // provider queue in between, or 'auto' = answer each customer through the same door they wrote to (safe for testing Meta
  // with your own phone while real customers stay on MSG91). For 'meta' or 'auto' set all five META_ values.
  WHATSAPP_PROVIDER: required('WHATSAPP_PROVIDER', 'msg91'),
  META_ACCESS_TOKEN: required('META_ACCESS_TOKEN', ''),     // a permanent system-user token with whatsapp_business_messaging
  META_PHONE_NUMBER_ID: required('META_PHONE_NUMBER_ID', ''),
  META_APP_SECRET: required('META_APP_SECRET', ''),         // used to check every incoming message really came from Meta
  META_VERIFY_TOKEN: required('META_VERIFY_TOKEN', ''),     // any long random text; the same text goes into Meta's webhook setup
  META_API_VERSION: required('META_API_VERSION', 'v21.0'),

  AI_API_KEY: required('AI_API_KEY'),
  AI_MODEL: required('AI_MODEL', 'claude-sonnet-4-6'),

  BACKEND_MODE: required('BACKEND_MODE', 'local'), // 'local' | 'remote'
  BACKEND_API_URL: required('BACKEND_API_URL'),
  BACKEND_API_KEY: required('BACKEND_API_KEY'),

  RAZORPAY_KEY_ID: required('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: required('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: required('RAZORPAY_WEBHOOK_SECRET'),

  // Road distance for fares (Google Distance Matrix API). Optional: without it,
  // typed addresses fall back to a 50 km default and fares will be inaccurate.
  GOOGLE_MAPS_API_KEY: required('GOOGLE_MAPS_API_KEY'),

  // WhatsApp Flow with a real calendar (tap a date). Leave empty to use the text calendar.
  // See date-calendar-flow.json for the Flow to create in WhatsApp Manager.
  DATE_FLOW_ID: required('DATE_FLOW_ID', ''),
  // Typing "ping" in WhatsApp shows where the time goes (MSG91 in, the bot, MSG91 out). false = off.
  ENABLE_PING: required('ENABLE_PING', 'true') !== 'false',
  // true = typing "flowtest" in WhatsApp sends the Flow to yourself and reports MSG91's answer. For checking only.
  ENABLE_FLOW_TEST: required('ENABLE_FLOW_TEST', 'false') === 'true',
  // true = the Flow also has a time dropdown (use date-time-calendar-flow.json); false = date only.
  DATE_FLOW_TIME: required('DATE_FLOW_TIME', 'false') === 'true',

  // Order of the booking steps after the pickup:
  //   "drop_first" (default): pickup -> drop -> date -> time -> cab
  //   "date_first": pickup -> date -> time -> drop -> (return date/time) -> cab
  BOOKING_ORDER: required('BOOKING_ORDER', 'drop_first'),

  // "Search place" for pickup/drop:
  //   "native" (default) = WhatsApp's own map with its search bar opens from a "Send location" button. No link, nothing to type.
  //   "chat" = type the name in WhatsApp and pick from a list;  "web" = a search page from a link;  "auto" = web when set up, else chat.
  LOCATION_SEARCH: required('LOCATION_SEARCH', 'native'),

  // Optional: "Search place" (pickup and drop) opens a map PAGE from a link (search bar + marker + Confirm).
  // "off" (default) = no links. "on" = use it when PUBLIC_BASE_URL is set.
  PLACE_MAP: required('PLACE_MAP', 'off'),

  // Public https address of this server (no trailing slash), used for the calendar page link.
  // If PUBLIC_BASE_URL is not set, Railway's own public address is used (RAILWAY_PUBLIC_DOMAIN is set by Railway itself).
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  // Signs calendar links. Optional: MSG91_WEBHOOK_SECRET is used when this is empty.
  CALENDAR_LINK_SECRET: required('CALENDAR_LINK_SECRET', ''),

  // Google Maps route links (they open the pickup, stops and drop on Google Maps). Both are OFF by default.
  //  - SUMMARY_MAP_LINK=true  adds a "Route:" line to the booking summary.
  //  - PAGE_MAP_LINK=true     adds "View route in Google Maps" to the pickup and drop page.
  SUMMARY_MAP_LINK: required('SUMMARY_MAP_LINK', 'false') === 'true',
  PAGE_MAP_LINK: required('PAGE_MAP_LINK', 'false') === 'true',

  // Sending confirmed WhatsApp bookings to the ABHI CABS website (through its own API), so they show in its admin and dispatch.
  //  SITE_BOOKINGS: 'off' (default) | 'dry-run' (only logs what it would send) | 'on'
  //  SITE_API_URL: the website API base including /api/v1, for example https://your-site-api.up.railway.app/api/v1
  //  SITE_SERVICE_KEY: the key the website backend gave the bot (it sends it as x-service-key). Keep it secret.
  SITE_BOOKINGS: required('SITE_BOOKINGS', 'off'),
  SITE_API_URL: required('SITE_API_URL', ''),
  SITE_SERVICE_KEY: required('SITE_SERVICE_KEY', ''),

  // Cancelling on WhatsApp also cancels the website booking, using the WEBSITE's real fee and refund ('off' default | 'on').
  // Needs SITE_API_URL and SITE_SERVICE_KEY like SITE_BOOKINGS. Only bookings that reached the website are affected.
  SITE_CANCEL: required('SITE_CANCEL', 'off'),
  // Every 5 minutes the bot reads the website's bookings table (SELECT only) so My Booking and the reminders follow what
  // the website team does: cancelled by them, driver and car assigned, completed. 'off' default | 'on'.
  SITE_SYNC: required('SITE_SYNC', 'off'),

  // Writing the bot's own columns (bookings.bot_*, customers.bot_*) on the website's tables. Turn on ONLY after the website team
  // has run teammate-patch/bot-columns/migration.sql. 'off' (default) | 'on'.
  SITE_COLUMNS: required('SITE_COLUMNS', 'off'),

  // Where the vehicles and rates come from. 'bot' (default) = the bot's own vehicles. 'website' = the ABHI CABS website's
  // tables (read only), so a price changed in the website admin shows up in the bot by itself.
  RATES_SOURCE: required('RATES_SOURCE', 'bot'),
  SITE_CITY_ID: Number(required('SITE_CITY_ID', '1')),

  // Vehicles: 'once' (default) loads the ABHI CABS fleet the first time the bot starts and switches the old ones off;
  // 'always' reloads it at every start (resets any price edited in the database); 'off' never touches the vehicles.
  FLEET_SYNC: required('FLEET_SYNC', 'once'),

  // Fare rules, matched to the ABHI CABS backend rate card:
  //  - FARE_TAX_PERCENT: tax added to a retail fare. The backend adds GST (18%, exclusive) to CORPORATE bookings only,
  //    so a WhatsApp (retail) fare has none: 0. Put 5 to bring back the old flat 5%.
  //  - ROUND_TRIP_MIN_KM_PER_DAY: a round trip is billed for at least this many km for each day away (backend: 300).
  FARE_TAX_PERCENT: Number(required('FARE_TAX_PERCENT', '0')),
  ROUND_TRIP_MIN_KM_PER_DAY: Number(required('ROUND_TRIP_MIN_KM_PER_DAY', '300')),

  // The calendar Flow sent as an approved TEMPLATE with a Flow button (MSG91's documented way). Use with DATE_PICKER=template.
  FLOW_TEMPLATE_NAME: required('FLOW_TEMPLATE_NAME', ''),
  FLOW_TEMPLATE_NAMESPACE: required('FLOW_TEMPLATE_NAMESPACE', ''),
  FLOW_TEMPLATE_LANGUAGE: required('FLOW_TEMPLATE_LANGUAGE', 'en'),

  // true (default) = the pickup and drop questions ARE the "Send location" button: one tap opens WhatsApp's own
  // location screen (current location, search bar, Choose on map). false = the Current location / Search place buttons.
  LOCATION_ONE_TAP: required('LOCATION_ONE_TAP', 'true') !== 'false',

  // The pickup question opens one map page with a Pickup and a Drop field (suggestions show the km), like Uber.
  // "auto" (default) = on when the server address is known; "off" = the Send location screen / buttons instead.
  ROUTE_PAGE: required('ROUTE_PAGE', 'auto'),

  // The website link added to the end of every bot message. WEBSITE_LINKS=false turns it off.
  // Per-step links go in src/config/stepLinks.js.
  WEBSITE_URL: required('WEBSITE_URL', 'https://www.abhicabs24x7.com/'),
  WEBSITE_LINKS: required('WEBSITE_LINKS', 'true') !== 'false',

  // Trip reminders 1 hour and 30 minutes before the pickup (CONFIRMED bookings). Free text works only within
  // 24 hours of the customer's last message; otherwise these approved TEMPLATES (no variables) are used.
  REMINDERS_ENABLED: required('REMINDERS_ENABLED', 'true') !== 'false',
  REMINDER_1H_TEMPLATE: required('REMINDER_1H_TEMPLATE', ''),
  REMINDER_30M_TEMPLATE: required('REMINDER_30M_TEMPLATE', ''),
  REMINDER_TEMPLATE_NAMESPACE: required('REMINDER_TEMPLATE_NAMESPACE', ''),

  // If the fare lookup finishes within this many milliseconds, the bot sends ONE message ("saved" line + the vehicle list)
  // instead of "Checking available vehicles..." followed by the list. Two quick messages can arrive in the wrong order.
  // 0 = always send the separate "Checking..." message first.
  VEHICLES_FAST_MS: Number(required('VEHICLES_FAST_MS', '1500')),

  // After the pickup and drop page the chat says only "Pickup and drop saved". true = it also repeats the place names.
  ECHO_PLACE_NAMES: required('ECHO_PLACE_NAMES', 'false') === 'true',

  // The extra "Can't see the button? Just type ..." lines after a button. OFF by default (fewer messages); true = send them.
  DATE_TYPE_HINT: required('DATE_TYPE_HINT', 'false') === 'true',

  // The calendar page opens from a BUTTON ("Pick date and time") instead of a link in the text. false = a plain link.
  LINK_AS_BUTTON: required('LINK_AS_BUTTON', 'true') !== 'false',

  // The date step:
  //   "auto" (default) = the calendar page (opened from a "Pick date and time" button) when the server address is known, else "taps";
  //   "link" = always the calendar page;  "template" = the Flow template (needs FLOW_TEMPLATE_NAME);  "flow" = the WhatsApp Flow (needs DATE_FLOW_ID);  "taps" = month, week, day lists;
  // "taps" = tap month, week, day in lists; "text" = text calendar, type the day number.
  DATE_PICKER: required('DATE_PICKER', 'auto'),

  // Show a small map card of the place the customer picks from the search results (false = off).
  PLACE_MAP_CARD: required('PLACE_MAP_CARD', 'true') !== 'false',

  // Optional "lat,lng" the place search leans towards when there is no pickup yet (e.g. 12.9716,77.5946).
  PLACE_SEARCH_NEAR: required('PLACE_SEARCH_NEAR', ''),

  // The pickup question shows WhatsApp's "Send location" button (current location).
  // Set LOCATION_REQUEST_BUTTON=false to fall back to a plain typed question.
  LOCATION_REQUEST_BUTTON: required('LOCATION_REQUEST_BUTTON', 'true') !== 'false',

  // "Partial Payment" = this percentage of the fare, paid now. The rest is due later.
  // One rule for the advance: the backend's own setting, so the amount in the WhatsApp message is the amount the website would ask for.
  PARTIAL_PAYMENT_PERCENT: Number(require('../../config/env').payment.advancePercent) || 25,

  // Shown to customers under "Contact Us".
  SUPPORT_PHONE: required('SUPPORT_PHONE', '+91 80960 00182'),

  SESSION_TIMEOUT_MINUTES: parseInt(required('SESSION_TIMEOUT_MINUTES', '30'), 10),
  ABANDONED_BOOKING_FOLLOWUP_MINUTES: parseInt(
    required('ABANDONED_BOOKING_FOLLOWUP_MINUTES', '45'),
    10
  ),

  REDIS_URL: required('REDIS_URL'),
  ADMIN_API_KEY: required('ADMIN_API_KEY'), // no default: an unset key disables the admin API

  TIMEZONE: 'Asia/Kolkata',
};

// Fail fast in production if critical secrets are missing.
if (env.NODE_ENV === 'production') {
  // The bot now runs INSIDE the website backend, so a missing WhatsApp setting must never stop the whole website.
  // It is reported loudly in the log and the bot simply cannot send until the value is added.
  const criticalForProd = env.WHATSAPP_PROVIDER === 'meta'
    ? ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_APP_SECRET', 'DATABASE_URL']
    : ['MSG91_AUTH_KEY', 'MSG91_INTEGRATED_NUMBER', 'DATABASE_URL'];
  const missing = criticalForProd.filter((k) => !(env[k] || process.env[k]));
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`[bot] WARNING: missing WhatsApp settings: ${missing.join(', ')}. The WhatsApp bot will not work until they are set.`);
  }
}

module.exports = env;
