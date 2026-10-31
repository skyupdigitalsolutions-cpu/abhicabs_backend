const { AVAILABLE_LANGUAGES, t } = require('../../utils/i18n');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { toNumbered, rememberOptions } = require('../numberedMenu');

async function promptLanguageSelection(ctx) {
  const items = AVAILABLE_LANGUAGES.map((l, i) => ({
    id: `LANG_${l.code}`,
    number: i + 1,
    label: l.label,
  }));
  const { rows, map } = toNumbered(items);

  await ctx.send.raw(t('en', 'welcome'));
  await ctx.send.listRaw(t('en', 'select_language'), 'Select', [{ title: 'Languages', rows }]);
  await rememberOptions(ctx.session, map);
}

async function handleLanguageSelection(ctx) {
  const { message, session } = ctx;

  const match = (message.interactiveId || '').match(/^LANG_(.+)$/);
  const code = match
    ? match[1]
    : AVAILABLE_LANGUAGES.find(
        (l) => l.label.toLowerCase() === (message.text || '').toLowerCase().trim()
      )?.code;

  if (!code || !AVAILABLE_LANGUAGES.some((l) => l.code === code)) {
    await promptLanguageSelection(ctx);
    return;
  }

  session.language = code;
  ctx.customer.preferredLanguage = code;
  await ctx.customer.save();
  await transition(session, STATES.MAIN_MENU);

  // Re-bind sender now that we know the language, then show the menu.
  const { renderMainMenu } = require('./mainMenu.handler');
  await renderMainMenu({ ...ctx, language: code });
}

module.exports = { promptLanguageSelection, handleLanguageSelection };
