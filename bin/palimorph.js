#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`\x1b[33m✖\x1b[0m ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
