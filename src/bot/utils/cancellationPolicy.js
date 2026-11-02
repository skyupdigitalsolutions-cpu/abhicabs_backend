/**
 * Placeholder tiered cancellation policy. Replace with the real ABHI
 * CABS policy once verified against the actual backend/source — this
 * exists so BACKEND_MODE=local has a working, testable rule rather
 * than an invented number computed inline and untested.
 */
function calculateCancellationFee({ hoursToPickup, total }) {
  let feePercent;
  if (hoursToPickup >= 24) feePercent = 0;
  else if (hoursToPickup >= 6) feePercent = 0.1;
  else if (hoursToPickup >= 1) feePercent = 0.25;
  else feePercent = 0.5;

  const fee = Math.round(total * feePercent);
  const refundAmount = total - fee;
  return { fee, refundAmount, feePercent };
}

module.exports = { calculateCancellationFee };
