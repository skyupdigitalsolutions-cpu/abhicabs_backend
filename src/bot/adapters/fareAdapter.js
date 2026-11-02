'use strict';
/**
 * Replaces the bot's own fare maths. Prices come from the website's
 * quote.service, so WhatsApp, the website and the apps always show the SAME
 * fare for the same trip (rate cards, surge, night allowance, GST).
 */
const { v4: uuid } = require('uuid');
const quoteService = require('../../services/quote.service');
const { vehicleInfo } = require('./vehicleInfo');

const num = (v) => Number(v || 0);
const perKmOf = (o) => {
  const v = o && o.configSnapshot ? Number(o.configSnapshot.perKm) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};
const loc = (p) => {
  if (!p) return null;
  const out = {};
  if (Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))) { out.lat = Number(p.latitude); out.lng = Number(p.longitude); }
  if (p.address && String(p.address).trim().length >= 3) out.address = String(p.address).trim().slice(0, 500);
  return out.lat !== undefined || out.address ? out : null;
};

async function getFareOptions({ tripType, pickup, drop, pickupAt, returnAt, rentalHours, cityId, accountType }) {
  let result;
  try {
    result = await quoteService.quoteAllClasses({
      cityId: Number(cityId) || Number(process.env.BOT_DEFAULT_CITY_ID) || 1,
      tripType,
      pickup: loc(pickup),
      drop: tripType === 'HOURLY' ? null : loc(drop),
      pickupAt: new Date(pickupAt).toISOString(),
      returnAt: tripType === 'ROUND_TRIP' && returnAt ? new Date(returnAt).toISOString() : null,
      rentalHours: tripType === 'HOURLY' ? Math.round(Number(rentalHours) || 4) : null,
      accountType: accountType || 'RETAIL',
    });
  } catch (err) {
    /*
     * A one-way or round trip whose pickup AND drop are both inside one city is not an outstation trip: the backend
     * turns it into a LOCAL rental and answers 409 LOCAL_PACKAGE_REQUIRED until a rental package or hours are chosen.
     * The website and the apps show a "Switched to Local" dialog at that point. The bot cannot show a dialog, so it
     * reports it with its own code and the booking flow moves the customer to the local (hours) question.
     */
    if (err && err.code === 'LOCAL_PACKAGE_REQUIRED') {
      const local = (err.details && err.details.switchedToLocal) || {};
      const e = new Error('LOCAL_SWITCH');
      e.code = 'LOCAL_SWITCH';
      e.cityName = local.cityName || null;
      throw e;
    }
    throw err;
  }

  const distanceKm = result.trip && result.trip.oneWayKm ? Math.round(num(result.trip.oneWayKm) * 10) / 10 : null;
  const out = [];
  for (const o of result.options) {
    const v = await vehicleInfo(o.vehicleClass);
    const inclusive = !o.tax || o.tax.isInclusive;
    const total = Math.round(num(o.tax && o.tax.payable != null ? o.tax.payable : o.total));
    out.push({
      fareQuoteId: `Q-${uuid()}`,
      vehicleId: o.vehicleClass,
      vehicleName: v.name,
      category: v.category,
      seatingCapacity: v.seatingCapacity,
      ac: v.ac,
      // The per-km rate of the rate card that priced this vehicle (frozen into the fare's config snapshot). It is what
      // the vehicle list shows next to each cab ("₹19/km"), the cab-type list shows as "from ₹19/km", and the booking
      // summary shows as "Rate". A Local (hourly) trip is priced by hours, so it has none.
      ratePerKm: tripType === 'HOURLY' ? null : perKmOf(o),
      distanceKm,
      fare: {
        baseFare: Math.round(num(o.base) + num(o.distance) + num(o.time) + num(o.returnEmpty) + num(o.minimumFareAdjustment)),
        additionalCharges: Math.round(num(o.waiting) + num(o.night) + num(o.airport) + num(o.surgeAmount)),
        driverAllowance: Math.round(num(o.bata)),
        tax: inclusive ? 0 : Math.round(num(o.tax.amount)),
        surge: Math.round(num(o.surgeAmount)),
        total,
        currency: 'INR',
      },
    });
  }
  return out;
}

module.exports = { getFareOptions };