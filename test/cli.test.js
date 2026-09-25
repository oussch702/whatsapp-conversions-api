import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HELP, run } from '../src/cli.js';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const WABA = '100000000000001';
const DATASET = '200000000000002';
const TOKEN = 'secret-token-sentinel';

const sink = () => {
  const out = { text: '', write: (chunk) => ((out.text += chunk), true) };
  return out;
};
const noNetwork = async () => {
  throw new Error('These commands must not use the network.');
};
const cli = async (args, env = {}) => {
  const stdout = sink();
  const stderr = sink();
  const code = await run(args, { stdout, stderr, env, now: NOW, fetchImpl: noNetwork });
  return { code, out: stdout.text, err: stderr.text };
};
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capi-cli-'));

test('prints help', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.out, HELP);
});

test('a dry run prints the exact payload and the checks, and sends nothing', async () => {
  const ledger = path.join(tempDir(), 'ledger.json');
  const args = ['send', '--dry-run', '--dataset', DATASET, '--waba', WABA, '--event', 'Purchase', '--ctwa-clid', 'ARexampleClick'];
  const result = await cli([...args, '--order-id', '1042', '--value', '49.90', '--currency', 'eur', '--ledger', ledger], { META_ACCESS_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.out.slice(result.out.indexOf('{'), result.out.lastIndexOf('}') + 1));
  assert.deepEqual(payload, {
    event_name: 'Purchase',
    event_time: NOW / 1000,
    event_id: '1042:Purchase',
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: WABA, ctwa_clid: 'ARexampleClick' },
    custom_data: { value: 49.9, currency: 'EUR', order_id: '1042' },
  });
  assert.match(result.out, /Checks: nothing Meta is known to refuse\./);
  assert.match(result.out, /Dry run: nothing was sent\./);
  assert.doesNotMatch(result.out + result.err, new RegExp(TOKEN));
  assert.equal(fs.existsSync(ledger), false);
});

test('a dry run lists what Meta would refuse, and exits with 1', async () => {
  const args = ['send', '--dry-run', '--no-ledger', '--waba', WABA, '--event', 'Lead', '--ctwa-clid', 'ARexampleClick', '--order-id', '1043'];
  const result = await cli([...args, '--value', '49,90']);
  assert.equal(result.code, 1);
  assert.match(result.out, /error {4}event_name +Meta refuses "Lead" for WhatsApp events \(2804066\)\. Use LeadSubmitted/);
  assert.match(result.out, /value must be a number, such as 49\.9, not "49,90"/);
  assert.match(result.out, /2 problems Meta would refuse\. Dry run: nothing was sent\./);
});

test('a real send with a problem stops before asking for a token', async () => {
  const args = ['send', '--no-ledger', '--dataset', DATASET, '--waba', WABA, '--event', 'OrderCreated', '--ctwa-clid', 'ARexampleClick'];
  const result = await cli([...args, '--order-id', '1']);
  assert.equal(result.code, 1);
  assert.match(result.out, /OrderCreated needs custom_data\.currency\. The live API refused an OrderCreated event without one \(2804081\)\./);
  assert.match(result.out, /1 problem Meta would refuse\. Nothing was sent\./);
});

test('asks for a token when there is none', async () => {
  const args = ['send', '--no-ledger', '--dataset', DATASET, '--waba', WABA, '--event', 'OrderCreated', '--ctwa-clid', 'ARexampleClick'];
  const result = await cli([...args, '--order-id', '1', '--value', '10', '--currency', 'USD']);
  assert.equal(result.code, 2);
  assert.equal(result.err, 'No access token. Set META_ACCESS_TOKEN, or pass --token-file <file>.\n');
});

test('rejects options that cannot work', async () => {
  assert.equal((await cli(['send', '--dry-run', '--event', 'OrderCreated'])).code, 2);
  assert.match((await cli(['send', '--dry-run', '--event', 'OrderCreated'])).err, /--order-id or --event-id is required/);
  assert.equal((await cli(['send', '--dataset', 'my-pixel', '--event', 'OrderCreated', '--order-id', '1'])).code, 2);
  assert.equal((await cli(['send', '--event', 'OrderCreated', '--order-id', '1'])).code, 2);
  assert.equal((await cli(['send', '--unknown-flag'])).code, 2);
  assert.equal((await cli(['frobnicate'])).code, 2);
});

test('validates a JSON Lines file, line by line', async () => {
  const file = path.join(tempDir(), 'events.jsonl');
  const base = {
    event_time: NOW / 1000 - 3600,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: WABA, ctwa_clid: 'ARexampleClick' },
  };
  const events = [
    { ...base, event_name: 'OrderCreated', event_id: '1041:OrderCreated', custom_data: { value: 49.9, currency: 'EUR' } },
    { ...base, event_name: 'Lead', event_id: '1042:Lead' },
    { ...base, event_name: 'OrderCreated', event_id: '1043:OrderCreated', custom_data: { value: 49.9 } },
    { ...base, event_name: 'OrderCreated', event_id: '1041:OrderCreated', custom_data: { value: 49.9, currency: 'EUR' } },
  ];
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n\nnot json\n`);

  const result = await cli(['validate', file]);
  assert.equal(result.code, 1);
  assert.match(result.out, /· validate .*events\.jsonl · 5 events/);
  assert.match(result.out, /^line 1 {2}OrderCreated {2}1041:OrderCreated {2}ok$/m);
  assert.match(result.out, /^line 2 {2}Lead {2}1042:Lead\n {2}error .*\(2804066\)/m);
  assert.match(result.out, /^line 3 {2}OrderCreated {2}1043:OrderCreated\n {2}error .*\(2804081\)/m);
  assert.match(result.out, /Same event_id as line 1\. Send it once\./);
  assert.match(result.out, /^line 6\n {2}error {4}line {2}Not valid JSON\./m);
  assert.match(result.out, /4 of 5 events would be refused\.$/m);
});

test('validates whole request bodies too', async () => {
  const file = path.join(tempDir(), 'requests.jsonl');
  const event = {
    event_name: 'ViewContent',
    event_time: NOW / 1000,
    event_id: 'chat-1:ViewContent',
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: WABA, ctwa_clid: 'ARexampleClick' },
  };
  fs.writeFileSync(file, `${JSON.stringify({ data: [event, { ...event, event_id: 'chat-2:ViewContent' }] })}\n`);
  const result = await cli(['validate', file]);
  assert.equal(result.code, 0);
  assert.match(result.out, /^line 1, event 2 {2}ViewContent {2}chat-2:ViewContent {2}ok$/m);
  assert.match(result.out, /All 2 events pass the checks\./);
});

test('explains a code, and a saved error response', async () => {
  const byCode = await cli(['explain', '2804081']);
  assert.equal(byCode.code, 0);
  assert.match(byCode.out, /^subcode 2804081 · Currency missing$/m);
  assert.match(byCode.out, /Source: Seen on the live API in September 2026\./);

  const file = path.join(tempDir(), 'error.json');
  fs.writeFileSync(file, JSON.stringify({ error: { code: 100, error_subcode: 2804131, error_user_msg: 'no Page associated to dataset', fbtrace_id: 'FakeTrace' } }));
  const byFile = await cli(['explain', file]);
  assert.match(byFile.out, /^code 100 · subcode 2804131 · No Page associated to the dataset$/m);
  assert.match(byFile.out, /Meta's message: no Page associated to dataset/);
  assert.match(byFile.out, /fbtrace_id: FakeTrace/);

  assert.equal((await cli(['explain', '99999'])).code, 1);
  assert.equal((await cli(['explain', '/nonexistent/error.json'])).code, 2);
});
