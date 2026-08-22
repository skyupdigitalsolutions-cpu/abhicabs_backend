# ABHICABS API Reference

Backend for the ABHICABS cab-booking and fleet-management platform.
Node.js / Express · PostgreSQL · Redis.

- **Base URL:** `http://localhost:5000` (dev) · `https://<your-host>` (prod)
- **API prefix:** all endpoints below are under `/api/v1`
- **Content type:** `application/json` unless noted (webhooks use the raw body)

---

## Conventions

### Authentication
Most endpoints require a **Bearer access token**:

```
Authorization: Bearer <accessToken>
```

Obtain one from `POST /auth/login` (or `/auth/register`, `/auth/otp/verify`).
Access tokens are short-lived; use `POST /auth/refresh` with the refresh token to
get a new one. Endpoints marked **Public** need no token.

### Authorization
Beyond authentication, many endpoints require a **permission** (held via the
caller's role) or a specific **role**. Each endpoint lists what it needs:

- **Permission: `X`** — the caller's role must grant capability `X`.
- **Role: `X`** — the caller must have role `X`.
- **Owner** — a customer may only access their own resource; others get `404`.

Roles: `ADMIN`, `OPS`, `FINANCE`, `FLEET`, `SUPPORT`, `DRIVER`, `USER` (customer).
`ADMIN` holds all permissions.

### Standard response envelope
Success:
```json
{ "success": true, "data": { ... }, "message": "optional" }
```
Error:
```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "human text" } }
```

### Common error codes
| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Request body/params failed validation (includes `fields`) |
| `INVALID_JSON` | 400 | Malformed JSON body |
| `AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | 401 | Missing/invalid/expired access token |
| `PERMISSION_DENIED` | 403 | Authenticated but lacks the required permission/role |
| `NOT_FOUND` | 404 | Resource not found (also returned for owner-scoped misses, to avoid confirming existence) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same `Idempotency-Key` reused with a different request |
| `RATE_LIMITED` | 429 | Too many requests for this tier |
| `SERVER_BUSY` | 503 | Load shedding — event loop saturated; retry after `Retry-After` |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Idempotency
Mutating booking/payment endpoints accept an **`Idempotency-Key`** header. Reusing
a key returns the original result instead of acting twice. Use a fresh UUID per
distinct request.

### Rate limits
| Tier | Applies to | Limit |
|------|-----------|-------|
| auth | login, register | 10 / 15 min |
| otp-request | OTP request | 5 / 15 min (per ip+phone) |
| otp-verify | OTP verify | 15 / 15 min (per ip+phone) |
| refresh | token refresh | 30 / min |
| api | authenticated API (default) | 300 / min (per user) |
| write | expensive mutations (booking create) | 60 / min (per user) |
| ping | GPS ping | 60 / min (per driver) |

---

## Health (no prefix)

### GET `/health`
Liveness probe. **Public.**
→ `200 { "status": "ok", "uptime": <seconds> }`

### GET `/health/ready`
Readiness probe. **Public.** Reports database, redis, cache, and load-shed status.
Only the primary database gates readiness (`503` if down).
→ `200 { "ready": true, "db": {...}, "redis": {...}, "cache": {...}, "loadShed": {...} }`

---

## Auth  `/api/v1/auth`

### POST `/auth/register` — **Public**
Create a customer account. Rate: auth.
Body: `{ "name", "email", "password", "phone" }`
→ `201 { user, accessToken, refreshToken }`
Errors: `EMAIL_TAKEN` (409), `VALIDATION_ERROR`.

### POST `/auth/login` — **Public**
Body: `{ "email", "password" }`
→ `200 { user, accessToken, refreshToken }`
Errors: `INVALID_CREDENTIALS` (401), `ACCOUNT_INACTIVE` (403), `RATE_LIMITED`.

### POST `/auth/otp/request` — **Public**
Request a login OTP. Rate: otp-request.
Body: `{ "phone" }`
→ `200 { requested: true }`  (30s cooldown + daily cap enforced)

### POST `/auth/otp/verify` — **Public**
Body: `{ "phone", "code" }`
→ `200 { user, accessToken, refreshToken }`
Errors: `INVALID_OTP` (400), `RATE_LIMITED`.

### POST `/auth/refresh` — **Public**
Exchange a refresh token for a new access token. Rate: refresh.
Body: `{ "refreshToken" }`
→ `200 { accessToken, refreshToken }`  (refresh token is rotated)
Errors: `INVALID_TOKEN` (401), `TOKEN_REUSED` (401 — a rotated/used token was replayed; the token family is revoked).

### POST `/auth/logout` — **Public** (idempotent)
Body: `{ "refreshToken" }`  → revokes it. → `200`

### GET `/auth/me` — **Auth**
→ `200 { user, permissions }`

### POST `/auth/logout-all` — **Auth**
Revokes all of the caller's refresh tokens. → `200`

### POST `/auth/change-password` — **Auth**
Body: `{ "currentPassword", "newPassword" }` → `200`
Errors: `INVALID_CREDENTIALS` (401).

---

## Users  `/api/v1/users`  — **Auth**

### GET `/users/profile`
→ `200 { user }`

### PATCH `/users/profile`
Body: `{ "name"?, "phone"? }` → `200 { user }`

### DELETE `/users/account`
Deactivates the caller's account. → `200`

---

## Customers (self)  `/api/v1/customers`  — **Auth**

### GET `/customers/me`
Customer profile. → `200 { customer }`

### PATCH `/customers/me`
Body: customer self fields. → `200 { customer }`

### GET `/customers/me/billing`
Resolved billing entity (retail vs corporate). → `200 { billing }`

### GET `/customers/me/addresses`
→ `200 { addresses }`

### POST `/customers/me/addresses`
Body: `{ "label", "line1", "lat", "lng", ... }` → `201 { address }`

### GET `/customers/me/addresses/:id` — **Owner**
→ `200 { address }` · `404` if not owned.

### PATCH `/customers/me/addresses/:id` — **Owner**
→ `200 { address }`

### DELETE `/customers/me/addresses/:id` — **Owner**
→ `200`

---

## Fares & Maps  `/api/v1/fares`  — **Auth**

### POST `/fares/estimate`
Itemised fare quote for one class. Body: `{ "cityId", "vehicleClass", "tripType", "pickup"{lat,lng}, "drop"{lat,lng}, "pickupAt", "returnAt"? }`
→ `200 { quote }` (base, distance, time, night, returnEmpty, surge, minFare, total)
Errors: `OUTSIDE_SERVICE_AREA` (400), `NO_FARE_CONFIG` (400).

### POST `/fares/compare`
Quotes across trip types. → `200 { quotes }`

### POST `/fares/options`
Quotes across all vehicle classes for a route. → `200 { options }`

### POST `/fares/cancellation-fee`
Body: `{ "cityId", "vehicleClass", "tripType", "stage" }` → `200 { fee, refund, band }`

### POST `/fares/geocode`
Body: `{ "address" }` → `200 { results }`

### GET `/fares/reverse-geocode?lat=&lng=`
→ `200 { address }`

### GET `/fares/autocomplete?q=`
→ `200 { predictions }`

### POST `/fares/distance`
Body: `{ "origin"{lat,lng}, "destination"{lat,lng} }` → `200 { distanceKm, durationMin }`

### GET `/fares/maps/health` — **Permission: `REPORT_VIEW`**
Maps provider health. → `200 { status }`

---

## Bookings (customer)  `/api/v1/bookings`  — **Auth**

### POST `/bookings`
Create a booking. Rate: **write**. Header: `Idempotency-Key`.
Body: `{ "cityId", "vehicleClass", "tripType", "pickup"{lat,lng}, "drop"{lat,lng}, "pickupAt", "returnAt"?, "paymentMode" }`
→ `201 { booking }`  (status `PENDING`)
Errors: `OUTSIDE_SERVICE_AREA` (400), `IDEMPOTENCY_KEY_REUSED` (409), `CREDIT_LIMIT_EXCEEDED` (403, corporate).

### GET `/bookings`
List the caller's bookings. Query: `page, limit, status, tripType`. → `200 { bookings, page }`
(A `USER` sees only their own; staff can filter by `customerId`.)

### GET `/bookings/:id` — **Owner**
→ `200 { booking }` · `404` if not owned.

### GET `/bookings/:id/summary` — **Owner**  *(Day 14 aggregate)*
Booking + payments + allocation + invoice + live location in one call.
→ `200 { booking, payments, allocation, invoice, liveLocation }`

### GET `/bookings/:id/actions` — **Owner**
Allowed lifecycle transitions from the current state. → `200 { actions }`

### GET `/bookings/:id/invoice` — **Owner**
→ `200 { invoice }` · `404` if none / not owned.

### GET `/bookings/:id/cancellation-quote` — **Owner**
Fee/refund if cancelled now. → `200 { fee, refund, band }`

### POST `/bookings/:id/cancel` — **Owner**  (idempotent)
Body: `{ "reason"? }` → `200 { booking, refund }`
Errors: `INVALID_STATUS_TRANSITION` (409).

---

## Payments  `/api/v1/payments`  — **Auth**

### POST `/payments/orders`  (idempotent)
Create a gateway order for a booking. Body: `{ "bookingId", "purpose" }`  (`purpose`: `ADVANCE` | `FULL` | `BALANCE`)
→ `201 { payment, order }`
Errors: `BOOKING_NOT_PAYABLE` (409), `DUPLICATE_ACTIVE_ORDER` (409).

### GET `/payments/booking/:bookingId` — **Permission: `PAYMENT_VIEW`**
All payments for a booking. → `200 { payments }`

### POST `/payments/:id/simulate-webhook` — **Auth** *(dev only, mock provider)*
Simulates a gateway callback for testing. `403` in production.

### GET `/payments/:id` — **Owner**  *(Day 14: owner-scoped)*
→ `200 { payment }` · `404` if the payment's booking is not owned by the caller.
Staff roles may read any payment.

---

## Webhooks  `/api/v1/webhooks`

### POST `/webhooks/:provider` — **Public** (signature-verified)
Gateway payment callback (e.g. `razorpay`). Uses the **raw request body** for HMAC
verification. Idempotent: a replayed event is recorded once.
→ `200 { received: true }`
Errors: `INVALID_SIGNATURE` (401).

---

## Admin — Users  `/api/v1/admin`  — **Auth**

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/admin/stats` | `REPORT_VIEW` | Dashboard counts |
| GET `/admin/users` | `USER_MANAGE` | List users (query: page, limit, role, q) |
| POST `/admin/users` | `USER_MANAGE` | Create a user |
| GET `/admin/users/:id` | `USER_MANAGE` | Get a user |
| PATCH `/admin/users/:id` | `USER_MANAGE` | Update a user |
| DELETE `/admin/users/:id` | `USER_MANAGE` | Delete a user |
| PATCH `/admin/users/:id/activate` | `USER_MANAGE` | Activate |
| PATCH `/admin/users/:id/deactivate` | `USER_MANAGE` | Deactivate |
| GET `/admin/permissions` | `SETTINGS_MANAGE` | List role→permission grants |
| GET `/admin/permissions/catalogue` | `SETTINGS_MANAGE` | All permissions |
| POST `/admin/permissions/grant` | `SETTINGS_MANAGE` | Grant a permission to a role |
| POST `/admin/permissions/revoke` | `SETTINGS_MANAGE` | Revoke |
| GET `/admin/finance/refunds` | `PAYMENT_REFUND` | Refund queue (placeholder) |
| GET `/admin/fleet/pending-drivers` | `DRIVER_APPROVE` | Pending driver approvals (placeholder) |

---

## Admin — Customers  `/api/v1/admin/customers`  — **Permission: `CUSTOMER_MANAGE`**

| Method & path | Purpose |
|---|---|
| GET `/admin/customers/stats` | Customer stats |
| GET `/admin/customers` | List customers |
| GET `/admin/customers/:id` | Get one |
| PATCH `/admin/customers/:id` | Update |
| GET `/admin/customers/:id/bookings` | Their bookings |
| GET `/admin/customers/:id/...` | Related data |
| POST `/admin/customers/...` | Create/link |
| GET `/admin/customers/:entityId/audit` | Audit trail (**`AUDIT_VIEW`**) |

---

## Admin — Corporate  `/api/v1/admin/corporate`  — **Permission: `CORPORATE_MANAGE`**

| Method & path | Purpose |
|---|---|
| GET `/admin/corporate/stats` | Corporate stats |
| GET `/admin/corporate` | List corporate accounts |
| POST `/admin/corporate` | Create a corporate account |
| GET `/admin/corporate/:id` | Get one |
| PATCH `/admin/corporate/:id` | Update |
| PATCH `/admin/corporate/:id/credit` | Adjust credit limit |
| PATCH `/admin/corporate/:id/status` | Activate/suspend |
| GET `/admin/corporate/:id/members` | List members |
| POST `/admin/corporate/:id/members` | Add a member |
| DELETE `/admin/corporate/:id/members/:memberId` | Remove a member |
| GET `/admin/corporate/:id/audit` | Audit trail (**`AUDIT_VIEW`**) |

---

## Admin — Bookings & Lifecycle  `/api/v1/admin/bookings`  — **Auth**

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/admin/bookings/stats` | `REPORT_VIEW` | Booking stats |
| GET `/admin/bookings/attempts` | `BOOKING_MANAGE` | Booking attempt log |
| GET `/admin/bookings` | `BOOKING_MANAGE` | List all bookings |
| POST `/admin/bookings` | `BOOKING_CREATE` | Create on behalf of a customer (`Idempotency-Key`) |
| GET `/admin/bookings/cancellation-policy` | `BOOKING_MANAGE` | Policy bands |
| GET `/admin/bookings/:id` | `BOOKING_MANAGE` | Get one |
| GET `/admin/bookings/:id/actions` | `BOOKING_MANAGE` | Allowed transitions |
| PATCH `/admin/bookings/:id/confirm` | `BOOKING_MANAGE` | PENDING → CONFIRMED |
| PATCH `/admin/bookings/:id/allocate` | `DISPATCH_MANAGE` | CONFIRMED → ALLOCATED (body may name `vehicleId`,`driverId`) |
| PATCH `/admin/bookings/:id/en-route` | `DISPATCH_MANAGE` | ALLOCATED → EN_ROUTE |
| PATCH `/admin/bookings/:id/start` | `DISPATCH_MANAGE` | EN_ROUTE → ONGOING (writes trip start) |
| PATCH `/admin/bookings/:id/complete` | `DISPATCH_MANAGE` | ONGOING → COMPLETED (body: `finalFare`?; issues invoice + ledger) |
| PATCH `/admin/bookings/:id/expire` | `BOOKING_MANAGE` | PENDING → EXPIRED |
| GET `/admin/bookings/:id/cancellation-quote` | `BOOKING_CANCEL` | Fee/refund quote |
| POST `/admin/bookings/:id/cancel` | `BOOKING_CANCEL` | Cancel with policy fee |

Lifecycle transitions are guarded; an illegal move returns `409 INVALID_STATUS_TRANSITION`.

---

## Admin — Invoices  `/api/v1/admin/invoices`  — **Permission: `PAYMENT_VIEW`**

| Method & path | Purpose |
|---|---|
| GET `/admin/invoices/:id` | Get an invoice |
| GET `/admin/invoices/booking/:bookingId` | Invoice for a booking |
| GET `/admin/invoices/booking/:bookingId/ledger` | Balanced ledger for a booking |

---

## Admin — Reports  `/api/v1/admin/reports`  — **Permission: `REPORT_VIEW`**

| Method & path | Purpose |
|---|---|
| GET `/admin/reports/executive` | Executive summary |
| GET `/admin/reports/fleet` | Fleet utilisation |
| GET `/admin/reports/driver-performance` | Driver performance |
| GET `/admin/reports/business-trend` | Trend over time |
| GET `/admin/reports/gst` | GST summary |
| POST `/admin/reports/:type/export` | Queue a CSV export → returns a token |
| GET `/admin/reports/exports/:token` | Download a completed export |

---

## Dispatch (ops)  `/api/v1/admin/dispatch`  — **Permission: `DISPATCH_MANAGE`**

| Method & path | Purpose |
|---|---|
| GET `/admin/dispatch/board` | Pending + live + available vehicles (one call) |
| GET `/admin/dispatch/pending` | Pending bookings |
| GET `/admin/dispatch/live` | Live trips |
| GET `/admin/dispatch/vehicles?cityId=&vehicleClass=` | Available vehicles |
| POST `/admin/dispatch/bookings/:bookingId/auto-assign` | Rule-assisted assign |
| POST `/admin/dispatch/bookings/:bookingId/assign` | Manual assign `{ vehicleId, driverId? }` |
| GET `/admin/dispatch/bookings/:bookingId/allocation` | Active allocation |
| POST `/admin/dispatch/expire-offers` | Sweep stale offers |

Assign errors: `VEHICLE_UNAVAILABLE` (409, overlapping hold), `VEHICLE_CLASS_MISMATCH` (409), `BOOKING_NOT_ASSIGNABLE` (409), `ALREADY_ALLOCATED` (409).

---

## Driver — Offers  `/api/v1/driver/offers`  — **Role: `DRIVER`**

| Method & path | Purpose |
|---|---|
| POST `/driver/offers/:allocationId/accept` | Accept an offer |
| POST `/driver/offers/:allocationId/decline` | Decline → releases the hold |

Errors: `OFFER_NOT_ACCEPTABLE` (409), `NOT_YOUR_OFFER` (403).

---

## Driver — Location  `/api/v1/driver/location`  — **Role: `DRIVER`**

| Method & path | Purpose |
|---|---|
| POST `/driver/location/ping` | GPS ping (rate: ping). Body `{ lat, lng, speed?, heading?, bookingId? }` → Redis only |
| POST `/driver/location/online` | Go online |
| POST `/driver/location/offline` | Go offline (removed from live map) |

Ping returns `200 { accepted:true, ... }` or `202 { accepted:false, reason }` for
`TELEPORT` / `IMPLAUSIBLE_SPEED`.

---

## Location (ops)  `/api/v1/admin/location`  — **Permission: `DISPATCH_MANAGE`**

| Method & path | Purpose |
|---|---|
| GET `/admin/location/nearby?lat=&lng=&radiusKm=` | Nearest drivers (GEOSEARCH) |
| GET `/admin/location/driver/:driverId` | A driver's live position |
| GET `/admin/location/trip/:bookingId/trail` | Durable trip trail (start/checkpoints/end) |
| POST `/admin/location/sweep-stale` | Mark non-pinging drivers offline |

---

## Audit  `/api/v1/admin/audit`  — **Permission: `AUDIT_VIEW`**

| Method & path | Purpose |
|---|---|
| GET `/admin/audit` | List audit entries (query: filters) |
| GET `/admin/audit/actions` | Distinct action types |
| GET `/admin/audit/:entityType/:entityId` | Trail for one entity |

---

## Realtime (WebSocket)

Socket.IO at the server root (e.g. `http://localhost:5000`). Authenticate in the
handshake:
```js
io(BASE_URL, { auth: { token: accessToken } })
```
Rooms are joined by role automatically (`dispatch`/`admin` for ops, `driver:<id>`
for drivers). Customers subscribe to a booking with `socket.emit('booking:watch', bookingId)`.

Server → client events: `booking:attempted`, `booking:created`, `trip:status`,
`booking:allocated`, `offer:new`, `payment:received`, `trip:location`,
`driver:location`, `admin:alert`.

---

*Generated for ABHICABS backend — Days 1–14. Roles/permissions reflect the seeded
role→permission map; adjust via `/admin/permissions` if changed.*