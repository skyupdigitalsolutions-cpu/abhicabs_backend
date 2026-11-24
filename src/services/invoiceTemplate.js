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
 * THE LAYOUT
 * ---------------------------------------------------------------------------
 * A bordered tax-invoice block in the conventional Indian format: wordmark
 * above, then one ruled box holding
 *
 *     ORIGINAL TAX INVOICE                      (centred banner)
 *     Company Details        |  Customer Details  (two columns)
 *     Trip Details                               (full width)
 *     Fare Details           Particulars | Rate | Amount
 *                            CGST / SGST / IGST
 *                            Total, Rounded Off, Final Amount
 *     Amount in words
 *     Terms & Conditions                         (numbered)
 *     computer-generated footer
 *
 * Every figure comes from the invoice row. Nothing here recalculates tax —
 * gst.service decided those numbers when the invoice was issued, and a
 * template that did its own arithmetic could print a total that disagrees with
 * what was charged and filed.
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
 * most clients and would leave a hole exactly where the brand should be, so
 * the wordmark is live text.
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

/** "2-Jun-25" — the short form used on the invoice header. */
function dmyShort(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dt.getDate()}-${MON[dt.getMonth()]}-${String(dt.getFullYear()).slice(-2)}`;
}

/** "30/09/2026, 6:05 pm" for the trip start, which needs a time. */
function dmyTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const date = `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
  return `${date}, ${dt.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  })}`;
}

/**
 * An em dash, never an empty cell.
 *
 * A blank cell on a ruled invoice reads as a rendering fault. An explicit dash
 * says "we have no value for this", which is the honest message.
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
 * Amount in words
 * ------------------------------------------------------------------ */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99. */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

/** 0–999. */
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return twoDigits(rest);
  return rest ? `${ONES[h]} Hundred ${twoDigits(rest)}` : `${ONES[h]} Hundred`;
}

/**
 * "25037.00" -> "Rupees Twenty Five Thousand Thirty Seven Only".
 *
 * Grouped the INDIAN way — thousand, lakh, crore — not in Western thousands.
 * An invoice reading "Twenty Five Thousand" where a reader expects lakhs is
 * the kind of error an auditor notices.
 *
 * Paise are included only when non-zero, which is how a rounded invoice should
 * read: "... Only", not "... and Zero Paise Only".
 */
function amountInWords(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DASH;

  const whole = Math.floor(n);
  const paise = Math.round((n - whole) * 100);

  if (whole === 0 && paise === 0) return 'Rupees Zero Only';

  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;

  const parts = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  let out = `Rupees ${parts.join(' ')}`;
  if (paise) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
}

/* ------------------------------------------------------------------ *
 * Palette and small building blocks
 * ------------------------------------------------------------------ */

const LINE = '#000000';
const INK = '#1a1a1a';
const GREY = '#444444';
const GOLD = '#F5B301';

/** "Label:  value" pair inside the two detail columns. */
function kv(label, value) {
  return `
  <tr>
    <td valign="top" style="padding:1px 10px 1px 0;font:700 9.5px/1.6 Arial,Helvetica,sans-serif;color:${INK};white-space:nowrap;">${esc(label)}</td>
    <td valign="top" style="padding:1px 0;font:400 9.5px/1.6 Arial,Helvetica,sans-serif;color:${INK};">${value}</td>
  </tr>`;
}

/** A row in the fare table: description, rate, amount. */
function fareRow(particulars, rate, amount, { bold = false, topRule = false } = {}) {
  const weight = bold ? 700 : 400;
  const rule = topRule ? `border-top:1px solid ${LINE};` : '';
  return `
  <tr>
    <td style="padding:5px 8px;${rule}font:${weight} 9.5px/1.5 Arial,Helvetica,sans-serif;color:${INK};border-right:1px solid ${LINE};">${particulars}</td>
    <td align="right" style="padding:5px 8px;${rule}font:${weight} 9.5px/1.5 Arial,Helvetica,sans-serif;color:${INK};border-right:1px solid ${LINE};width:120px;">${rate}</td>
    <td align="right" style="padding:5px 8px;${rule}font:${weight} 9.5px/1.5 Arial,Helvetica,sans-serif;color:${INK};width:130px;">${amount}</td>
  </tr>`;
}

/**
 * Terms, numbered.
 *
 * AbhiCabs' own wording. Each line states something the business actually does
 * — extras billed at actuals, a window for disputing the bill — so none of it
 * should be edited casually; it is what a rider can hold us to.
 */
const TERMS = [
  'Fare includes base rate, distance and time charges, and applicable taxes.',
  'Road tolls, airport entry fees, parking charges, state permits and waiting time are charged extra at actuals. Please collect receipts for these directly from the authority or the driver.',
  'Cancellations and no-shows may attract a fee as per the cancellation policy in force at the time of booking.',
  'Any discrepancy in the billed amount must be raised within 24 hours of the invoice date.',
  'Riders are responsible for their own belongings. Please check the vehicle for personal items at the end of the trip.',
  'Riders may be held responsible for any damage caused to the vehicle by their actions.',
  'Payment is due in full on completion of the trip unless the booking is prepaid or billed to a corporate account.',
  'Refunds are subject to the AbhiCabs refund policy. All disputes are subject to the jurisdiction of the courts of Bengaluru.',
];

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/**
 * Render one invoice.
 *
 * `invoice` and `booking` are the rows as stored, so this can be called from
 * the email job and from the app's download endpoint with the same arguments
 * and produce the same bytes.
 *
 * Seller identity is read from the INVOICE's own snapshot first and only then
 * from the live GST config. An invoice must render as it was issued, even
 * after the registration behind it changes.
 */
function buildInvoiceHtml({ invoice, booking, customer, seller }) {
  const isTax = invoice?.type === 'TAX';
  const title = isTax ? 'ORIGINAL TAX INVOICE' : 'BILL OF SUPPLY';

  const companyName = invoice?.sellerLegalName || seller?.legalName || 'AbhiCabs 24x7';
  const companyAddress = invoice?.sellerAddress || seller?.address || 'Bengaluru, Karnataka, India';
  const companyPhone = seller?.phone || null;
  const companyGstin = invoice?.sellerGstin || seller?.gstin || null;
  const placeOfSupply = invoice?.placeOfSupply || invoice?.sellerState || null;

  const cgst = Number(invoice?.cgst ?? 0);
  const sgst = Number(invoice?.sgst ?? 0);
  const igst = Number(invoice?.igst ?? 0);
  const hasTax = cgst > 0 || sgst > 0 || igst > 0;

  const taxable = Number(invoice?.taxableValue ?? invoice?.subtotal ?? booking?.finalFare ?? 0);
  const discount = Number(invoice?.discount ?? 0);

  /*
   * The stored totalAmount is the FINAL figure — it is what was charged and
   * what was filed. The exact sum is reconstructed from its parts so the
   * rounding adjustment can be shown explicitly, the way a tax invoice should.
   * The difference is derived, never the total: if these ever disagree, the
   * invoice still prints the amount that was actually taken.
   */
  const finalAmount = Number(invoice?.totalAmount ?? booking?.finalFare ?? 0);
  const exactTotal = taxable + cgst + sgst + igst;
  const roundOff = finalAmount - exactTotal;
  const showRoundOff = Math.abs(roundOff) >= 0.005;

  /* A split rate reads per-half (2.5% + 2.5%); IGST carries the whole rate. */
  const ratePct = Number(invoice?.gstRatePct ?? 0);
  const halfRate = ratePct ? (ratePct / 2).toFixed(2).replace(/\.00$/, '') : null;
  const fullRate = ratePct ? ratePct.toFixed(2).replace(/\.00$/, '') : null;

  const tripLabel = TRIP_TYPE[booking?.tripType] || booking?.tripType || null;

  const description = [
    tripLabel ? `${tripLabel} cab service` : 'Cab service',
    booking?.pickupAddress && booking?.dropAddress
      ? `from ${booking.pickupAddress} to ${booking.dropAddress}`
      : null,
    booking?.distanceKm ? `(${Math.round(booking.distanceKm)} km)` : null,
  ]
    .filter(Boolean)
    .join(' ');

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

  <!-- Wordmark, above the ruled block. TEXT, not an image: a remote logo is
       blocked by default in most email clients. -->
  <tr>
    <td align="center" style="padding:0 0 14px;">
      <div style="font:700 32px/1 Arial,Helvetica,sans-serif;color:${INK};letter-spacing:.02em;">
        <span style="color:${GOLD};">A</span>BHI<span style="color:${GOLD};">CABS</span>
      </div>
      <div style="font:400 8px/1.8 Arial,Helvetica,sans-serif;color:#8a8a8a;letter-spacing:.42em;">RIDE WITH TRUST</div>
    </td>
  </tr>

  <!-- Everything below sits inside one ruled box -->
  <tr>
    <td style="border:1px solid ${LINE};">

      <!-- Banner -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center" style="padding:6px 8px;border-bottom:1px solid ${LINE};font:700 10px/1.4 Arial,Helvetica,sans-serif;color:${INK};letter-spacing:.04em;">
            ${esc(title)}
          </td>
        </tr>
      </table>

      <!-- Company details | Customer details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="50%" valign="top" style="padding:12px 14px;border-right:1px solid ${LINE};border-bottom:1px solid ${LINE};">
            <div style="font:700 10px/1.6 Arial,Helvetica,sans-serif;color:${INK};padding-bottom:6px;">Company Details:</div>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${kv('Invoice No:', or(invoice?.invoiceNumber))}
              ${kv('Invoice Date:', dmyShort(invoice?.issuedAt || invoice?.createdAt))}
              ${kv('Company Name:', esc(companyName))}
              ${kv('Address:', esc(companyAddress).replace(/,\s*/g, ',<br>'))}
              ${companyPhone ? kv('Phone:', esc(companyPhone)) : ''}
              ${companyGstin ? kv('GSTIN No:', esc(companyGstin)) : ''}
              ${placeOfSupply ? kv('Place of Supply:', esc(placeOfSupply)) : ''}
            </table>
          </td>
          <td width="50%" valign="top" style="padding:12px 14px;border-bottom:1px solid ${LINE};">
            <div style="font:700 10px/1.6 Arial,Helvetica,sans-serif;color:${INK};padding-bottom:6px;">Customer Details:</div>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${kv('Customer Name:', or(customer?.name || invoice?.billToName))}
              ${kv('Phone:', or(customer?.phone))}
              ${kv('Email ID:', or(customer?.email))}
              ${invoice?.billToAddress ? kv('Address:', esc(invoice.billToAddress).replace(/,\s*/g, ',<br>')) : ''}
              ${kv('Cab Type:', or(booking?.vehicleClass))}
              ${tripLabel ? kv('Package:', esc(tripLabel)) : ''}
              ${kv('Service Category:', 'Cab Service')}
              ${kv('Booking ID:', or(booking?.bookingNumber))}
              ${invoice?.billToGstin ? kv('Customer GSTIN:', esc(invoice.billToGstin)) : ''}
            </table>
          </td>
        </tr>
      </table>

      <!-- Trip details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:10px 14px 4px;font:700 10px/1.6 Arial,Helvetica,sans-serif;color:${INK};">Trip Details</td>
        </tr>
        <tr>
          <td style="padding:0 14px 12px;border-bottom:1px solid ${LINE};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" valign="top" style="padding-right:12px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                    ${kv('Pick-Up:', or(booking?.pickupAddress))}
                    ${kv('Start Date:', dmyTime(booking?.pickupAt))}
                  </table>
                </td>
                <td width="50%" valign="top">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                    ${kv('Drop:', or(booking?.dropAddress))}
                    ${booking?.distanceKm ? kv('Distance:', `${Math.round(booking.distanceKm)} km`) : ''}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Fare details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:10px 14px 6px;font:700 10px/1.6 Arial,Helvetica,sans-serif;color:${INK};">Fare Details:</td>
        </tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
        <tr>
          <td align="center" style="padding:5px 8px;border-bottom:1px solid ${LINE};border-right:1px solid ${LINE};font:700 9.5px/1.4 Arial,Helvetica,sans-serif;color:${INK};">Particulars</td>
          <td align="center" style="padding:5px 8px;border-bottom:1px solid ${LINE};border-right:1px solid ${LINE};font:700 9.5px/1.4 Arial,Helvetica,sans-serif;color:${INK};width:120px;">Rate</td>
          <td align="center" style="padding:5px 8px;border-bottom:1px solid ${LINE};font:700 9.5px/1.4 Arial,Helvetica,sans-serif;color:${INK};width:130px;">Amount</td>
        </tr>

        ${fareRow(esc(description), `&#8377; ${money(taxable + discount)}`, `&#8377; ${money(taxable + discount)}`)}

        ${discount > 0 ? fareRow('Discount', '', `- &#8377; ${money(discount)}`) : ''}

        ${
          hasTax
            ? igst > 0
              ? fareRow('IGST', fullRate ? `${fullRate}%` : '', `&#8377; ${money(igst)}`)
              : `${fareRow('CGST', halfRate ? `${halfRate}%` : '', `&#8377; ${money(cgst)}`)}
                 ${fareRow('SGST', halfRate ? `${halfRate}%` : '', `&#8377; ${money(sgst)}`)}`
            : ''
        }

        ${fareRow('Total', '', `&#8377; ${money(exactTotal)}`, { bold: true, topRule: true })}
        ${showRoundOff ? fareRow('Rounded Off', '', `${roundOff < 0 ? '-' : ''}&#8377; ${money(Math.abs(roundOff))}`) : ''}
        ${fareRow('Final Amount', '', `&#8377; ${money(finalAmount)}`, { bold: true, topRule: true })}
      </table>

      <!-- Amount in words -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
        <tr>
          <td style="padding:8px 14px;font:400 9.5px/1.6 Arial,Helvetica,sans-serif;color:${INK};">
            <b>Amount in words:</b> ${esc(amountInWords(finalAmount))}
          </td>
        </tr>
      </table>

      <!-- Terms -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
        <tr>
          <td style="padding:10px 14px 12px;">
            <div style="font:700 9.5px/1.6 Arial,Helvetica,sans-serif;color:${INK};padding-bottom:4px;">Terms &amp; Conditions:</div>
            ${TERMS.map(
              (t, i) =>
                `<div style="font:400 8.5px/1.7 Arial,Helvetica,sans-serif;color:${GREY};padding-top:2px;">${i + 1}. ${esc(t)}</div>`,
            ).join('')}
            ${
              seller?.supportEmail
                ? `<div style="font:400 8.5px/1.7 Arial,Helvetica,sans-serif;color:${GREY};padding-top:8px;">For any queries, write to <b>${esc(seller.supportEmail)}</b>.</div>`
                : ''
            }
          </td>
        </tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
        <tr>
          <td align="center" style="padding:16px 14px;font:700 9.5px/1.5 Arial,Helvetica,sans-serif;color:${INK};">
            **This is a computer generated receipt and does not require any signature or stamp**
          </td>
        </tr>
      </table>

    </td>
  </tr>

  ${
    invoice?.hsnSac
      ? `<tr>
    <td style="padding:8px 2px 0;font:400 8.5px/1.6 Arial,Helvetica,sans-serif;color:#8a8a8a;">
      Service: Transport of passengers &middot; HSN/SAC ${esc(invoice.hsnSac)}
    </td>
  </tr>`
      : ''
  }

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
    `AbhiCabs — ${invoice?.type === 'TAX' ? 'Original Tax Invoice' : 'Bill of Supply'}`,
    '',
    `Invoice No   ${invoice?.invoiceNumber ?? '—'}`,
    `Booking ID   ${booking?.bookingNumber ?? '—'}`,
    `Invoice Date ${dmyShort(invoice?.issuedAt || invoice?.createdAt)}`,
    '',
    `Trip         ${TRIP_TYPE[booking?.tripType] || booking?.tripType || '—'}`,
    `Pick up      ${booking?.pickupAddress ?? '—'}`,
    `Drop         ${booking?.dropAddress ?? '—'}`,
    '',
    `Final Amount Rs. ${total}`,
    `In words     ${amountInWords(invoice?.totalAmount ?? booking?.finalFare ?? 0)}`,
    '',
    'This is a computer generated receipt and does not require any signature or stamp.',
  ].join('\n');
}

module.exports = {
  buildInvoiceHtml,
  buildInvoiceText,

  /*
   * Shared with bookingConfirmationTemplate so the confirmation and the
   * invoice are the same document in two states rather than two documents
   * that happen to look alike today. A change to the box, the fare table or
   * the words helper reaches both, which is the point — the rider sees one
   * before the trip and one after, and a mismatch between them reads as a
   * different company.
   */
  esc,
  money,
  dmyShort,
  dmyTime,
  amountInWords,
  kv,
  fareRow,
  LINE,
  INK,
  GREY,
  GOLD,
};