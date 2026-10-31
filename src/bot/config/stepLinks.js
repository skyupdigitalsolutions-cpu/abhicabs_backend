const env = require('./env');

/**
 * A website link for each step of the booking. Every bot message ends with the link of the step the customer
 * is on. A step without its own link uses WEBSITE_URL (Railway variable, default https://www.abhicabs24x7.com/).
 *
 * To give a step its own page, remove the // in front of its line and paste the link between the quotes.
 * The step names are the ones the customer moves through, in order.
 */
const STEP_LINKS = {
  // MAIN_MENU: '',
  // BOOKING_TRIP_TYPE: '',
  // BOOKING_PICKUP: '',
  // BOOKING_DROP: '',
  // BOOKING_DATE: '',
  // BOOKING_TIME: '',
  // BOOKING_RETURN_DATE: '',
  // BOOKING_RETURN_TIME: '',
  // BOOKING_RENTAL_HOURS: '',
  // BOOKING_PASSENGERS: '',
  // BOOKING_VEHICLE_SELECTION: '',
  // BOOKING_FARE_CONFIRMATION: '',
  // BOOKING_CUSTOMER_NAME: '',
  // BOOKING_REVIEW: '',
  // BOOKING_CREATED: '',
  // PAYMENT_PENDING: '',
  // BOOKING_CONFIRMED: '',
  // MY_BOOKINGS: '',
  // BOOKING_DETAILS: '',
  // CANCELLATION_REASON: '',
  // CANCELLATION_CONFIRMATION: '',
  // SUPPORT_CATEGORY: '',
  // SUPPORT_MESSAGE: '',
};

/** The link to show for a step ('' when links are switched off). */
function linkForState(state) {
  if (!env.WEBSITE_LINKS) return '';
  return (state && STEP_LINKS[state]) || env.WEBSITE_URL || '';
}

module.exports = { STEP_LINKS, linkForState };
