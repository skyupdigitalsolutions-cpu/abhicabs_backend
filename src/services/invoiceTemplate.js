'use strict';

/**
 * src/services/invoiceTemplate.js
 *
 * The invoice, as HTML. One template, three destinations.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER OWNS THIS
 * ---------------------------------------------------------------------------
 * The invoice used to be built in the app (features/trip/invoiceDocument.ts),
 * which meant the document a rider downloaded and the document we could email
 * them were two different pieces of code that would drift the first time either
 * was touched. Worse, an invoice is a tax record: what it says must not depend
 * on which version of an app happened to render it.
 *
 * ---------------------------------------------------------------------------
 * WHY HTML AND NOT A PDF
 * ---------------------------------------------------------------------------
 * Generating a PDF on the server needs a headless browser — Puppeteer is about
 * 300MB of Chromium and a real memory cost on every render, on a container
 * already running the API.
 *
 * HTML avoids all of it and loses nothing:
 *   - EMAIL embeds this markup inline, which is what email clients want anyway;
 *     a PDF attachment is often blocked and never previews.
 *   - THE APP fetches the same markup and renders it to PDF locally with
 *     expo-print, which is a system service already on the phone.
 *
 * So the layout lives in one place and the pixels come out identical.
 *
 * ---------------------------------------------------------------------------
 * CONSTRAINTS THIS IS WRITTEN TO
 * ---------------------------------------------------------------------------
 * Every style is INLINE and the layout is TABLE-BASED. That is not how one
 * writes a web page in 2026; it is how one writes an email. Gmail strips
 * <style> blocks, Outlook ignores flexbox and grid, and a float-based layout
 * collapses in both. Tables with inline styles are the only thing that renders
 * the same in an inbox, in expo-print, and in a browser.
 *
 * No external images or fonts either: a remote logo is blocked by default in
 * most clients and would leave a hole where the brand should be.
 */

/** HTML-escape. Every interpolated value goes through this. */
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "64262" -> "64,262.00". Indian grouping, always two decimals. */
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "30/09/2026" — the format on the reference invoice. */
function dmy(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

/** "30/09/2026, 6:05 pm" for the trip start, which needs a time. */
function dmyTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${dmy(dt)}, ${dt.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  })}`;
}

/**
 * An em dash, never an empty cell.
 *
 * The reference invoice shows "—" against every trip field, which is what an
 * unpopulated template looks like. Keeping the dash as the explicit fallback
 * makes a missing value obvious rather than leaving a blank that reads as a
 * rendering fault.
 */
const DASH = '—';
const or = (v) => (v == null || v === '' ? DASH : esc(v));

/** Human labels for the trip type codes. */
const TRIP_TYPE = {
  ONE_WAY: 'One way',
  ROUND_TRIP: 'Round trip',
  AIRPORT: 'Airport transfer',
  HOURLY: 'Local rental',
};

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

const GREY = '#58595b';
const LINE = '#d9d9d9';
const INK = '#1a1a1a';

/** The dark bar that heads each section. */
function sectionBar(left, right) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GREY};">
    <tr>
      <td style="padding:9px 14px;font:700 11px/1.2 Arial,Helvetica,sans-serif;color:#fff;letter-spacing:.09em;">${esc(left)}</td>
      ${right
        ? `<td align="right" style="padding:9px 14px;font:700 11px/1.2 Arial,Helvetica,sans-serif;color:#fff;letter-spacing:.09em;">${esc(right)}</td>`
        : ''}
    </tr>
  </table>`;
}

/** "Label : value" row inside the trip block. */
function tripRow(label, value) {
  return `
  <tr>
    <td style="padding:4px 0;font:700 12px/1.5 Arial,Helvetica,sans-serif;color:${INK};width:110px;">${esc(label)}</td>
    <td style="padding:4px 0;font:400 12px/1.5 Arial,Helvetica,sans-serif;color:${INK};">: ${value}</td>
  </tr>`;
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/**
 * Render one invoice.
 *
 * `invoice` and `booking` are the rows as stored, so this can be called from
 * the email job and from the app's download endpoint with the same arguments
 * and produce the same bytes.
 */
function buildInvoiceHtml({ invoice, booking, customer, seller }) {
  const isTax = invoice?.type === 'TAX';
  const title = isTax ? 'TAX INVOICE' : 'INVOICE';
  const subtitle = isTax ? 'Tax Invoice' : 'Bill of Supply';

  const total = money(invoice?.totalAmount ?? booking?.finalFare ?? booking?.estimatedFare ?? 0);
  const fare = money(invoice?.subtotal ?? booking?.finalFare ?? booking?.estimatedFare ?? 0);

  const cgst = Number(invoice?.cgst ?? 0);
  const sgst = Number(invoice?.sgst ?? 0);
  const igst = Number(invoice?.igst ?? 0);
  const hasTax = cgst > 0 || sgst > 0 || igst > 0;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(invoice?.invoiceNumber || 'Invoice')} — AbhiCabs</title>
</head>
<!-- Fixed 760px width, centred. A percentage width reflows unpredictably in
     Outlook and in print; a fixed one prints the same on A4 every time. -->
<body style="margin:0;padding:24px 12px;background:#ffffff;">
<table role="presentation" width="760" align="center" cellpadding="0" cellspacing="0" style="width:760px;max-width:100%;margin:0 auto;">

  <!-- Title, between two heavy rules -->
  <tr><td style="border-top:3px solid ${INK};"></td></tr>
  <tr>
    <td align="center" style="padding:18px 0 6px;">
      <div style="font:700 26px/1.1 Arial,Helvetica,sans-serif;color:${INK};letter-spacing:.06em;">${esc(title)}</div>
      <div style="font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#555;">${esc(subtitle)}</div>
    </td>
  </tr>
  <tr><td style="border-top:3px solid ${INK};"></td></tr>

  <!-- Brand row. Wordmark is TEXT, not an image: a remote logo is blocked by
       default in most email clients and would leave a hole exactly where the
       brand should be. -->
  <tr>
    <td style="padding:18px 0 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font:700 30px/1 Arial,Helvetica,sans-serif;color:${INK};letter-spacing:.02em;">
              <span style="color:#F5B301;">A</span>BHI<span style="color:#F5B301;">CABS</span>
            </div>
            <div style="font:400 8px/1.6 Arial,Helvetica,sans-serif;color:#8a8a8a;letter-spacing:.42em;">RIDE WITH TRUST</div>
          </td>
          <td align="right" style="font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#444;">
            ${or(seller?.address || 'Bengaluru, Karnataka, India')}
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td style="border-top:1px solid ${LINE};"></td></tr>

  <!-- CUSTOMER DETAILS -->
  <tr><td style="padding-top:16px;">${sectionBar('CUSTOMER DETAILS')}</td></tr>
  <tr>
    <td style="border:1px solid ${LINE};border-top:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="58%" style="padding:14px 16px;border-right:1px solid ${LINE};font:400 12px/1.9 Arial,Helvetica,sans-serif;color:${INK};" valign="top">
            Name : <b>${or(customer?.name)}</b><br>
            Email : <b>${or(customer?.email)}</b><br>
            Phone : <b>${or(customer?.phone)}</b><br>
            State : <b>${or(invoice?.placeOfSupply)}</b>
          </td>
          <td style="padding:14px 16px;font:400 12px/1.9 Arial,Helvetica,sans-serif;color:${INK};" valign="top">
            Invoice# : <b>${or(invoice?.invoiceNumber)}</b><br>
            Billed on : <b>${dmy(invoice?.issuedAt || invoice?.createdAt)}</b><br>
            Booking ID : <b>${or(booking?.bookingNumber)}</b>
            ${seller?.gstin ? `<br>GSTIN : <b>${esc(seller.gstin)}</b>` : ''}
            ${invoice?.billToGstin ? `<br>Your GSTIN : <b>${esc(invoice.billToGstin)}</b>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- TRIP DETAILS + AMOUNT -->
  <tr><td style="padding-top:14px;">${sectionBar('TRIP DETAILS', 'AMOUNT')}</td></tr>
  <tr>
    <td style="border:1px solid ${LINE};border-top:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <td width="58%" style="padding:14px 16px;border-right:1px solid ${LINE};" valign="top">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${tripRow('Trip Type', or(TRIP_TYPE[booking?.tripType] || booking?.tripType))}
            ${tripRow('Vehicle', or(booking?.vehicleClass))}
            ${tripRow('Pick Up', or(booking?.pickupAddress))}
            ${tripRow('Drop', or(booking?.dropAddress))}
            ${tripRow('Start Date', dmyTime(booking?.pickupAt))}
            ${booking?.distanceKm ? tripRow('Distance', `${Math.round(booking.distanceKm)} km`) : ''}
          </table>
        </td>
        <td style="padding:14px 16px;" valign="top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:2px 0 8px;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:#444;">Trip Fare</td>
              <td align="right" style="padding:2px 0 8px;font:700 12px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Rs. ${fare}</td>
            </tr>
            ${
              hasTax
                ? `${
                    igst > 0
                      ? `<tr><td style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:#444;">IGST</td><td align="right" style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Rs. ${money(igst)}</td></tr>`
                      : `<tr><td style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:#444;">CGST</td><td align="right" style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Rs. ${money(cgst)}</td></tr>
                         <tr><td style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:#444;">SGST</td><td align="right" style="padding:2px 0;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Rs. ${money(sgst)}</td></tr>`
                  }`
                : ''
            }
            <tr><td colspan="2" style="border-top:1px solid ${INK};padding-top:8px;"></td></tr>
            <tr>
              <td style="font:700 14px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Total Amount</td>
              <td align="right" style="font:700 14px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Rs. ${total}</td>
            </tr>
          </table>
        </td>
      </table>
    </td>
  </tr>

  <tr>
    <td align="right" style="padding:22px 0 8px;font:400 12px/1.4 Arial,Helvetica,sans-serif;color:${INK};">
      For <b>Abhi Cabs</b>
    </td>
  </tr>

  <tr><td style="border-top:3px solid ${INK};"></td></tr>

  <!-- Terms -->
  <tr>
    <td style="padding:14px 0 0;">
      <div style="font:700 12px/1.6 Arial,Helvetica,sans-serif;color:${INK};">Terms &amp; Conditions</div>
      <div style="font:400 10.5px/1.75 Arial,Helvetica,sans-serif;color:#333;padding-top:8px;">
        # All road toll fees, Airport entry charges, parking charges, state taxes etc. are charged extra and need to be paid to the concerned authorities as per actuals. Please collect the receipts for these directly from the authorities or the driver wherever applicable.
      </div>
      <div style="font:400 10.5px/1.75 Arial,Helvetica,sans-serif;color:#333;padding-top:8px;">
        At the end of the trip, please check and take all your belongings with you.
      </div>
      <div style="font:400 10.5px/1.75 Arial,Helvetica,sans-serif;color:#333;padding-top:8px;">
        Any discrepancies regarding bill amount will be considered within 24 hrs of Invoice.
      </div>
      <div style="font:400 10.5px/1.75 Arial,Helvetica,sans-serif;color:#333;padding-top:20px;">
        This is an electronically generated invoice and does not require signature. All disputes are subject to jurisdiction of courts in Bangalore. For any queries, please write to us at <b>${esc(seller?.supportEmail || 'support@abhicabs.in')}</b>
      </div>
    </td>
  </tr>

  <tr><td style="border-top:1px solid ${LINE};padding-top:12px;"></td></tr>
  <tr>
    <td style="font:400 10px/1.6 Arial,Helvetica,sans-serif;color:#8a8a8a;padding-bottom:8px;">
      Service: Transport of passengers${invoice?.hsnSac ? ` · HSN/SAC ${esc(invoice.hsnSac)}` : ''}
    </td>
  </tr>

</table>
</body>
</html>`;
}

/**
 * The plain-text part of the email.
 *
 * Not optional: a message with an HTML body and no text alternative scores
 * badly with spam filters, and some clients show the text part instead.
 */
function buildInvoiceText({ invoice, booking }) {
  const total = money(invoice?.totalAmount ?? booking?.finalFare ?? 0);
  return [
    `AbhiCabs — ${invoice?.type === 'TAX' ? 'Tax Invoice' : 'Bill of Supply'}`,
    '',
    `Invoice#   ${invoice?.invoiceNumber ?? '—'}`,
    `Booking    ${booking?.bookingNumber ?? '—'}`,
    `Billed on  ${dmy(invoice?.issuedAt || invoice?.createdAt)}`,
    '',
    `Trip       ${TRIP_TYPE[booking?.tripType] || booking?.tripType || '—'}`,
    `Pick up    ${booking?.pickupAddress ?? '—'}`,
    `Drop       ${booking?.dropAddress ?? '—'}`,
    '',
    `Total      Rs. ${total}`,
    '',
    'This is an electronically generated invoice and does not require a signature.',
  ].join('\n');
}

module.exports = { buildInvoiceHtml, buildInvoiceText };