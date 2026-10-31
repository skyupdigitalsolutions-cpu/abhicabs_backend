/**
 * Reads a small count from a customer's reply: "3", "three", "Three members", "two persons", "twenty five",
 * and the common Hindi / Kannada words (do, teen, eradu, mooru ...). Returns 0 when the reply is not a clear number,
 * so the bot asks again. Any unknown word makes it 0: "what do you mean" is NOT read as 2.
 */
const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  single: 1, alone: 1, myself: 1, couple: 2, pair: 2,
  // Hindi
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chah: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15,
  // Kannada
  ondu: 1, eradu: 2, mooru: 3, nalku: 4, aidu: 5, aaru: 6, elu: 7, entu: 8, ombattu: 9, hattu: 10,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
const FILLER = new Set([
  'member', 'members', 'person', 'persons', 'people', 'passenger', 'passengers', 'pax', 'adult', 'adults', 'seat', 'seats', 'only',
  'we', 'are', 'is', 'its', 'it', 'there', 'will', 'be', 'total', 'for', 'of', 'the', 'and', 'including', 'me', 'with', 'us', 'pls',
  'please', 'ok', 'okay', 'nos', 'no', 'number', 'count', 'just', 'a', 'i', 'am', 'im', 'in', 'all', 'persons', 'log', 'jana', 'jan',
]);

function parseCount(text) {
  const raw = String(text || '').toLowerCase();
  const digits = raw.match(/\d+/);
  if (digits) return parseInt(digits[0], 10);

  const tokens = raw.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const numbers = [];
  for (const tok of tokens) {
    if (tok in TENS) numbers.push({ v: TENS[tok], tens: true });
    else if (tok in ONES) numbers.push({ v: ONES[tok], tens: false });
    else if (/^(twenty|thirty|forty|fifty|sixty)(one|two|three|four|five|six|seven|eight|nine)$/.test(tok)) {
      const m = /^(twenty|thirty|forty|fifty|sixty)(.+)$/.exec(tok);
      numbers.push({ v: TENS[m[1]] + ONES[m[2]], tens: false });
    } else if (!FILLER.has(tok)) return 0; // an unknown word: not a clear number
  }
  if (numbers.length === 1) return numbers[0].v;
  if (numbers.length === 2 && numbers[0].tens && !numbers[1].tens && numbers[1].v >= 1 && numbers[1].v <= 9) return numbers[0].v + numbers[1].v;
  return 0;
}

module.exports = { parseCount };
