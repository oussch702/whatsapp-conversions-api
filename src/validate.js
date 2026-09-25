// Checks one event against what Meta refuses for click-to-WhatsApp conversions, before anything is sent.
// Meta rejects the whole request when a single event is invalid, so one bad event costs all of them.
import { ACCEPTED_EVENT_NAMES, UNCONFIRMED_EVENT_NAMES, isHashed } from './event.js';

/** Meta refuses the whole request when any event_time is more than 7 days old. */
export const MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Clock drift tolerated before an event_time counts as being in the future. */
const FUTURE_SLACK_SECONDS = 5 * 60;

// What to send instead of the names the live API refused.
const REFUSED = {
  Lead: 'LeadSubmitted, or QualifiedLead once the lead is qualified',
  Confirmed: 'QualifiedLead or OrderCreated, depending on what was confirmed',
  Canceled: 'OrderCanceled',
};

// Spelling and case variants, and the refused names, mapped to the name to use.
const key = (name) => name.toLowerCase().replace(/[^a-z]/g, '').replace(/cancelled/g, 'canceled');
const SUGGESTIONS = new Map([
  ...[...ACCEPTED_EVENT_NAMES, ...UNCONFIRMED_EVENT_NAMES].map((name) => [key(name), name]),
  ['lead', 'LeadSubmitted'],
  ['confirmed', 'QualifiedLead'],
  ['canceled', 'OrderCanceled'],
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || value === '';
const show = (value) => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));

function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} hours`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} days and ${rest} hour${rest === 1 ? '' : 's'}` : `${days} days`;
}

function checkName(name, report) {
  if (isBlank(name)) return report.error('event_name', 'event_name is missing.');
  if (typeof name !== 'string') return report.error('event_name', `event_name must be a string, not ${show(name)}.`);
  if (ACCEPTED_EVENT_NAMES.includes(name)) return;
  if (UNCONFIRMED_EVENT_NAMES.includes(name)) {
    return report.warning(
      'event_name',
      `${name} is in Meta's docs for business messaging, but we have not seen the live API accept it. Send one with a test event code before you rely on it.`,
    );
  }
  if (REFUSED[name]) {
    return report.error('event_name', `Meta refuses "${name}" for WhatsApp events (2804066). Use ${REFUSED[name]}.`, 2804066);
  }
  const suggestion = SUGGESTIONS.get(key(name));
  report.error(
    'event_name',
    suggestion
      ? `${show(name)} is not one of the event names Meta accepts for WhatsApp events (2804066). Did you mean ${suggestion}?`
      : `${show(name)} is not one of the event names Meta accepts for WhatsApp events (2804066). Use one of: ${ACCEPTED_EVENT_NAMES.join(', ')}.`,
    2804066,
  );
}

function checkTime(time, nowSeconds, report) {
  if (isBlank(time)) {
    return report.error('event_time', 'event_time is missing. Use the Unix time, in seconds, when the event happened.');
  }
  if (typeof time !== 'number' || !Number.isInteger(time)) {
    return report.error('event_time', `event_time must be a whole number of seconds since 1970, not ${show(time)}.`);
  }
  if (time > 1e11) return report.error('event_time', 'event_time looks like milliseconds. Divide it by 1000.');
  const age = nowSeconds - time;
  if (age > MAX_EVENT_AGE_SECONDS) {
    return report.error(
      'event_time',
      `event_time is ${duration(age)} old. Meta refuses the whole request when one event is more than 7 days old.`,
    );
  }
  if (-age > FUTURE_SLACK_SECONDS) {
    report.error('event_time', `event_time is ${duration(-age)} in the future. It should be the time the event happened.`);
  }
}

function checkUserData(user, { datasetId, pageId }, report) {
  if (!isObject(user)) {
    return report.error('user_data', 'user_data is missing. A WhatsApp event carries the ad click ID and the WhatsApp Business Account ID in it.');
  }

  const clid = user.ctwa_clid;
  if (isBlank(clid)) {
    report.error(
      'user_data.ctwa_clid',
      'The ad click ID (ctwa_clid) is missing. Meta can only attribute a WhatsApp event to the ad click it came from. It is in referral.ctwa_clid, in the webhook of the message that came from the ad.',
    );
  } else if (typeof clid !== 'string') {
    report.error('user_data.ctwa_clid', `ctwa_clid must be a string, not ${show(clid)}.`);
  } else if (isHashed(clid)) {
    report.error('user_data.ctwa_clid', 'ctwa_clid looks hashed. Send it exactly as the webhook gave it: Meta never wants it hashed.');
  }

  const waba = user.whatsapp_business_account_id;
  const hasPage = !isBlank(user.page_id);
  if (isBlank(waba)) {
    if (hasPage) {
      report.error(
        'user_data.page_id',
        'user_data has page_id but no whatsapp_business_account_id. Meta identifies WhatsApp events by the WhatsApp Business Account: with page_id, the live API answered 2804131.',
        2804131,
      );
    } else {
      report.error(
        'user_data.whatsapp_business_account_id',
        'whatsapp_business_account_id is missing. Meta identifies WhatsApp events by the WhatsApp Business Account, not by the Page.',
      );
    }
  } else {
    const id = String(waba).trim();
    if (!/^\d+$/.test(id)) {
      report.error('user_data.whatsapp_business_account_id', `whatsapp_business_account_id must be a numeric ID, not ${show(waba)}.`);
    } else if (!isBlank(datasetId) && id === String(datasetId).trim()) {
      report.error(
        'user_data.whatsapp_business_account_id',
        'whatsapp_business_account_id is the dataset ID you are sending to. Put the WhatsApp Business Account ID here.',
      );
    } else if (!isBlank(pageId) && id === String(pageId).trim()) {
      report.error(
        'user_data.whatsapp_business_account_id',
        'whatsapp_business_account_id is your Facebook Page ID. Put the WhatsApp Business Account ID here.',
      );
    }
    if (hasPage) {
      report.warning('user_data.page_id', 'page_id is not part of a WhatsApp event. Remove it and keep whatsapp_business_account_id.');
    }
  }

  for (const [field, argument] of [['ph', 'phone'], ['em', 'email']]) {
    if (user[field] === undefined) continue;
    const values = Array.isArray(user[field]) ? user[field] : [user[field]];
    if (!values.length || !values.every(isHashed)) {
      report.error(
        `user_data.${field}`,
        `${field} must be a SHA-256 hash in lowercase hex. Pass ${argument} to buildEvent and it normalizes and hashes it for you.`,
      );
    }
  }
}

function checkCustomData(custom, name, report) {
  if (custom !== undefined && !isObject(custom)) {
    report.error('custom_data', 'custom_data must be a JSON object.');
  }
  const data = isObject(custom) ? custom : {};
  const hasValue = !isBlank(data.value);
  const hasCurrency = !isBlank(data.currency);

  if (hasValue && (typeof data.value !== 'number' || !Number.isFinite(data.value))) {
    report.error('custom_data.value', `value must be a number, such as 49.9, not ${show(data.value)}.`);
  }
  if (hasCurrency && !/^[A-Za-z]{3}$/.test(String(data.currency))) {
    report.error('custom_data.currency', `currency must be a three-letter ISO 4217 code such as EUR or USD, not ${show(data.currency)}.`);
  }

  if (name === 'Purchase') {
    if (!hasValue) report.error('custom_data.value', 'A Purchase needs custom_data.value. Meta requires value and currency on purchases.');
    if (!hasCurrency) report.error('custom_data.currency', 'A Purchase needs custom_data.currency. Meta requires value and currency on purchases.');
  } else if (name === 'OrderCreated' && !hasCurrency) {
    report.error(
      'custom_data.currency',
      'OrderCreated needs custom_data.currency. The live API refused an OrderCreated event without one (2804081).',
      2804081,
    );
  } else if (!hasCurrency && typeof name === 'string' && name.startsWith('Order')) {
    report.warning(
      'custom_data.currency',
      `${name} has no currency. The live API refused OrderCreated without one (2804081), so send value and currency on every order event.`,
    );
  } else if (!hasCurrency && hasValue) {
    report.warning('custom_data.currency', 'custom_data has a value but no currency. Add the currency the value is in, such as EUR.');
  }
}

/**
 * Everything Meta would refuse in this event, and what looks wrong, in plain words.
 * Each problem is { level: 'error' | 'warning', field, message } and, when Meta has one for it, the
 * subcode it answers with. An error means Meta refuses the event (and the rest of its request) or
 * cannot attribute it. A warning means it may go through but something is probably wrong.
 *
 * Pass the dataset ID and your Page ID when you have them: they catch either one used where the
 * WhatsApp Business Account ID belongs.
 */
export function validateEvent(event, { now = Date.now(), datasetId, pageId } = {}) {
  const problems = [];
  const add = (level) => (field, message, code) => problems.push(code ? { level, field, message, code } : { level, field, message });
  const report = { error: add('error'), warning: add('warning') };

  if (!isObject(event)) {
    report.error('event', 'The event is not a JSON object.');
    return problems;
  }

  checkName(event.event_name, report);
  if (event.action_source !== 'business_messaging') {
    const found = isBlank(event.action_source) ? 'is missing' : `is ${show(event.action_source)}`;
    report.error('action_source', `action_source ${found}. Events from click-to-WhatsApp ads use "business_messaging".`);
  }
  if (event.messaging_channel !== 'whatsapp') {
    const found = isBlank(event.messaging_channel) ? 'is missing' : `is ${show(event.messaging_channel)}`;
    report.error('messaging_channel', `messaging_channel ${found}. For WhatsApp events it must be "whatsapp".`);
  }
  checkTime(event.event_time, Math.floor(now / 1000), report);
  if (isBlank(event.event_id) || String(event.event_id).trim() === '') {
    report.error(
      'event_id',
      'event_id is missing. Give every event a stable ID, such as the order ID and the event name, so a retry is never counted twice.',
    );
  }
  checkUserData(event.user_data, { datasetId, pageId }, report);
  checkCustomData(event.custom_data, event.event_name, report);
  return problems;
}
