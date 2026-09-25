import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { buildEvent } from './event.js';
import { explainError } from './errors.js';
import { openLedger } from './ledger.js';
import { describeLedgerEntry, formatExplanation, formatProblems, plural } from './report.js';
import { ConversionsApiError, DEFAULT_API_VERSION, sendEvents } from './send.js';
import { validateEvent } from './validate.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NAME = 'whatsapp-conversions-api';

export const HELP = `${NAME} ${VERSION}
Send Meta Conversions API events for click-to-WhatsApp ads, checked before they leave your server.

Usage
  ${NAME} send --dataset <id> --waba <id> --event <name> --ctwa-clid <id> --order-id <id> [options]
  ${NAME} validate <events.jsonl> [--dataset <id>]
  ${NAME} explain <code, or a file with Meta's error response>

send
  --dataset          Dataset linked to your WhatsApp Business Account (default: META_DATASET_ID)
  --waba             WhatsApp Business Account ID (default: META_WABA_ID)
  --event            Event name, such as OrderCreated or Purchase
  --ctwa-clid        Ad click ID, from referral.ctwa_clid in the message that came from the ad
  --order-id         Your order ID. The event ID becomes <order-id>:<event>
  --event-id         Your own stable event ID, for an event without an order
  --value            Order value, such as 49.90
  --currency         Three-letter currency code, such as EUR
  --time             When it happened: Unix seconds or an ISO date (default: now)
  --phone            Customer phone with country code, hashed with SHA-256 before sending
  --email            Customer email, hashed with SHA-256 before sending
  --test-event-code  Code from the Test Events tab in Events Manager
  --token-file       File holding the access token (default: META_ACCESS_TOKEN)
  --ledger           Ledger of event IDs already sent (default: ./capi-ledger.json)
  --no-ledger        Neither read nor write the ledger
  --api-version      Graph API version (default: ${DEFAULT_API_VERSION})
  --skip-checks      Send even when a check fails, for a rule Meta has since changed
  --dry-run          Print the payload and the checks, and send nothing

  -h, --help         Show this help
  -v, --version      Show the version

The token is never printed. Meta refuses events more than 7 days old.
`;

const OPTIONS = {
  dataset: { type: 'string' },
  waba: { type: 'string' },
  event: { type: 'string' },
  'ctwa-clid': { type: 'string' },
  'order-id': { type: 'string' },
  'event-id': { type: 'string' },
  value: { type: 'string' },
  currency: { type: 'string' },
  time: { type: 'string' },
  phone: { type: 'string' },
  email: { type: 'string' },
  'test-event-code': { type: 'string' },
  'token-file': { type: 'string' },
  ledger: { type: 'string', default: 'capi-ledger.json' },
  'no-ledger': { type: 'boolean', default: false },
  'api-version': { type: 'string', default: DEFAULT_API_VERSION },
  'skip-checks': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

/** A mistake on the command line: printed on its own, exit code 2. */
class UsageError extends Error {}

/** "49.90" becomes 49.9. Anything else stays text, for the checks to report. */
const parseValue = (value) => (value !== undefined && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value);

function readToken(file, env) {
  let token;
  if (file) {
    try {
      token = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new UsageError(`Cannot read the token file ${file}${err.code === 'ENOENT' ? ': file not found' : ''}.`);
    }
    if (!token) throw new UsageError(`The token file ${file} is empty.`);
    return token;
  }
  token = (env.META_ACCESS_TOKEN ?? '').trim();
  if (!token) throw new UsageError('No access token. Set META_ACCESS_TOKEN, or pass --token-file <file>.');
  return token;
}

async function send(o, positionals, { fetchImpl, out, env, now }) {
  if (positionals.length) throw new UsageError(`send takes options only, not "${positionals[0]}".`);
  const datasetId = (o.dataset ?? env.META_DATASET_ID)?.trim() || undefined;
  if (!o.event) throw new UsageError('--event is required, for example --event OrderCreated.');
  if (!o['order-id'] && !o['event-id']) {
    throw new UsageError('--order-id or --event-id is required: the ledger needs a stable ID to recognize a second send of the same event.');
  }
  if (datasetId !== undefined && !/^\d+$/.test(datasetId)) {
    throw new UsageError('--dataset must be the numeric ID of the dataset linked to your WhatsApp Business Account.');
  }
  if (!o['dry-run'] && !datasetId) throw new UsageError('--dataset is required to send, or set META_DATASET_ID.');
  if (!/^v\d+\.\d+$/.test(o['api-version'])) throw new UsageError(`--api-version looks like ${DEFAULT_API_VERSION}.`);

  const event = buildEvent({
    eventName: o.event,
    wabaId: o.waba ?? env.META_WABA_ID,
    ctwaClid: o['ctwa-clid'],
    orderId: o['order-id'],
    eventId: o['event-id'],
    eventTime: o.time,
    value: parseValue(o.value),
    currency: o.currency,
    phone: o.phone,
    email: o.email,
    now,
  });
  const problems = validateEvent(event, { now, datasetId });
  const errors = problems.filter((p) => p.level === 'error');
  const ledger = o['no-ledger'] ? null : openLedger(o.ledger);
  const previous = ledger?.get(event.event_id);

  out([NAME, o['dry-run'] && 'dry run', event.event_name, `event ${event.event_id}`, datasetId && `dataset ${datasetId}`].filter(Boolean).join(' · '));
  if (o['dry-run']) out(`\n${JSON.stringify(event, null, 2)}`);
  out();
  if (problems.length) {
    out('Checks');
    formatProblems(problems).forEach((line) => out(line));
  } else {
    out('Checks: nothing Meta is known to refuse.');
  }
  const refused = errors.length ? `${plural(errors.length, 'problem')} Meta would refuse. ` : '';
  const notSent = (entry) => {
    const { reason, remedy } = describeLedgerEntry(entry, ledger.file);
    out(`\nNot sent: ${reason}.`);
    out(remedy);
    return entry.state === 'sent' ? 0 : 1;
  };

  if (o['dry-run']) {
    if (previous) {
      const { reason, remedy } = describeLedgerEntry(previous, ledger.file);
      out(`\nA real send would stop here: ${reason}. ${remedy}`);
    }
    out(`\n${refused}Dry run: nothing was sent.`);
    return errors.length ? 1 : 0;
  }
  if (errors.length && !o['skip-checks']) {
    out(`\n${refused}Nothing was sent.`);
    return 1;
  }
  if (previous) return notSent(previous);

  const accessToken = readToken(o['token-file'], env);
  let result;
  try {
    result = await sendEvents({
      datasetId,
      accessToken,
      events: [event],
      testEventCode: o['test-event-code'],
      apiVersion: o['api-version'],
      fetch: fetchImpl,
      ledger,
      skipChecks: o['skip-checks'],
      now,
    });
  } catch (err) {
    if (!(err instanceof ConversionsApiError)) throw err;
    out();
    if (err.kind === 'rejected' && err.explanation) {
      out('Meta refused the event.');
      out(formatExplanation(err.explanation));
      out(`\nNothing was recorded${ledger ? ' in the ledger' : ''}, so the event can be sent again once it is fixed.`);
    } else if (err.explanation) {
      out(formatExplanation(err.explanation));
      out(`\n${err.message}`);
    } else {
      out(err.message);
      if (err.problems.length) formatProblems(err.problems).forEach((line) => out(line));
    }
    return 1;
  }

  if (result.skipped.length) return notSent(result.skipped[0]);
  out(`\nSent. Meta received ${plural(result.eventsReceived, 'event')}${result.fbtraceId ? ` (fbtrace_id ${result.fbtraceId})` : ''}.`);
  if (o['test-event-code']) out(`Sent with test event code ${o['test-event-code']}: it shows in the Test Events tab of Events Manager.`);
  if (result.messages.length) out(`Meta's messages: ${result.messages.join(' ')}`);
  out(ledger ? `Recorded in ${ledger.file}.` : 'No ledger: nothing stops this event from being sent again.');
  return 0;
}

function validate(o, positionals, { out, env, now }) {
  const [file] = positionals;
  if (!file) throw new UsageError('validate needs a JSON Lines file, with one event per line.');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`Cannot read ${file}.`);
  }
  const datasetId = (o.dataset ?? env.META_DATASET_ID)?.trim() || undefined;

  const checked = [];
  const seen = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      checked.push({ label: `line ${i + 1}`, problems: [{ level: 'error', field: 'line', message: 'Not valid JSON.' }] });
      return;
    }
    // A line can hold one event, or a whole request body with its data array.
    const isBody = Array.isArray(parsed?.data);
    const events = isBody ? parsed.data : [parsed];
    events.forEach((event, j) => {
      const label = isBody ? `line ${i + 1}, event ${j + 1}` : `line ${i + 1}`;
      const problems = validateEvent(event, { now, datasetId });
      const id = event?.event_id;
      if (id !== undefined && id !== null && id !== '') {
        if (seen.has(id)) problems.push({ level: 'error', field: 'event_id', message: `Same event_id as ${seen.get(id)}. Send it once.` });
        else seen.set(id, label);
      }
      checked.push({ label, event, problems });
    });
  });
  if (!checked.length) {
    out(`No events in ${file}.`);
    return 1;
  }

  out(`${NAME} · validate ${file} · ${plural(checked.length, 'event')}`);
  out();
  for (const { label, event, problems } of checked) {
    const name = typeof event?.event_name === 'string' ? event.event_name : null;
    const id = event?.event_id ?? null;
    out([label, name, id, problems.length ? null : 'ok'].filter((part) => part !== null && part !== '').join('  '));
    if (problems.length) formatProblems(problems).forEach((line) => out(line));
  }
  const refused = checked.filter((c) => c.problems.some((p) => p.level === 'error')).length;
  const warnings = checked.reduce((n, c) => n + c.problems.filter((p) => p.level === 'warning').length, 0);
  out();
  if (refused) out(`${refused} of ${plural(checked.length, 'event')} would be refused.`);
  else if (warnings) out(`No event would be refused. ${plural(warnings, 'warning')} to read.`);
  else out(`All ${plural(checked.length, 'event')} pass the checks.`);
  return refused ? 1 : 0;
}

function explain(positionals, { out }) {
  const [arg] = positionals;
  if (!arg) throw new UsageError("explain needs an error code, such as 2804066, or a file with Meta's error response.");
  let input = arg;
  if (!/^\d+$/.test(arg.trim()) && !arg.trim().startsWith('{')) {
    try {
      input = fs.readFileSync(arg, 'utf8');
    } catch {
      throw new UsageError(`"${arg}" is neither an error code nor a file that can be read.`);
    }
  }
  const explanation = explainError(input);
  out(formatExplanation(explanation));
  return explanation.known ? 0 : 1;
}

export async function run(argv, { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, env = process.env, now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    stderr.write(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const o = parsed.values;
  const [command, ...rest] = parsed.positionals;
  if (o.help || command === 'help') {
    stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  const out = (line = '') => stdout.write(`${line}\n`);
  try {
    if (command === 'send') return await send(o, rest, { fetchImpl, out, env, now });
    if (command === 'validate') return validate(o, rest, { out, env, now });
    if (command === 'explain') return explain(rest, { out });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`${err.message}\n`);
    return 2;
  }
  stderr.write(command ? `Unknown command "${command}".\n\n${HELP}` : HELP);
  return 2;
}
