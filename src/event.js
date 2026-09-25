// Builds the event Meta expects for a conversion from a click-to-WhatsApp ad,
// and hashes customer details the way Meta matches them.
import crypto from 'node:crypto';

/**
 * Event names the live API accepted for action_source "business_messaging" when we tried them
 * one by one, in September 2026. Any other name was refused with subcode 2804066.
 */
export const ACCEPTED_EVENT_NAMES = Object.freeze([
  'ViewContent',
  'LeadSubmitted',
  'QualifiedLead',
  'AddToCart',
  'InitiateCheckout',
  'OrderCreated',
  'OrderShipped',
  'OrderDelivered',
  'Purchase',
  'OrderCanceled',
  'OrderReturned',
]);

/** Listed in Meta's business messaging docs, but not among the names we have seen the live API accept. */
export const UNCONFIRMED_EVENT_NAMES = Object.freeze(['CartAbandoned', 'RatingProvided', 'ReviewProvided']);

/** Names the live API refused with subcode 2804066. Lead is one of them. */
export const REFUSED_EVENT_NAMES = Object.freeze(['Lead', 'Confirmed', 'Canceled']);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** True for a SHA-256 digest in lowercase hex, the form Meta takes for hashed fields. */
export const isHashed = (value) => typeof value === 'string' && SHA256_HEX.test(value);

/**
 * Meta's rule for phone numbers: digits only, no leading zeros, country code included.
 * The wa_id in a WhatsApp webhook already has that shape.
 */
export const normalizePhone = (phone) =>
  String(phone ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');

/** Meta's rule for emails: no surrounding spaces, all lowercase. */
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

/** SHA-256 of the normalized phone number, or undefined when it has no digit. A digest passes through. */
export function hashPhone(phone) {
  const raw = String(phone ?? '').trim().toLowerCase();
  if (isHashed(raw)) return raw;
  const digits = normalizePhone(raw);
  return digits ? sha256(digits) : undefined;
}

/** SHA-256 of the normalized email, or undefined when it is empty. A digest passes through. */
export function hashEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  return isHashed(normalized) ? normalized : sha256(normalized);
}

/**
 * Unix seconds from a Date, an ISO date or a number, and now when there is nothing.
 * Anything else is returned unchanged, so validateEvent can say what is wrong with it.
 */
export function toUnixSeconds(time, now = Date.now()) {
  if (time === undefined || time === null || time === '') return Math.floor(now / 1000);
  if (time instanceof Date) return Math.floor(time.getTime() / 1000);
  if (typeof time === 'string') {
    const trimmed = time.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return time;
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/**
 * One event for Meta's business messaging endpoint, from a conversation that started with a
 * click-to-WhatsApp ad. It never throws and never guesses: run validateEvent on the result to see
 * what Meta would refuse.
 *
 * The event ID defaults to "<orderId>:<eventName>", so a retry of the same order event keeps its ID.
 * Without an order ID, pass eventId yourself.
 */
export function buildEvent({
  eventName,
  wabaId,
  ctwaClid,
  orderId,
  eventId,
  eventTime,
  value,
  currency,
  phone,
  email,
  customData,
  now = Date.now(),
} = {}) {
  const name = text(eventName);
  const order = text(orderId);
  const id = text(eventId) || (order && name ? `${order}:${name}` : '');

  const userData = {};
  if (text(wabaId)) userData.whatsapp_business_account_id = text(wabaId);
  if (text(ctwaClid)) userData.ctwa_clid = text(ctwaClid);
  const ph = phone === undefined ? undefined : hashPhone(phone);
  if (ph) userData.ph = [ph];
  const em = email === undefined ? undefined : hashEmail(email);
  if (em) userData.em = [em];

  const custom = { ...(customData || {}) };
  if (value !== undefined && value !== null && value !== '') custom.value = value;
  if (text(currency)) custom.currency = text(currency).toUpperCase();
  if (order) custom.order_id = order;

  const event = {};
  if (name) event.event_name = name;
  event.event_time = toUnixSeconds(eventTime, now);
  if (id) event.event_id = id;
  event.action_source = 'business_messaging';
  event.messaging_channel = 'whatsapp';
  event.user_data = userData;
  if (Object.keys(custom).length) event.custom_data = custom;
  return event;
}
