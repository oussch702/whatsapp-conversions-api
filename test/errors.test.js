import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_ERRORS, explainError } from '../src/errors.js';

// The shape of the answer the live API gave for an OrderCreated event without a currency.
const CURRENCY_MISSING = {
  error: {
    message: 'Invalid parameter',
    type: 'OAuthException',
    code: 100,
    error_subcode: 2804081,
    is_transient: false,
    error_user_title: 'OrderCreated event currency missing',
    error_user_msg: 'There is no currency provided in custom_data for OrderCreated event.',
    fbtrace_id: 'FakeTrace',
  },
};

test('explains the three subcodes met on the live API', () => {
  for (const subcode of [2804066, 2804131, 2804081]) {
    const explanation = explainError(subcode);
    assert.equal(explanation.known, true);
    assert.equal(explanation.subcode, subcode);
    assert.match(explanation.source, /live API/);
  }
  assert.match(explainError('2804066').fix, /LeadSubmitted/);
  assert.match(explainError(2804131).fix, /whatsapp_business_account_id/);
  assert.match(explainError(2804081).fix, /currency/);
});

test("reads a full error response and keeps Meta's own words whole", () => {
  const explanation = explainError(CURRENCY_MISSING);
  assert.equal(explanation.code, 100);
  assert.equal(explanation.subcode, 2804081);
  assert.equal(explanation.title, 'Currency missing');
  assert.equal(explanation.metaTitle, 'OrderCreated event currency missing');
  assert.equal(explanation.metaMessage, 'There is no currency provided in custom_data for OrderCreated event.');
  assert.equal(explanation.fbtraceId, 'FakeTrace');
  assert.equal(explainError(CURRENCY_MISSING.error).subcode, 2804081);
  assert.equal(explainError(JSON.stringify(CURRENCY_MISSING)).subcode, 2804081);
});

test('treats a 200 with no event received as a failure', () => {
  const explanation = explainError({ events_received: 0, messages: [], fbtrace_id: 'FakeTrace' });
  assert.equal(explanation.known, true);
  assert.match(explanation.title, /received no event/);
  assert.equal(explainError({ events_received: 1 }).title, 'Not an error');
});

test('explains the Graph API codes Meta documents, ranges included', () => {
  assert.match(explainError(190).fix, /new access token/);
  assert.equal(explainError(250).title, 'API Permission');
  assert.equal(explainError(4).retry, true);
  assert.equal(explainError(100).retry, false);
  assert.equal(explainError({ error: { code: 100, error_subcode: 1234567 } }).title, 'Invalid parameter');
});

test('says plainly when an error is not in the table', () => {
  const explanation = explainError(99999);
  assert.equal(explanation.known, false);
  assert.match(explanation.fix, /error_user_msg/);
  assert.equal(explainError({ error: { code: 99999, is_transient: true } }).retry, true);
  assert.equal(explainError('not json at all').known, false);
});

test('every entry in the table says where it comes from', () => {
  const entries = [...Object.values(KNOWN_ERRORS.subcodes), ...KNOWN_ERRORS.codes, KNOWN_ERRORS.notReceived];
  for (const entry of entries) {
    assert.ok(entry.title && entry.meaning && entry.fix && entry.source, JSON.stringify(entry));
  }
});
