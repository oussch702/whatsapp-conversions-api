import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvent } from '../src/event.js';
import { validateEvent } from '../src/validate.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const NOW_SECONDS = NOW / 1000;
const WABA = '100000000000001';
const DATASET = '200000000000002';
const PAGE = '300000000000003';

const order = (overrides = {}) =>
  buildEvent({
    eventName: 'OrderCreated',
    wabaId: WABA,
    ctwaClid: 'ARexampleClick',
    orderId: 1042,
    value: 49.9,
    currency: 'EUR',
    now: NOW,
    ...overrides,
  });
const check = (event, options = {}) => validateEvent(event, { now: NOW, datasetId: DATASET, ...options });
const problem = (event, field, options) => check(event, options).find((p) => p.field === field);

test('a correct event has no problems', () => {
  assert.deepEqual(check(order()), []);
  assert.deepEqual(check(order({ eventName: 'Purchase' })), []);
  assert.deepEqual(check(order({ phone: '+1 202 555 0147' })), []);
});

test('refuses the names the live API refused, and says what to send instead', () => {
  for (const [name, instead] of [
    ['Lead', /LeadSubmitted/],
    ['Confirmed', /QualifiedLead/],
    ['Canceled', /OrderCanceled/],
  ]) {
    const found = problem(order({ eventName: name }), 'event_name');
    assert.equal(found.level, 'error');
    assert.equal(found.code, 2804066);
    assert.match(found.message, instead);
  }
});

test('suggests the right spelling for a near miss', () => {
  assert.match(problem(order({ eventName: 'purchase' }), 'event_name').message, /Did you mean Purchase\?/);
  assert.match(problem(order({ eventName: 'OrderCancelled' }), 'event_name').message, /Did you mean OrderCanceled\?/);
  assert.match(problem(order({ eventName: 'Contact' }), 'event_name').message, /Use one of: ViewContent, LeadSubmitted/);
});

test('warns, without blocking, on names only the docs list', () => {
  const found = problem(order({ eventName: 'CartAbandoned' }), 'event_name');
  assert.equal(found.level, 'warning');
  assert.match(found.message, /test event code/);
});

test('needs the ad click ID, exactly as the webhook gave it', () => {
  const missing = order();
  delete missing.user_data.ctwa_clid;
  assert.match(problem(missing, 'user_data.ctwa_clid').message, /referral\.ctwa_clid/);
  assert.match(problem(order({ ctwaClid: 'a'.repeat(64) }), 'user_data.ctwa_clid').message, /looks hashed/);
});

test('catches a Page ID where the WhatsApp Business Account ID belongs', () => {
  const withPage = order();
  delete withPage.user_data.whatsapp_business_account_id;
  withPage.user_data.page_id = PAGE;
  const found = problem(withPage, 'user_data.page_id');
  assert.equal(found.level, 'error');
  assert.equal(found.code, 2804131);

  const field = 'user_data.whatsapp_business_account_id';
  assert.match(problem(order({ wabaId: PAGE }), field, { pageId: PAGE }).message, /Facebook Page ID/);
  assert.match(problem(order({ wabaId: DATASET }), field).message, /dataset ID/);
  assert.match(problem(order({ wabaId: 'YOUR_WABA_ID' }), field).message, /numeric ID/);

  const both = order();
  both.user_data.page_id = PAGE;
  assert.equal(problem(both, 'user_data.page_id').level, 'warning');
});

test('needs a currency on OrderCreated and Purchase, and suggests one on other order events', () => {
  const created = problem(order({ value: undefined, currency: undefined }), 'custom_data.currency');
  assert.equal(created.level, 'error');
  assert.equal(created.code, 2804081);

  const purchase = check(order({ eventName: 'Purchase', value: undefined, currency: undefined }));
  assert.deepEqual(
    purchase.map((p) => [p.level, p.field]),
    [
      ['error', 'custom_data.value'],
      ['error', 'custom_data.currency'],
    ],
  );

  const shipped = problem(order({ eventName: 'OrderShipped', value: undefined, currency: undefined }), 'custom_data.currency');
  assert.equal(shipped.level, 'warning');
  assert.match(shipped.message, /send value and currency on every order event/);
  const viewed = problem(order({ eventName: 'ViewContent', currency: undefined }), 'custom_data.currency');
  assert.equal(viewed.level, 'warning');
  assert.match(viewed.message, /a value but no currency/);
  assert.equal(problem(order({ eventName: 'ViewContent', value: undefined, currency: undefined }), 'custom_data.currency'), undefined);
});

test('needs a numeric value and a three-letter currency', () => {
  assert.match(problem(order({ value: '49,90' }), 'custom_data.value').message, /must be a number, such as 49\.9, not "49,90"/);
  assert.match(problem(order({ currency: '€' }), 'custom_data.currency').message, /three-letter ISO 4217 code/);
});

test('checks event_time: seconds, no more than 7 days old, not in the future', () => {
  assert.match(problem(order({ eventTime: NOW }), 'event_time').message, /looks like milliseconds/);
  assert.match(problem(order({ eventTime: NOW_SECONDS - 8 * 86400 }), 'event_time').message, /is 8 days old\./);
  assert.match(problem(order({ eventTime: NOW_SECONDS - 7 * 86400 - 3600 }), 'event_time').message, /is 7 days and 1 hour old\./);
  assert.equal(problem(order({ eventTime: NOW_SECONDS - 6 * 86400 }), 'event_time'), undefined);
  assert.match(problem(order({ eventTime: NOW_SECONDS + 3 * 3600 }), 'event_time').message, /3 hours in the future/);
  assert.equal(problem(order({ eventTime: NOW_SECONDS + 60 }), 'event_time'), undefined);
  assert.match(problem(order({ eventTime: 'yesterday' }), 'event_time').message, /whole number of seconds/);
});

test('checks the fields every WhatsApp event carries', () => {
  const event = order();
  event.action_source = 'website';
  delete event.messaging_channel;
  delete event.event_id;
  assert.deepEqual(
    check(event).map((p) => p.field),
    ['action_source', 'messaging_channel', 'event_id'],
  );
});

test('needs customer details hashed', () => {
  const event = order();
  event.user_data.ph = ['+12025550147'];
  assert.match(problem(event, 'user_data.ph').message, /SHA-256/);
});

test('says so when the event is not an object', () => {
  assert.deepEqual(
    check(null).map((p) => p.field),
    ['event'],
  );
  assert.deepEqual(
    check('{}').map((p) => p.field),
    ['event'],
  );
});
