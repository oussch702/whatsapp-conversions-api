// Plain-text output for the command line.

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const when = (iso) => (iso ? `on ${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC` : 'at an unknown time');

/** One line per problem, with the level and field columns aligned. */
export function formatProblems(problems, indent = '  ') {
  const width = Math.max(...problems.map((p) => p.field.length));
  return problems.map((p) => `${indent}${p.level.padEnd(7)}  ${p.field.padEnd(width)}  ${p.message}`);
}

/** What an error means and what to change, as printed by explain and after a refused send. */
export function formatExplanation(e) {
  const ids = [e.code !== null && `code ${e.code}`, e.subcode !== null && `subcode ${e.subcode}`].filter(Boolean);
  const lines = [[...ids, e.title].join(' · ')];
  if (e.metaTitle) lines.push(`  Meta's title: ${e.metaTitle}`);
  if (e.metaMessage || e.message) lines.push(`  Meta's message: ${e.metaMessage || e.message}`);
  lines.push(`  What it means: ${e.meaning}`, `  Fix: ${e.fix}`);
  if (e.retry) lines.push('  Safe to send again after a short wait.');
  if (e.source) lines.push(`  Source: ${e.source}`);
  if (e.fbtraceId) lines.push(`  fbtrace_id: ${e.fbtraceId} (quote it if you ask Meta support)`);
  return lines.join('\n');
}

/** Why the ledger stops an event from going out again, and what to do about it. */
export function describeLedgerEntry(entry, file) {
  if (entry.state === 'sending') {
    return {
      reason: `a send of this event started ${when(entry.startedAt)} and never finished, so Meta may have it`,
      remedy: `Check the dataset in Events Manager. If the event is not there, delete its entry from ${file} and send again.`,
    };
  }
  return {
    reason: `this event already went out ${when(entry.sentAt)}, according to ${file}`,
    remedy: 'To send it again on purpose, delete its entry from the ledger.',
  };
}
