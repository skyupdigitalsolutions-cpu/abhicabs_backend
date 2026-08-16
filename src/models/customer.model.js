'use strict';

/**
 * src/models/customer.model.js
 *
 * Shared select shapes and field whitelists for the Day 3 entities.
 *
 * Allowlists, not denylists: a newly added sensitive column is excluded by
 * default. The inverse — select everything and delete what is sensitive — fails
 * silently the day someone forgets.
 */

const CUSTOMER_SELECT = {
  userId: true,
  accountType: true,
  corporateAccountId: true,
  alternatePhone: true,
  gstin: true,
  loyaltyPoints: true,
  totalBookings: true,
  notes: true,
  meta: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: { id: true, name: true, email: true, phone: true, role: true, isActive: true },
  },
  corporate: {
    select: { id: true, companyName: true, gstin: true, billingCycle: true, isActive: true },
  },
};

/** Trimmed for list endpoints — less data over the wire. */
const CUSTOMER_LIST_SELECT = {
  userId: true,
  accountType: true,
  corporateAccountId: true,
  loyaltyPoints: true,
  totalBookings: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, phone: true, isActive: true } },
  corporate: { select: { id: true, companyName: true } },
};

/**
 * What a customer may change about themselves.
 *
 * accountType, corporateAccountId, loyaltyPoints and notes are ABSENT by
 * design — the first two decide invoice type and billing entity, the third is
 * money-adjacent, and the fourth is internal staff commentary the customer
 * should never see, let alone edit.
 */
const SELF_EDITABLE_CUSTOMER_FIELDS = ['alternatePhone', 'gstin'];

/** What staff holding CUSTOMER_MANAGE may change. */
const ADMIN_EDITABLE_CUSTOMER_FIELDS = [
  'accountType',
  'corporateAccountId',
  'alternatePhone',
  'gstin',
  'loyaltyPoints',
  'notes',
];

const CORPORATE_SELECT = {
  id: true,
  companyName: true,
  gstin: true,
  pan: true,
  billingEmail: true,
  billingPhone: true,
  billingAddress: true,
  billingCity: true,
  billingState: true,
  billingPincode: true,
  billingCycle: true,
  creditLimit: true,
  creditUsed: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { customers: true } },
};

const CORPORATE_LIST_SELECT = {
  id: true,
  companyName: true,
  gstin: true,
  billingEmail: true,
  billingCity: true,
  billingCycle: true,
  creditLimit: true,
  creditUsed: true,
  isActive: true,
  createdAt: true,
  _count: { select: { customers: true } },
};

const ADDRESS_SELECT = {
  id: true,
  customerId: true,
  label: true,
  line1: true,
  line2: true,
  landmark: true,
  city: true,
  state: true,
  pincode: true,
  lat: true,
  lng: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
};

const ACCOUNT_TYPES = Object.freeze({ RETAIL: 'RETAIL', CORPORATE: 'CORPORATE' });
const BILLING_CYCLES = Object.freeze({ PER_TRIP: 'PER_TRIP', WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY' });

const CUSTOMER_SORTABLE = ['createdAt', 'loyaltyPoints', 'totalBookings', 'name'];
const CORPORATE_SORTABLE = ['createdAt', 'companyName', 'creditLimit'];

module.exports = {
  CUSTOMER_SELECT,
  CUSTOMER_LIST_SELECT,
  SELF_EDITABLE_CUSTOMER_FIELDS,
  ADMIN_EDITABLE_CUSTOMER_FIELDS,
  CORPORATE_SELECT,
  CORPORATE_LIST_SELECT,
  ADDRESS_SELECT,
  ACCOUNT_TYPES,
  BILLING_CYCLES,
  CUSTOMER_SORTABLE,
  CORPORATE_SORTABLE,
};