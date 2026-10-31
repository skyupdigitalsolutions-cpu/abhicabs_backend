const { sendText, sendButtons, sendList, sendDocument, sendLocationRequest, sendFlow, sendLocation, sendCtaUrl, sendFlowTemplate } = require('../integrations/whatsapp/messageBuilder');
const { t } = require('../utils/i18n');
const { linkForState } = require('../config/stepLinks');

/**
 * Builds a small per-request "sender" bound to one customer + language,
 * so handlers can write `ctx.send.text('booking_created')` instead of
 * repeating the phone number and translation lookup everywhere.
 */
function makeSender(to, language, getState) {
  // The website link of the step the customer is on, added to the end of every message. A message that is
  // already very long (WhatsApp allows 1024 characters in a body) is left as it is.
  const withLink = (body) => {
    const link = linkForState(getState ? getState() : null);
    if (!link || typeof body !== 'string' || body.includes(link) || body.length + link.length + 4 > 1000) return body;
    return `${body}\n\n🌐 ${link}`;
  };

  return {
    raw: (body) => sendText(to, withLink(body)),
    text: (key, vars) => sendText(to, withLink(t(language, key, vars))),
    buttons: (bodyKey, buttons, opts) => sendButtons(to, withLink(t(language, bodyKey, opts?.vars)), buttons, opts),
    buttonsRaw: (body, buttons, opts) => sendButtons(to, withLink(body), buttons, opts),
    list: (bodyKey, buttonLabelKey, sections, opts) =>
      sendList(to, withLink(t(language, bodyKey, opts?.vars)), t(language, buttonLabelKey), sections, opts),
    listRaw: (body, buttonLabel, sections, opts) => sendList(to, withLink(body), buttonLabel, sections, opts),
    flowTemplateRaw: (opts) => sendFlowTemplate(to, opts),
    ctaUrlRaw: (opts) => sendCtaUrl(to, { ...opts, body: withLink(opts.body) }),
    locationCardRaw: (loc) => sendLocation(to, loc),
    flowRaw: (opts) => sendFlow(to, opts),
    locationRequestRaw: (body) => sendLocationRequest(to, withLink(body)),
    document: (link, filename, captionKey) => sendDocument(to, link, filename, captionKey ? t(language, captionKey) : undefined),
  };
}

module.exports = { makeSender };
