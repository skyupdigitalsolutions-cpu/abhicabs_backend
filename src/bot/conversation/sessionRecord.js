const { getPrisma } = require('../config/db');

/**
 * Thin wrapper around a Postgres `bot_sessions` row that mimics the small
 * slice of Mongoose-document behavior the conversation handlers already rely
 * on (`session.draft.x = y`, `session._id`, `await session.save()`,
 * `session.resetDraft()`). This exists purely to avoid rewriting ~15 handler
 * files when the persistence layer moved from MongoDB to PostgreSQL — the
 * actual read/write happens via Prisma underneath.
 */
function defaultDraft() {
  return {
    tripType: null,
    pickup: {},
    drop: {},
    pickupAt: null,
    returnAt: null,
    rentalHours: null,
    passengerCount: null,
    vehicleClass: null,
    vehicleId: null,
    fareQuoteId: null,
    fare: null,
    passengerName: null,
    passengerEmail: null,
    specialRequests: null,
  };
}

class SessionRecord {
  constructor(row) {
    this.id = row.id;
    this.whatsappNumber = row.whatsappNumber;
    this.customerId = row.customerId;
    this.language = row.language;
    this.state = row.state;
    this.previousState = row.previousState;
    this.draft = row.draft && Object.keys(row.draft).length ? row.draft : defaultDraft();
    this.activeBookingId = row.activeBookingId;
    this.activePaymentId = row.activePaymentId;
    this.pendingIdempotencyKey = row.pendingIdempotencyKey;
    this.pendingOptionsMap = row.pendingOptionsMap || {};
    this.humanHandoff = row.humanHandoff;
    this.handoffReason = row.handoffReason;
    this.lastMessageAt = row.lastMessageAt;
    this.expiresAt = row.expiresAt;
    this._snap = this._snapshot();
  }

  /** Everything save() writes, as text: if it has not changed since the last write there is nothing to save. */
  _snapshot() {
    return JSON.stringify([
      this.customerId, this.language, this.state, this.previousState, this.draft, this.activeBookingId, this.activePaymentId,
      this.pendingIdempotencyKey, this.pendingOptionsMap, this.humanHandoff, this.handoffReason, this.lastMessageAt, this.expiresAt,
    ]);
  }

  /** Mongoose alias some code still reads (e.g. bookingIdempotencyKey(String(session._id), ...)). */
  get _id() {
    return this.id;
  }

  resetDraft() {
    this.draft = defaultDraft();
    this.pendingIdempotencyKey = null;
  }

  /** Writes everything changed while answering a message, in ONE database trip, and stops holding writes back. */
  async flush() {
    this._deferSaves = false;
    return this.save();
  }

  /** No-op — Mongoose needed this to track nested-object mutations; Prisma writes the whole JSON column back on save() regardless. */
  markModified() {}

  async save() {
    // While a message is being answered, writes are held back and done once at the end (see flush()).
    if (this._deferSaves) return this;
    // Each database trip costs real time when the database is far away, so an unchanged session is not written again.
    const snap = this._snapshot();
    if (snap === this._snap) return this;
    const prisma = getPrisma();
    await prisma.whatsappSession.update({
      where: { id: this.id },
      data: {
        customerId: this.customerId,
        language: this.language,
        state: this.state,
        previousState: this.previousState,
        draft: this.draft,
        activeBookingId: this.activeBookingId,
        activePaymentId: this.activePaymentId,
        pendingIdempotencyKey: this.pendingIdempotencyKey,
        pendingOptionsMap: this.pendingOptionsMap,
        humanHandoff: this.humanHandoff,
        handoffReason: this.handoffReason,
        lastMessageAt: this.lastMessageAt,
        expiresAt: this.expiresAt,
      },
    });
    this._snap = snap;
    return this;
  }
}

function wrapSession(row) {
  return row ? new SessionRecord(row) : null;
}

module.exports = { SessionRecord, wrapSession, defaultDraft };
