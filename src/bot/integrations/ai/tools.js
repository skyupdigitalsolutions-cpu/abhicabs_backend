/**
 * The ONE place that defines what the bot is allowed to cause to happen.
 * Every tool now runs through the website backend's own services.
 */
const vehicleInfo = require('../../adapters/vehicleInfo');
const fareAdapter = require('../../adapters/fareAdapter');
const bookingAdapter = require('../../adapters/bookingAdapter');
const paymentAdapter = require('../../adapters/paymentAdapter');
const cancellationAdapter = require('../../adapters/cancellationAdapter');
const invoiceAdapter = require('../../adapters/invoiceAdapter');
const supportAdapter = require('../../adapters/supportAdapter');

const tools = {
  getAvailableVehicles: vehicleInfo.getAvailableVehicles,
  getFareOptions: fareAdapter.getFareOptions,

  createBooking: bookingAdapter.createBooking,
  getBooking: bookingAdapter.getBookingById,
  getBookingByNumber: bookingAdapter.getBookingByNumber,
  getBookingsForCustomer: bookingAdapter.getBookingsForCustomer,
  getBookingSummary: bookingAdapter.getBookingSummary,

  getPaymentStatus: paymentAdapter.getPaymentStatus,
  countPaymentAttemptsForBooking: paymentAdapter.countPaymentAttemptsForBooking,
  createPaymentLink: paymentAdapter.createPaymentLink,
  markBookingPayLater: paymentAdapter.markBookingPayLater,

  getAvailableActions: cancellationAdapter.getAvailableActions,
  getCancellationQuote: cancellationAdapter.getCancellationQuote,
  cancelBooking: cancellationAdapter.cancelBooking,

  getInvoice: invoiceAdapter.getInvoice,
  createSupportTicket: supportAdapter.createSupportTicket,
};

async function callTool(name, ...args) {
  const fn = tools[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(...args);
}

module.exports = { tools, callTool };
