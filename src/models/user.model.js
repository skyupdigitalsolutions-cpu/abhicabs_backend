'use strict';

/**
 * src/models/user.model.js
 *
 * With Prisma there is no ORM "model class" to write — the client is generated
 * from schema.prisma. What still belongs here are the shared shapes and
 * constants that describe a User at the application level, so they are defined
 * once instead of being copy-pasted across services.
 */

/**
 * Fields safe to send to a client.
 *
 * `password` is deliberately absent. Listing the safe fields explicitly is
 * safer than selecting everything and remembering to delete the hash — a
 * forgotten delete leaks the hash; a forgotten addition here just omits a
 * harmless field.
 */
const SAFE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

/** Trimmed shape for list endpoints — less data over the wire. */
const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
};

const ROLES = Object.freeze({
  USER: 'USER',
  ADMIN: 'ADMIN',
});

const ROLE_VALUES = Object.values(ROLES);

/** Columns a client may sort by. Anything else is rejected by the validator. */
const SORTABLE_FIELDS = ['createdAt', 'name', 'email'];

/** Fields an admin is allowed to change. Everything else in a body is ignored. */
const ADMIN_EDITABLE = ['name', 'email', 'phone', 'role', 'isActive', 'password'];

/** Fields a user may change on their own record. */
const SELF_EDITABLE = ['name', 'phone'];

module.exports = {
  SAFE_SELECT,
  LIST_SELECT,
  ROLES,
  ROLE_VALUES,
  SORTABLE_FIELDS,
  ADMIN_EDITABLE,
  SELF_EDITABLE,
};