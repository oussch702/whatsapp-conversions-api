import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { run } from '../src/cli.js';
import { buildEvent } from '../src/event.js';
import { openLedger } from '../src/ledger.js';
import { sendEvents } from '../src/send.js';

const TOKEN = 'test-token-never-printed';
const DATASET = '200000000000002';
const PIXEL = '200000000000099';
const WABA = '100000000000001';

// A stand-in for graph.facebook.com on 127.0.0.1, strict in the ways the live API was strict, and in
// the order it checked: event name, then the link to the WhatsApp business, then the currency.
// Error bodies have the shape Meta returns. The wording for 2804081 and the "no Page associated to
// dataset" fragment for 2804131 come from real answers. The 2804066 wording is a placeholder, and
// the currency rule for Purchase follows Meta's docs rather than an answer we saw.
const ACCEPTED = new Set([
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
const NEEDS_CURRENCY = new Set(['OrderCreated', 'Purchase']);

const failure = (fields) => ({ error: { message: 'Invalid parameter', type: 'OAuthException', is_transient: false, fbtrace_id: 'FakeTrace', ...fields } });
const NO_PAGE = failure({ code: 100, error_subcode: 2804131, error_user_msg: 'no Page associated to dataset' });

function judge(datasetId, events) {
  if (datasetId !== DATASET) return NO_PAGE; // a website pixel, with no Page behind it
  for (const event of events) {
    if (!ACCEPTED.has(event.event_name)) {
      return failure({ code: 100, error_subcode: 2804066, error_user_msg: `${event.event_name} is not accepted for business messaging.` });
    }
    if (!event.user_data?.whatsapp_business_account_id) return NO_PAGE;
    if (NEEDS_CURRENCY.has(event.event_name) && !event.custom_data?.currency) {
      return failure({
        code: 100,
        error_subcode: 2804081,
        error_user_title: `${event.event_name} event currency missing`,
        error_user_msg: `There is no currency provided in custom_data for ${event.event_name} event.`,
      });
    }
  }
  return null;
}

/** answer: 'meta' judges like the live API, 'zero' answers 200 with events_received 0, 'unavailable' a 503 page. */
async function startFakeGraph() {
  const requests = [];
  const state = { answer: 'meta' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/html' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const route = /^\/v\d+\.\d+\/(\d+)\/events$/.exec(req.url);
    if (req.method !== 'POST' || !route) return reply(400, failure({ code: 100, message: 'Unsupported request' }));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply(400, failure({ code: 190, message: 'Invalid OAuth access token.' }));
    }
    if (state.answer === 'unavailable') return reply(503, '<html><body>Service Unavailable</body></html>');
    if (state.answer === 'zero') return reply(200, { events_received: 0, messages: [], fbtrace_id: 'FakeTrace' });
    const events = Array.isArray(body.data) ? body.data : [];
    const refusal = judge(route[1], events);
    return refusal ? reply(400, refusal) : reply(200, { events_received: events.length, messages: [], fbtrace_id: 'FakeTrace' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    state,
    fetch: (url, init) => globalThis.fetch(String(url).replace('https://graph.facebook.com', base), init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const graph = await startFakeGraph();
after(() => graph.close());
beforeEach(() => {
  graph.state.answer = 'meta';
  graph.requests.length = 0;
});

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capi-send-'));
const tempLedger = () => path.join(tempDir(), 'ledger.json');
const order = (overrides = {}) =>
  buildEvent({ eventName: 'OrderCreated', wabaId: WABA, ctwaClid: 'ARexampleClick', orderId: 1042, value: 49.9, currency: 'EUR', ...overrides });
const options = (overrides = {}) => ({ datasetId: DATASET, accessToken: TOKEN, fetch: graph.fetch, ...overrides });

test('sends an event and resolves with what Meta received', async () => {
  const event = order();
  const result = await sendEvents({ ...options(), events: [event], testEventCode: 'TEST123' });
  assert.equal(result.eventsReceived, 1);
  assert.deepEqual(result.sent, ['1042:OrderCreated']);
  assert.equal(result.fbtraceId, 'FakeTrace');

  const [request] = graph.requests;
  assert.equal(request.url, `/v25.0/${DATASET}/events`);
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(request.url, /token/i);
  assert.deepEqual(request.body, { data: [event], test_event_code: 'TEST123' });
});

test('sends nothing when one event would be refused, since Meta refuses the whole request', async () => {
  await assert.rejects(sendEvents({ ...options(), events: [order(), order({ eventName: 'Lead', orderId: 1043 })] }), (err) => {
    assert.equal(err.kind, 'invalid');
    assert.equal(err.problems[0].index, 1);
    assert.equal(err.problems[0].code, 2804066);
    return true;
  });
  assert.equal(graph.requests.length, 0);
});

test('explains 2804066 when a name Meta does not accept reaches it', async () => {
  await assert.rejects(sendEvents({ ...options(), events: [order({ eventName: 'Lead' })], skipChecks: true }), (err) => {
    assert.equal(err.kind, 'rejected');
    assert.equal(err.status, 400);
    assert.equal(err.explanation.subcode, 2804066);
    assert.match(err.explanation.fix, /LeadSubmitted/);
    return true;
  });
});

test('explains 2804131 for events sent to a website pixel', async () => {
  await assert.rejects(sendEvents({ ...options({ datasetId: PIXEL }), events: [order()] }), (err) => {
    assert.equal(err.explanation.subcode, 2804131);
    assert.equal(err.explanation.metaMessage, 'no Page associated to dataset');
    return true;
  });
});

test('explains 2804131 for a Page ID instead of the WhatsApp Business Account ID', async () => {
  const event = order();
  delete event.user_data.whatsapp_business_account_id;
  event.user_data.page_id = '300000000000003';
  await assert.rejects(sendEvents({ ...options(), events: [event], skipChecks: true }), (err) => err.explanation.subcode === 2804131);
});

test('explains 2804081 for an order event without a currency', async () => {
  await assert.rejects(sendEvents({ ...options(), events: [order({ currency: undefined })], skipChecks: true }), (err) => {
    assert.equal(err.explanation.subcode, 2804081);
    assert.equal(err.explanation.metaMessage, 'There is no currency provided in custom_data for OrderCreated event.');
    return true;
  });
});

test('treats a 200 with events_received 0 as a failure', async () => {
  graph.state.answer = 'zero';
  await assert.rejects(sendEvents({ ...options(), events: [order()] }), (err) => {
    assert.equal(err.kind, 'not-received');
    assert.equal(err.status, 200);
    assert.match(err.message, /received 0 of 1 event/);
    assert.match(err.explanation.title, /received no event/);
    return true;
  });
});

test('never sends the same order twice, and records only what Meta received', async () => {
  const ledger = openLedger(tempLedger());
  const event = order();

  graph.state.answer = 'zero';
  await assert.rejects(sendEvents({ ...options(), events: [event], ledger }));
  assert.equal(ledger.has(event.event_id), false);

  graph.state.answer = 'meta';
  const first = await sendEvents({ ...options(), events: [event], ledger });
  assert.deepEqual(first.sent, [event.event_id]);

  const again = await sendEvents({ ...options(), events: [event], ledger: ledger.file });
  assert.deepEqual(again.sent, []);
  assert.equal(again.skipped[0].state, 'sent');
  assert.equal(graph.requests.length, 2);
});

test('a refused event can be fixed and sent again', async () => {
  const ledger = openLedger(tempLedger());
  await assert.rejects(sendEvents({ ...options(), events: [order({ currency: undefined })], ledger, skipChecks: true }));
  assert.equal(ledger.has('1042:OrderCreated'), false);
  const fixed = await sendEvents({ ...options(), events: [order()], ledger });
  assert.equal(fixed.eventsReceived, 1);
});

test('explains a refused token without ever showing it', async () => {
  await assert.rejects(sendEvents({ ...options({ accessToken: 'wrong-token-value' }), events: [order()] }), (err) => {
    assert.equal(err.explanation.code, 190);
    const everything = JSON.stringify({ message: err.message, explanation: err.explanation, response: err.response });
    assert.doesNotMatch(everything, /wrong-token-value/);
    return true;
  });
});

test('a connection refused before the request left is safe to retry', async () => {
  const closed = await startFakeGraph();
  await closed.close();
  const ledger = openLedger(tempLedger());
  await assert.rejects(sendEvents({ ...options({ fetch: closed.fetch }), events: [order()], ledger }), (err) => {
    assert.equal(err.kind, 'network');
    assert.equal(err.retry, true);
    return true;
  });
  assert.equal(ledger.has('1042:OrderCreated'), false);
});

test('a connection cut after the request left keeps the event from going out twice', async () => {
  const ledger = openLedger(tempLedger());
  const cut = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  };
  await assert.rejects(sendEvents({ ...options({ fetch: cut }), events: [order()], ledger }), (err) => {
    assert.equal(err.kind, 'network');
    assert.equal(err.retry, false);
    assert.match(err.message, /Meta may have the event/);
    return true;
  });
  assert.equal(ledger.get('1042:OrderCreated').state, 'sending');
  const again = await sendEvents({ ...options(), events: [order()], ledger });
  assert.equal(again.skipped[0].state, 'sending');
  assert.equal(graph.requests.length, 0);
});

test('reports a server error that is not JSON with its status', async () => {
  graph.state.answer = 'unavailable';
  await assert.rejects(sendEvents({ ...options(), events: [order()] }), (err) => {
    assert.equal(err.kind, 'rejected');
    assert.equal(err.status, 503);
    assert.equal(err.retry, true);
    return true;
  });
});

test('refuses arguments that cannot work', async () => {
  await assert.rejects(sendEvents({ ...options({ datasetId: 'my-pixel' }), events: [order()] }), TypeError);
  await assert.rejects(sendEvents({ ...options({ accessToken: '' }), events: [order()] }), TypeError);
  await assert.rejects(sendEvents({ ...options(), events: [] }), TypeError);
  await assert.rejects(sendEvents({ ...options({ fetch: null }), events: [order()] }), /fetch must be a function/);
  const tooMany = Array.from({ length: 1001 }, (_, i) => order({ orderId: i }));
  await assert.rejects(sendEvents({ ...options(), events: tooMany }), /at most 1,000 events/);
  assert.equal(graph.requests.length, 0);
});

test('gives an event back to the ledger when it cannot be written as JSON', async () => {
  const ledger = openLedger(tempLedger());
  const event = order();
  event.custom_data.self = event;
  await assert.rejects(sendEvents({ ...options(), events: [event], ledger, skipChecks: true }), /cannot be written as JSON/);
  assert.equal(ledger.has(event.event_id), false);
  assert.equal(graph.requests.length, 0);
});

// The command line, against the same fake.
const sink = () => {
  const out = { text: '', write: (chunk) => ((out.text += chunk), true) };
  return out;
};
const SEND = ['send', '--dataset', DATASET, '--waba', WABA, '--event', 'OrderCreated', '--ctwa-clid', 'ARexampleClick'];
const cli = async (args, { env = { META_ACCESS_TOKEN: TOKEN }, ledger = tempLedger() } = {}) => {
  const stdout = sink();
  const stderr = sink();
  const code = await run([...args, '--ledger', ledger], { fetchImpl: graph.fetch, stdout, stderr, env });
  assert.doesNotMatch(stdout.text + stderr.text, new RegExp(TOKEN));
  return { code, out: stdout.text, err: stderr.text, ledger };
};

test('command line: sends once, records it, and never sends it again', async () => {
  const args = [...SEND, '--order-id', '1042', '--value', '49.90', '--currency', 'EUR'];
  const first = await cli(args);
  assert.equal(first.code, 0);
  assert.match(first.out, /Sent\. Meta received 1 event \(fbtrace_id FakeTrace\)\./);
  assert.match(first.out, /Recorded in /);

  const second = await cli(args, { ledger: first.ledger });
  assert.equal(second.code, 0);
  assert.match(second.out, /Not sent: this event already went out on \d{4}-\d{2}-\d{2} at \d{2}:\d{2} UTC, according to /);
  assert.match(second.out, /To send it again on purpose, delete its entry from the ledger\./);

  const dryRun = await cli([...args, '--dry-run'], { ledger: first.ledger });
  assert.equal(dryRun.code, 0);
  assert.match(dryRun.out, /A real send would stop here: this event already went out on /);
  assert.equal(graph.requests.length, 1);
});

test("command line: explains Meta's refusal", async () => {
  const args = [...SEND, '--order-id', '1042', '--value', '49.90', '--currency', 'EUR'].map((arg) => (arg === DATASET ? PIXEL : arg));
  const result = await cli(args);
  assert.equal(result.code, 1);
  assert.match(result.out, /Meta refused the event\.\ncode 100 · subcode 2804131 · No Page associated to the dataset/);
  assert.match(result.out, /Meta's message: no Page associated to dataset/);
  assert.match(result.out, /Nothing was recorded in the ledger/);
});

test('command line: a 200 with no event received is a failure', async () => {
  graph.state.answer = 'zero';
  const result = await cli([...SEND, '--order-id', '1042', '--value', '49.90', '--currency', 'EUR']);
  assert.equal(result.code, 1);
  assert.match(result.out, /Meta answered 200 but received no event/);
  assert.match(result.out, /received 0 of 1 event\. Nothing was recorded\./);
});

test('command line: reads the token from a file', async () => {
  const tokenFile = path.join(tempDir(), 'meta.token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  const result = await cli([...SEND, '--order-id', '7', '--value', '10', '--currency', 'USD', '--token-file', tokenFile], { env: {} });
  assert.equal(result.code, 0);
  assert.equal(graph.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});
