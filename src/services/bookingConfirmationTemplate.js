'use strict';

/**
 * src/services/bookingConfirmationTemplate.js
 *
 * The booking confirmation, as HTML and as plain text.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LEFT email.service.js
 * ---------------------------------------------------------------------------
 * The confirmation used to be a two-table inline template inside the send
 * function. It is now a sectioned document — booking details, a line-by-line
 * fare breakdown, payment, the extras that can still move the number, and the
 * terms those extras are governed by — which is more layout than a send
 * function should carry. Same split, same reasons, as invoiceTemplate.js.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER COMES FROM THE FROZEN QUOTE
 * ---------------------------------------------------------------------------
 * booking.fareBasis.components is the quote the rider agreed to, frozen at
 * create time by booking.service. Its `breakdown` array is already a list of
 * {label, amount} rows written by fare.service — the same rows the fare screen
 * showed. This template RENDERS that array rather than recomputing anything:
 * a confirmation that disagrees with the quote screen is worse than no
 * confirmation.
 *
 * The same goes for the terms. The extra-distance rate, the night window, the
 * driver allowance and a rental package's included hours and overage rates are
 * all read from `components.configSnapshot` and `components.meta` — the values
 * actually applied to THIS booking. A term quoting a rate card that has since
 * been edited is a term we cannot stand behind in a dispute.
 *
 * Anything not present in the snapshot is OMITTED. An empty section beats an
 * invented figure.
 *
 * ---------------------------------------------------------------------------
 * CONSTRAINTS
 * ---------------------------------------------------------------------------
 * Inline styles, table layout, no external images or fonts — Gmail strips
 * <style> blocks, Outlook ignores flexbox, and a remote logo is blocked by
 * default in most clients. Section headers use the brand amber with dark ink
 * on top; amber with white text is unreadable, which is why the dark-ink logo
 * variant exists.
 */

const AMBER = '#FFC007';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e9eaee';
const PANEL = '#f7f7f9';

/**
 * Support contact printed in the footer.
 *
 * DUPLICATED FROM THE APP's src/config/company.ts, which is a drift risk and
 * is called out there too. The right home for these is the gst_config row the
 * invoice already snapshots its seller block from; until that exists, a change
 * here has to be mirrored in the app. `seller` on the call overrides all of it.
 */
const SUPPORT = {
  email: 'contact@abhicab.com',
  phone: '+91 80960 00182',
  phoneAlt: '+91 80960 00183',
  website: 'abhicabs24x7.com',
};

const TRIP_TYPE_LABEL = {
  ONE_WAY: 'One way',
  ROUND_TRIP: 'Round trip',
  HOURLY: 'Local rental',
  AIRPORT: 'Airport transfer',
};

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "14526" -> "₹14,526.00". Null for anything unparseable, so callers can omit. */
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Bare number, for inline use in a sentence: "₹15.00/km". */
function rate(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "7:00 am, 12 Oct 2026" in IST. Workers run in UTC. */
function istDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const date = d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return `${time}, ${date}`;
}

/** "14 Oct 2026" — a return date has no meaningful time of day at booking. */
function istDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** "SEDAN" -> "Sedan". Vehicle classes are stored upper-snake. */
function classLabel(v) {
  if (!v) return null;
  return String(v)
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/**
 * Everything the two renderers need, derived once.
 *
 * Both the HTML and the text version are built from this, so they cannot say
 * different things — which is exactly what happened the last time the fare
 * summary was written twice.
 */
function model({ booking = {}, name, seller }) {
  const fareBasis = booking.fareBasis || {};
  const quote = fareBasis.components || {};
  const meta = quote.meta || {};
  const snap = quote.configSnapshot || {};

  const support = { ...SUPPORT, ...(seller || {}) };

  // finalFare only exists once the trip is settled. At confirmation the number
  // is the frozen quote, and the copy has to say so.
  const isFinal = booking.finalFare != null;
  const total = money(booking.finalFare ?? booking.estimatedFare);

  const discount = fareBasis.discount || null;
  const payLater = booking.paymentMode === 'ZERO';
  const advanceNum = Number(booking.advancePaid ?? 0);

  /* ---- route ---- */

  const stops = Array.isArray(booking.stops) ? booking.stops : [];
  const stopNames = stops.map((s) => s && s.address).filter(Boolean);

  /* ---- booking rows ---- */

  const bookingRows = [
    ['Booking ID', booking.bookingNumber],
    ['Trip Type', TRIP_TYPE_LABEL[booking.tripType] || booking.tripType],
    ['Pickup Location', booking.pickupAddress],
    stopNames.length ? ['Via', stopNames.join(' → ')] : null,
    booking.dropAddress ? ['Drop Location', booking.dropAddress] : null,
    ['Pickup Time', istDateTime(booking.pickupAt)],
    booking.returnAt ? ['Return Date', istDate(booking.returnAt)] : null,
    booking.distanceKm != null ? ['Distance', `${booking.distanceKm} km`] : null,
    meta.packageLabel ? ['Package', meta.packageLabel] : null,
    ['Car Type', classLabel(booking.vehicleClass)],
    booking.guestName ? ['Traveller', booking.guestName] : null,
    booking.guestPhone ? ['Traveller Phone', booking.guestPhone] : null,
    booking.specialRequests ? ['Special Requests', booking.specialRequests] : null,
  ].filter((r) => r && r[1]);

  /* ---- billing rows ---- */

  // fare.service already labelled every component. Render its array rather
  // than re-deriving: it is the same list the rider saw on the fare screen.
  const lines = Array.isArray(quote.breakdown)
    ? quote.breakdown
        .map((b) => ({ label: b.label, amount: money(b.amount), note: b.note || null }))
        .filter((b) => b.label && b.amount)
    : [];

  // `total` on the booking is NET of the promo; grossTotal is what the card
  // produced. Showing both answers "why is this less than my screenshot".
  const discountRow = discount
    ? {
        label: discount.code ? `Discount (${discount.code})` : 'Discount',
        amount: money(discount.amount) ? `− ${money(discount.amount)}` : null,
        note: discount.description || null,
      }
    : null;

  /* ---- payment ---- */

  let paymentLine;
  if (payLater) {
    paymentLine = total
      ? `Pay ${total} to the driver at the end of the trip, plus any extras below.`
      : 'Payable to the driver at the end of the trip.';
  } else if (advanceNum > 0) {
    const paid = money(booking.advancePaid);
    const due = money(booking.balanceDue);
    paymentLine = due
      ? `${paid} paid in advance. ${due} is due at the end of the trip, plus any extras below.`
      : `${paid} paid in advance.`;
  } else {
    paymentLine = total ? `${total} payable for this booking.` : 'Payment pending.';
  }

  /* ---- extras ---- */

  // Only what this booking's own frozen snapshot can justify.
  const extras = [];

  const perKm = rate(snap.perKm);
  const billableKm = meta.billableKm || booking.distanceKm;
  if (perKm && billableKm && !meta.rental) {
    extras.push(
      `Distance beyond the booked ${billableKm} km is charged at ${perKm}/km.`,
    );
  }

  if (meta.rental) {
    const extraHr = rate(snap.rentalExtraPerHour) || rate(snap.hourlyRate);
    const extraKmRate = rate(snap.rentalExtraPerKm) || rate(snap.perKm);
    if (meta.includedHours && meta.includedKm) {
      extras.push(
        `This package covers ${meta.includedHours} hours and ${meta.includedKm} km.`,
      );
    }
    if (extraHr) extras.push(`Each additional hour is charged at ${extraHr}.`);
    if (extraKmRate) extras.push(`Each additional kilometre is charged at ${extraKmRate}.`);
  }

  const nightAllowance = rate(snap.nightAllowance);
  const nightWindow = snap.nightWindow || meta.nightWindow;
  if (nightAllowance && nightWindow && !meta.allowancesExempt && !meta.isNight) {
    extras.push(
      `Driving between ${nightWindow} attracts a night allowance of ${nightAllowance} per night.`,
    );
  }

  extras.push(
    'Tolls, parking charges, state permits and entry fees are paid at actuals and are not included in the fare above.',
  );

  if (booking.tripType !== 'AIRPORT') {
    extras.push('Airport entry charges, where applicable, are not included and are charged extra.');
  }

  /* ---- terms ---- */

  // Written from how this booking was actually priced. Nothing here states a
  // rule the frozen snapshot does not support.
  const terms = [];

  if (meta.usedMinimumKmGuarantee && meta.minimumKm) {
    terms.push(
      `This fare is billed on a minimum of ${meta.minimumKm} km, which is more than the road distance for this route.`,
    );
  }

  if (!isFinal) {
    terms.push(
      'The amount above is the fare quoted when you booked. Extras listed above, and any distance or hours beyond what the booking covers, are settled at the end of the trip. Your invoice will carry the final amount.',
    );
  }

  if (Number(quote.surgeAmount ?? 0) > 0 && meta.surgeMultiplier) {
    terms.push(
      `Demand pricing of ${meta.surgeMultiplier}x applied to this booking and is already included in the total.`,
    );
  }

  terms.push(
    'Cancellation is free up to a point, after which a fee applies. The app shows the exact fee before you confirm a cancellation.',
    'Your driver will need periodic tea and meal breaks, which you can coordinate directly with them.',
    'You can suggest a route, though the driver will take the one best suited to conditions on the day.',
    'Please check you have all your belongings before the driver leaves.',
    'Raise any query about this booking with us within 24 hours of your invoice.',
  );

  if (booking.tripType === 'ROUND_TRIP') {
    terms.push(
      'Please make sure every city you plan to visit is in your itinerary — adding one mid-trip may not be possible.',
    );
  }

  return {
    greeting: name ? `Hi ${name},` : 'Hi,',
    bookingNumber: booking.bookingNumber || '',
    isFinal,
    total,
    bookingRows,
    lines,
    discountRow,
    paymentLine,
    extras,
    terms,
    support,
  };
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

function sectionHeader(title) {
  return `<tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0;">
      <tr><td style="background:${AMBER};padding:10px 16px;font-size:15px;font-weight:700;color:${INK};border-radius:6px 6px 0 0;">${esc(title)}</td></tr>
    </table>
  </td></tr>`;
}

function detailRows(rows) {
  return rows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:9px 16px;font-size:13px;color:${MUTED};vertical-align:top;width:38%;border-bottom:1px solid ${RULE};">${esc(k)}</td>
        <td style="padding:9px 16px;font-size:13px;color:${INK};vertical-align:top;border-bottom:1px solid ${RULE};">${esc(v)}</td>
      </tr>`,
    )
    .join('');
}

function bulletList(items) {
  return items
    .map(
      (t) => `<tr><td style="padding:0 16px 8px;font-size:13px;color:${INK};line-height:1.55;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="padding:0 8px 0 0;font-size:13px;color:${MUTED};vertical-align:top;">&bull;</td>
          <td style="font-size:13px;color:${INK};line-height:1.55;">${esc(t)}</td>
        </tr></table>
      </td></tr>`,
    )
    .join('');
}

function buildBookingConfirmationHtml({ booking, name, seller, brand = 'AbhiCabs' }) {
  const m = model({ booking, name, seller });

  const fareLines = m.lines
    .map(
      (l) => `<tr>
        <td style="padding:8px 16px;font-size:13px;color:${INK};border-bottom:1px solid ${RULE};">
          ${esc(l.label)}${l.note ? `<div style="font-size:11px;color:${MUTED};margin-top:2px;">${esc(l.note)}</div>` : ''}
        </td>
        <td style="padding:8px 16px;font-size:13px;color:${INK};text-align:right;white-space:nowrap;border-bottom:1px solid ${RULE};">${esc(l.amount)}</td>
      </tr>`,
    )
    .join('');

  const discountLine = m.discountRow && m.discountRow.amount
    ? `<tr>
        <td style="padding:8px 16px;font-size:13px;color:${INK};border-bottom:1px solid ${RULE};">${esc(m.discountRow.label)}</td>
        <td style="padding:8px 16px;font-size:13px;color:${INK};text-align:right;white-space:nowrap;border-bottom:1px solid ${RULE};">${esc(m.discountRow.amount)}</td>
      </tr>`
    : '';

  const totalLine = m.total
    ? `<tr>
        <td style="padding:12px 16px;font-size:14px;font-weight:700;color:${INK};background:${PANEL};">
          ${m.isFinal ? 'Total Amount' : 'Estimated Total'}
          <div style="font-size:11px;font-weight:400;color:${MUTED};margin-top:2px;">Inclusive of taxes</div>
        </td>
        <td style="padding:12px 16px;font-size:16px;font-weight:700;color:${INK};text-align:right;white-space:nowrap;background:${PANEL};">${esc(m.total)}</td>
      </tr>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">

      <tr><td style="padding:28px 16px 4px;">
        <p style="margin:0 0 6px;font-size:14px;color:${MUTED};">${esc(m.greeting)}</p>
        <p style="margin:0;font-size:21px;font-weight:700;color:${INK};">Your booking is confirmed</p>
        <p style="margin:6px 0 0;font-size:13px;color:${MUTED};">
          We will share your driver and vehicle details before pickup.
        </p>
      </td></tr>

      ${sectionHeader('Booking Details')}
      <tr><td style="padding:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows(m.bookingRows)}</table>
      </td></tr>

      ${sectionHeader('Billing Details')}
      <tr><td style="padding:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${fareLines}
          ${discountLine}
          ${totalLine}
        </table>
      </td></tr>

      <tr><td style="padding:14px 16px 0;">
        <p style="margin:0;font-size:13px;color:${INK};line-height:1.55;">
          <strong style="font-weight:600;">Payment:</strong> ${esc(m.paymentLine)}
        </p>
      </td></tr>

      ${sectionHeader('Extra Charges, if applicable')}
      <tr><td style="padding:12px 0 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bulletList(m.extras)}</table>
      </td></tr>

      ${sectionHeader('Important Terms')}
      <tr><td style="padding:12px 0 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bulletList(m.terms)}</table>
      </td></tr>

      <tr><td style="padding:20px 16px 28px;">
        <div style="height:1px;background:${RULE};margin:0 0 16px;"></div>
        <p style="margin:0 0 6px;font-size:13px;color:${INK};">
          You can view this booking any time in the ${esc(brand)} app.
        </p>
        <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.6;">
          Questions? Call ${esc(m.support.phone)}${m.support.phoneAlt ? ` or ${esc(m.support.phoneAlt)}` : ''}<br>
          Email ${esc(m.support.email)} &nbsp;&middot;&nbsp; ${esc(m.support.website)}
        </p>
      </td></tr>

    </table>
    <p style="max-width:600px;margin:14px auto 0;font-size:11px;color:#9a9a9a;text-align:center;">${esc(brand)}</p>
  </body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

function buildBookingConfirmationText({ booking, name, seller, brand = 'AbhiCabs' }) {
  const m = model({ booking, name, seller });
  const out = [];

  out.push(m.greeting, '', `Your booking ${m.bookingNumber} is confirmed.`, '');

  out.push('BOOKING DETAILS');
  m.bookingRows.forEach(([k, v]) => out.push(`  ${k}: ${v}`));
  out.push('');

  out.push('BILLING DETAILS');
  m.lines.forEach((l) => out.push(`  ${l.label}: ${l.amount}`));
  if (m.discountRow && m.discountRow.amount) {
    out.push(`  ${m.discountRow.label}: ${m.discountRow.amount}`);
  }
  if (m.total) out.push(`  ${m.isFinal ? 'Total Amount' : 'Estimated Total'}: ${m.total} (inclusive of taxes)`);
  out.push('');

  out.push(`Payment: ${m.paymentLine}`, '');

  out.push('EXTRA CHARGES, IF APPLICABLE');
  m.extras.forEach((t) => out.push(`  - ${t}`));
  out.push('');

  out.push('IMPORTANT TERMS');
  m.terms.forEach((t) => out.push(`  - ${t}`));
  out.push('');

  out.push(
    `You can view this booking any time in the ${brand} app.`,
    '',
    `Questions? Call ${m.support.phone}${m.support.phoneAlt ? ` or ${m.support.phoneAlt}` : ''}`,
    `Email ${m.support.email} | ${m.support.website}`,
    '',
    `— ${brand}`,
  );

  return out.join('\n');
}

module.exports = {
  buildBookingConfirmationHtml,
  buildBookingConfirmationText,
};