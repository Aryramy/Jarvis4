#!/usr/bin/env node

/**
 * Minimal CLI entry point for JARVIS4 (Brick 1).
 * Passes command line arguments to the text processing core.
 */

import { handleText } from '../core/textCore.js';

const args = process.argv.slice(2);
const input = args.join(' ');

const result = handleText(input);

if (result.success) {
  console.log(result.response);
  process.exit(0);
} else {
  console.error(`Error: ${result.error}`);
  process.exit(1);
}
