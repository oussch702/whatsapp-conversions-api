// Posts events to a dataset's /events edge on the Graph API, and never reports a success Meta did not confirm.
import { explainError } from './errors.js';
import { Ledger } from './ledger.js';
import { validateEvent } from './validate.js';

/** The version in the examples of Meta's Conversions API docs, supported until July 2028. */
export const DEFAULT_API_VERSION = 'v25.0';

/** Meta takes up to 1,000 events in one request. */
export const MAX_EVENTS_PER_REQUEST = 1000;

const GRAPH = 'https://graph.facebook.com';

// Connection errors raised before the request left this machine: Meta cannot have received it.
const NEVER_LEFT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * A send that did not go through. `kind` says why:
 * - 'invalid': the checks found problems Meta would refuse, and nothing was sent (see `problems`).
 * - 'rejected': Meta answered with an error (see `explanation` and `response`).
 * - 'not-received': Meta answered 200 but received fewer events than were sent.
 * - 'network': no usable answer. `retry` says whether sending again is safe.
 */
export class ConversionsApiError extends Error {
  constructor(message, { kind, status = null, problems = [], explanation = null, response = null, retry = false } = {}) {
    super(message);
    this.name = 'ConversionsApiError';
    this.kind = kind;
    this.status = status;
    this.problems = problems;
    this.explanation = explanation;
    this.response = response;
    this.retry = retry;
  }
}

const redact = (text, secret) => (secret ? String(text).split(secret).join('[token]') : String(text));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function checkArguments({ datasetId, accessToken, events, apiVersion, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function. Node.js 20 or later has one built in.');
  if (!/^\d+$/.test(String(datasetId ?? '').trim())) {
    throw new TypeError('datasetId must be the numeric ID of the dataset linked to your WhatsApp Business Account.');
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) throw new TypeError('accessToken is missing.');
  if (!Array.isArray(events) || !events.length) throw new TypeError('events must be a non-empty array.');
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    throw new TypeError(`Meta takes at most ${MAX_EVENTS_PER_REQUEST.toLocaleString('en-US')} events per request. Split them into several calls.`);
  }
  if (!/^v\d+\.\d+$/.test(String(apiVersion))) throw new TypeError(`apiVersion looks like ${DEFAULT_API_VERSION}.`);
}

/** Checks every event, plus one rule only a batch can break: the same event_id twice. */
function checkEvents(events, { now, datasetId }) {
  const problems = [];
  const seen = new Map();
  events.forEach((event, index) => {
    const eventId = event?.event_id;
    for (const problem of validateEvent(event, { now, datasetId })) problems.push({ index, eventId, ...problem });
    if (eventId === undefined || eventId === null || eventId === '') return;
    if (seen.has(eventId)) {
      problems.push({ index, eventId, level: 'error', field: 'event_id', message: `The same event_id is already event ${seen.get(eventId) + 1} of this request.` });
    } else {
      seen.set(eventId, index);
    }
  });
  return problems;
}

/**
 * Sends events to Meta and resolves only when Meta confirms it received every one of them.
 *
 * The events are checked first, and nothing is sent when one of them has an error, because Meta
 * refuses the whole request for a single invalid event. With a ledger (a Ledger or a file path),
 * events already sent are skipped, and the ones Meta receives are recorded.
 *
 * Resolves to { eventsReceived, sent, skipped, warnings, messages, fbtraceId }.
 * Rejects with a ConversionsApiError otherwise, including when Meta answers 200 with events_received: 0.
 * The access token travels in the Authorization header, never in the URL, and never appears in an error.
 */
export async function sendEvents({
  datasetId,
  accessToken,
  events,
  testEventCode,
  apiVersion = DEFAULT_API_VERSION,
  fetch: fetchImpl = globalThis.fetch,
  ledger,
  skipChecks = false,
  timeoutMs = 15_000,
  now = Date.now(),
} = {}) {
  checkArguments({ datasetId, accessToken, events, apiVersion, fetchImpl });
  const token = accessToken.trim();
  const book = typeof ledger === 'string' ? new Ledger(ledger) : ledger;

  const problems = checkEvents(events, { now, datasetId });
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');
  if (errors.length && !skipChecks) {
    throw new ConversionsApiError(`${plural(errors.length, 'problem')} Meta would refuse. Nothing was sent.`, { kind: 'invalid', problems });
  }

  let toSend = events;
  const skipped = [];
  if (book) {
    if (events.some((event) => !event?.event_id)) throw new TypeError('With a ledger, every event needs an event_id.');
    const free = new Set(book.claim(events.map((event) => ({ eventId: event.event_id, eventName: event.event_name }))));
    const taken = new Set();
    toSend = [];
    for (const event of events) {
      const id = event.event_id;
      if (taken.has(id)) {
        skipped.push({ eventId: id, state: 'duplicate' });
      } else if (free.has(id)) {
        toSend.push(event);
        taken.add(id);
      } else {
        skipped.push({ eventId: id, ...book.get(id) });
      }
    }
    if (!toSend.length) return { eventsReceived: 0, sent: [], skipped, warnings, messages: [], fbtraceId: null };
  }
  const ids = toSend.map((event) => event.event_id);
  const release = () => book?.release(ids);

  const body = { data: toSend };
  if (testEventCode) body.test_event_code = String(testEventCode);
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    release();
    throw new TypeError(`The events cannot be written as JSON: ${err.message}`);
  }

  let res;
  let text;
  try {
    res = await fetchImpl(`${GRAPH}/${apiVersion}/${String(datasetId).trim()}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = redact(await res.text(), token);
  } catch (err) {
    const reason = redact(err.cause?.message || err.message, token);
    if (NEVER_LEFT.has(err.cause?.code ?? err.code)) {
      release();
      throw new ConversionsApiError(`Could not reach Meta (${reason}). Nothing left this machine, so it is safe to send again.`, {
        kind: 'network',
        retry: true,
      });
    }
    const [noun, pronoun] = toSend.length === 1 ? ['event', 'it'] : ['events', 'them'];
    const kept = book ? `The ledger keeps ${pronoun} marked as sending. ` : '';
    throw new ConversionsApiError(
      `The connection failed after the request left (${reason}), so Meta may have the ${noun}. ${kept}Check the dataset in Events Manager before sending again.`,
      { kind: 'network', retry: false },
    );
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON, from a proxy for example. Handled below.
  }

  if (!res.ok || json?.error) {
    release();
    const explanation = json?.error ? explainError(json) : null;
    const summary = explanation
      ? `${[explanation.code, explanation.subcode].filter((n) => n !== null).join('/')} ${explanation.title}`
      : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    throw new ConversionsApiError(`Meta refused the request (${summary}). Nothing was recorded, so it can be sent again once fixed.`, {
      kind: 'rejected',
      status: res.status,
      explanation,
      response: json,
      retry: explanation ? explanation.retry : res.status >= 500,
    });
  }

  const received = Number(json?.events_received ?? 0);
  if (!(received >= toSend.length)) {
    const summary = `Meta answered ${res.status} but received ${received} of ${plural(toSend.length, 'event')}`;
    if (received > 0) {
      // Meta does not say which ones it took. Resending could count some twice: leave them marked as sending.
      throw new ConversionsApiError(`${summary}, without saying which. Check the dataset in Events Manager before sending again.`, {
        kind: 'not-received',
        status: res.status,
        response: json,
      });
    }
    release();
    throw new ConversionsApiError(`${summary}. Nothing was recorded.`, {
      kind: 'not-received',
      status: res.status,
      explanation: explainError({ ...json, events_received: received }),
      response: json,
    });
  }

  const fbtraceId = json.fbtrace_id ?? null;
  // Meta's docs say test events still count for targeting and measurement, so a test send is recorded too.
  book?.record(ids, { ...(fbtraceId && { fbtraceId }), ...(testEventCode && { test: true }) });
  return { eventsReceived: received, sent: ids, skipped, warnings, messages: json.messages ?? [], fbtraceId };
}
