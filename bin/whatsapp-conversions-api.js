#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`whatsapp-conversions-api: ${err.message}\n`);
    process.exitCode = 1;
  },
);
