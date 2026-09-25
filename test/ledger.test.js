import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLedger } from '../src/ledger.js';

const tempLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capi-ledger-')), 'ledger.json');
const event = (eventId, eventName = 'OrderCreated') => ({ eventId, eventName });

test('remembers a sent event across runs', () => {
  const file = tempLedger();
  const ledger = openLedger(file);
  assert.deepEqual(ledger.claim([event('1042:OrderCreated')]), ['1042:OrderCreated']);
  ledger.record(['1042:OrderCreated'], { fbtraceId: 'FakeTrace' });

  const reopened = openLedger(file);
  const entry = reopened.get('1042:OrderCreated');
  assert.equal(entry.state, 'sent');
  assert.equal(entry.eventName, 'OrderCreated');
  assert.equal(entry.fbtraceId, 'FakeTrace');
  assert.match(entry.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.deepEqual(reopened.claim([event('1042:OrderCreated')]), []);
});

test("still refuses the same event a week later, long after Meta's 48 hours", () => {
  const file = tempLedger();
  const ledger = openLedger(file);
  ledger.claim([event('7:Purchase', 'Purchase')], { now: new Date('2026-09-01T10:00:00Z') });
  ledger.record(['7:Purchase'], { now: new Date('2026-09-01T10:00:02Z') });
  const weekLater = openLedger(file).claim([event('7:Purchase', 'Purchase')], { now: new Date('2026-09-08T10:00:00Z') });
  assert.deepEqual(weekLater, []);
});

test('another run sees an event that is still being sent', () => {
  const file = tempLedger();
  const first = openLedger(file);
  const second = openLedger(file);
  assert.deepEqual(first.claim([event('1:OrderCreated')]), ['1:OrderCreated']);
  assert.deepEqual(second.claim([event('1:OrderCreated')]), []);
  assert.equal(second.get('1:OrderCreated').state, 'sending');
});

test('a send Meta did not take gives the event back, a sent one is kept', () => {
  const file = tempLedger();
  const ledger = openLedger(file);
  ledger.claim([event('9:OrderCreated'), event('10:OrderCreated')]);
  ledger.record(['10:OrderCreated']);
  ledger.release(['9:OrderCreated', '10:OrderCreated']);
  const reopened = openLedger(file);
  assert.equal(reopened.has('9:OrderCreated'), false);
  assert.equal(reopened.get('10:OrderCreated').state, 'sent');
});

test('refuses to start over from a damaged file', () => {
  const file = tempLedger();
  fs.writeFileSync(file, '{"format":1,"events":{');
  assert.throws(() => openLedger(file), /not valid JSON/);
  fs.writeFileSync(file, '[]');
  assert.throws(() => openLedger(file), /not a ledger/);
});

test('replaces the file in one step and leaves nothing behind', () => {
  const file = tempLedger();
  const ledger = openLedger(file);
  ledger.claim([event('1:OrderCreated')]);
  ledger.record(['1:OrderCreated']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ledger.json']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).format, 1);
});
