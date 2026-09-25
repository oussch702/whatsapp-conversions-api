// A JSON file of every event ID sent, so an order is never sent twice: not after a retry, a crash,
// or a replay a week later. Meta does not deduplicate business messaging events for you.
//
// An ID is written as "sending" before the request leaves and becomes "sent" once Meta confirms it.
// A failed send removes it again. An ID left in "sending" (a crash, or a connection cut after the
// request left) blocks further sends until someone checks Events Manager: never twice beats never late.
import fs from 'node:fs';
import path from 'node:path';

const FORMAT = 1;

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot read the ledger ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The ledger ${file} is not valid JSON. Restore it before sending: an empty ledger would let orders go out twice.`);
  }
  const events = data?.events;
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    throw new Error(`${file} is not a ledger written by whatsapp-conversions-api.`);
  }
  return events;
}

function save(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ format: FORMAT, events }, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export class Ledger {
  #file;
  #events;

  constructor(file) {
    if (!file) throw new TypeError('The ledger needs a file path.');
    this.#file = file;
    this.#events = load(file);
  }

  /** The ledger file, as given. */
  get file() {
    return this.#file;
  }

  /** Number of event IDs in the ledger, sent or still sending. */
  get size() {
    return Object.keys(this.#events).length;
  }

  /** { eventName, state: 'sent', sentAt, ... } or { eventName, state: 'sending', startedAt }, or undefined. */
  get(eventId) {
    return Object.hasOwn(this.#events, eventId) ? this.#events[eventId] : undefined;
  }

  has(eventId) {
    return this.get(eventId) !== undefined;
  }

  /**
   * Marks events as sending and returns the IDs that were free. IDs already in the ledger, in either
   * state, are left out: send only what this returns. The file is re-read first, so a send from
   * another run is seen.
   */
  claim(events, { now = new Date() } = {}) {
    this.#events = load(this.#file);
    const free = [];
    for (const { eventId, eventName } of events) {
      if (this.has(eventId)) continue;
      this.#events[eventId] = { eventName, state: 'sending', startedAt: now.toISOString() };
      free.push(eventId);
    }
    if (free.length) save(this.#file, this.#events);
    return free;
  }

  /** Removes IDs still marked as sending, after a send that Meta did not take. They can be sent again. */
  release(eventIds) {
    this.#events = load(this.#file);
    let changed = false;
    for (const id of eventIds) {
      if (this.get(id)?.state === 'sending') {
        delete this.#events[id];
        changed = true;
      }
    }
    if (changed) save(this.#file, this.#events);
  }

  /** Marks events as sent, with details worth keeping such as Meta's fbtrace_id. */
  record(eventIds, { now = new Date(), ...details } = {}) {
    this.#events = load(this.#file);
    for (const id of eventIds) {
      const eventName = this.get(id)?.eventName;
      this.#events[id] = { eventName, state: 'sent', sentAt: now.toISOString(), ...details };
    }
    save(this.#file, this.#events);
  }
}

/** Opens a ledger file, or starts an empty one that is written on the first send. */
export const openLedger = (file) => new Ledger(file);
