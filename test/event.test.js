import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildEvent, hashEmail, hashPhone, normalizePhone, toUnixSeconds } from '../src/event.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('builds the exact business messaging payload', () => {
  const event = buildEvent({
    eventName: 'Purchase',
    wabaId: '100000000000001',
    ctwaClid: 'ARexampleClick',
    orderId: 1042,
    value: 49.9,
    currency: 'eur',
    now: NOW,
  });
  assert.deepEqual(event, {
    event_name: 'Purchase',
    event_time: NOW / 1000,
    event_id: '1042:Purchase',
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: '100000000000001', ctwa_clid: 'ARexampleClick' },
    custom_data: { value: 49.9, currency: 'EUR', order_id: '1042' },
  });
});

test('normalizes a phone number the way Meta matches it', () => {
  assert.equal(normalizePhone('+1 (202) 555-0147'), '12025550147');
  assert.equal(normalizePhone('00 1 202 555 0147'), '12025550147');
  assert.equal(hashPhone('+1 (202) 555-0147'), sha256('12025550147'));
  assert.equal(hashPhone('no digits'), undefined);
});

test('normalizes an email the way Meta matches it', () => {
  assert.equal(hashEmail('  Someone@Example.COM '), sha256('someone@example.com'));
  assert.equal(hashEmail('   '), undefined);
});

test('never hashes twice', () => {
  const digest = sha256('12025550147');
  assert.equal(hashPhone(digest), digest);
  assert.equal(hashEmail(digest.toUpperCase()), digest);
});

test('hashes customer details into user_data and leaves the click ID as the webhook gave it', () => {
  const event = buildEvent({
    eventName: 'OrderCreated',
    wabaId: '100000000000001',
    ctwaClid: 'ARexampleClick',
    orderId: 'A-7',
    currency: 'EUR',
    phone: '+1 202 555 0147',
    email: 'someone@example.com',
    now: NOW,
  });
  assert.deepEqual(event.user_data.ph, [sha256('12025550147')]);
  assert.deepEqual(event.user_data.em, [sha256('someone@example.com')]);
  assert.equal(event.user_data.ctwa_clid, 'ARexampleClick');
});

test('keeps the event ID stable, so a retry is recognized as the same event', () => {
  const first = buildEvent({ eventName: 'OrderCreated', orderId: 7, now: NOW });
  const retry = buildEvent({ eventName: 'OrderCreated', orderId: '7', now: NOW + 60_000 });
  assert.equal(first.event_id, '7:OrderCreated');
  assert.equal(retry.event_id, first.event_id);
  assert.equal(buildEvent({ eventName: 'ViewContent', eventId: 'chat-1:ViewContent' }).event_id, 'chat-1:ViewContent');
  assert.equal(buildEvent({ eventName: 'ViewContent' }).event_id, undefined);
});

test('reads event times as Unix seconds', () => {
  assert.equal(toUnixSeconds(undefined, NOW), NOW / 1000);
  assert.equal(toUnixSeconds(new Date('2026-09-20T11:00:00Z')), NOW / 1000 - 3600);
  assert.equal(toUnixSeconds('2026-09-20T11:00:00Z'), NOW / 1000 - 3600);
  assert.equal(toUnixSeconds('1789999999'), 1789999999);
  assert.equal(toUnixSeconds('yesterday'), 'yesterday');
});

test('leaves a value that is not a number for the checks to report', () => {
  assert.equal(buildEvent({ eventName: 'Purchase', value: '49,90' }).custom_data.value, '49,90');
});
