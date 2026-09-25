// What Meta's errors mean when you send WhatsApp conversion events, and what to change.
// We could not find subcodes 2804066, 2804131 and 2804081 in Meta's public docs: we met them on the live API.
// The other codes come from Meta's Graph API and Marketing API error references.
import { ACCEPTED_EVENT_NAMES } from './event.js';

const LIVE_API = "Seen on the live API in September 2026. We could not find it in Meta's public docs.";
const GRAPH_ERRORS = 'https://developers.facebook.com/docs/graph-api/guides/error-handling';
const MARKETING_ERRORS = 'https://developers.facebook.com/docs/marketing-api/error-reference';
const PERMISSIONS = 'whatsapp_business_management and whatsapp_business_manage_events';

const SUBCODES = {
  2804066: {
    title: 'Event name not accepted for WhatsApp events',
    meaning:
      'Meta refuses the whole request when event_name is not one of its business messaging names. Lead, Confirmed and Canceled are refused.',
    fix: `Use one of: ${ACCEPTED_EVENT_NAMES.join(', ')}. Lead becomes LeadSubmitted or QualifiedLead, Canceled becomes OrderCanceled.`,
    source: LIVE_API,
  },
  2804131: {
    title: 'No Page associated to the dataset',
    meaning:
      'Meta cannot tie the event to your WhatsApp business. We got it when events went to the website pixel, and again on the WhatsApp dataset while user_data carried page_id instead of whatsapp_business_account_id.',
    fix: 'Send to the dataset linked to your WhatsApp Business Account (POST /<waba-id>/dataset returns its ID), and put whatsapp_business_account_id in user_data instead of page_id.',
    source: LIVE_API,
  },
  2804081: {
    title: 'Currency missing',
    meaning: 'custom_data has no currency. Meta refused an OrderCreated event for this, and it requires a currency on every Purchase.',
    fix: 'Add custom_data.currency, a three-letter code such as EUR, next to custom_data.value on every order event.',
    source: LIVE_API,
  },
};

const temporary = { fix: 'Wait, then send again. Meta took nothing, so the ledger does not block the retry.', retry: true, source: GRAPH_ERRORS };
const permission = {
  meaning: 'The access token is missing a permission, or it was removed.',
  fix: `Use a token with ${PERMISSIONS}.`,
  source: GRAPH_ERRORS,
};
const badToken = {
  meaning: 'The access token has expired, been revoked, or is otherwise invalid.',
  fix: `Get a new access token with ${PERMISSIONS}.`,
  source: GRAPH_ERRORS,
};

const CODES = [
  { code: 1, title: 'API Unknown', meaning: "Possibly a temporary problem on Meta's side.", ...temporary },
  { code: 2, title: 'API Service', meaning: "A temporary problem on Meta's side.", ...temporary },
  { code: 3, title: 'API Method', ...permission, meaning: 'The app is missing a capability or a permission for this call.' },
  { code: 4, title: 'API Too Many Calls', meaning: 'Meta is throttling your app.', ...temporary },
  { code: 10, title: 'API Permission Denied', ...permission },
  { code: 17, title: 'API User Too Many Calls', meaning: 'Meta is throttling this user or token.', ...temporary },
  {
    code: 100,
    title: 'Invalid parameter',
    meaning: "A field in the request is wrong. The subcode and Meta's own message say which one.",
    fix: "Read Meta's message (error_user_msg) in full, since it can name the values Meta accepts, and run validate on the event.",
    source: MARKETING_ERRORS,
  },
  { code: 102, title: 'API Session', ...badToken },
  { code: 190, title: 'Invalid or expired access token', ...badToken },
  { from: 200, to: 299, title: 'API Permission', ...permission },
  { code: 341, title: 'Application limit reached', meaning: 'A temporary limit on your app.', ...temporary },
  { code: 368, title: 'Temporarily blocked for policies violations', meaning: 'Meta has blocked the app for a while.', ...temporary },
];

const NOT_RECEIVED = {
  title: 'Meta answered 200 but received no event',
  meaning: 'A 200 status is not a receipt. The response said events_received: 0, so Meta did not take the event, and it did not say why.',
  fix: 'Read the messages field of the response. Then send the event once with a test event code and watch the Test Events tab in Events Manager.',
  source: LIVE_API,
};

/** The table explainError reads, for anyone who wants to show it their own way. */
export const KNOWN_ERRORS = Object.freeze({ subcodes: SUBCODES, codes: CODES, notReceived: NOT_RECEIVED });

const toNumber = (value) => (value === undefined || value === null || value === '' || Number.isNaN(Number(value)) ? undefined : Number(value));

/** Pulls the useful fields out of a code, a Graph API response, its error object, or a ConversionsApiError. */
function read(input) {
  if (input instanceof Error && 'response' in input) return read(input.response ?? {});
  if (typeof input === 'number') return { number: input };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return { number: Number(trimmed) };
    try {
      return read(JSON.parse(trimmed));
    } catch {
      return {};
    }
  }
  if (input && typeof input === 'object') {
    const err = input.error && typeof input.error === 'object' ? input.error : input;
    if ('code' in err || 'error_subcode' in err) {
      return {
        code: toNumber(err.code),
        subcode: toNumber(err.error_subcode),
        message: err.message,
        metaTitle: err.error_user_title,
        metaMessage: err.error_user_msg,
        fbtraceId: err.fbtrace_id ?? input.fbtrace_id,
        transient: err.is_transient === true,
      };
    }
    if ('events_received' in input) return { received: Number(input.events_received), fbtraceId: input.fbtrace_id };
  }
  return {};
}

const byCode = (code) => CODES.find((entry) => entry.code === code || (entry.from <= code && code <= entry.to));

/**
 * Plain-language meaning of a Meta error, and what to change.
 * Takes a code or subcode (2804066, "190"), a Graph API error response, a response with
 * events_received, or a ConversionsApiError. Meta's own title and message are passed through whole.
 */
export function explainError(input) {
  const found = read(input);
  const meta = {
    ...(found.message && { message: found.message }),
    ...(found.metaTitle && { metaTitle: found.metaTitle }),
    ...(found.metaMessage && { metaMessage: found.metaMessage }),
    ...(found.fbtraceId && { fbtraceId: found.fbtraceId }),
  };

  if (found.received !== undefined) {
    if (found.received > 0) {
      const events = `${found.received} event${found.received === 1 ? '' : 's'}`;
      return { known: true, code: null, subcode: null, title: 'Not an error', meaning: `Meta received ${events}.`, fix: 'Nothing to fix.', retry: false, source: null, ...meta };
    }
    return { known: true, code: null, subcode: null, ...NOT_RECEIVED, retry: false, ...meta };
  }

  let { code, subcode } = found;
  if (found.number !== undefined) {
    if (SUBCODES[found.number]) subcode = found.number;
    else code = found.number;
  }
  const entry = (subcode !== undefined && SUBCODES[subcode]) || (code !== undefined && byCode(code));
  const ids = { code: code ?? null, subcode: subcode ?? null };
  if (!entry) {
    return {
      known: false,
      ...ids,
      title: 'Not in our table',
      meaning: 'We have not met this error, and it is not one of the codes Meta documents for sending events.',
      fix: "Read Meta's message (error_user_msg) in full: it is the most specific part of the error. If you find the fix, open an issue so it can go in the table.",
      retry: Boolean(found.transient),
      source: null,
      ...meta,
    };
  }
  return {
    known: true,
    ...ids,
    title: entry.title,
    meaning: entry.meaning,
    fix: entry.fix,
    retry: Boolean(entry.retry || found.transient),
    source: entry.source,
    ...meta,
  };
}
