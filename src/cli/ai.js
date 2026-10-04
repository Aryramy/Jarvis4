#!/usr/bin/env node

/**
 * Live AI CLI entry point for JARVIS4 (Brick 3).
 * Sends user prompt to the configured Cheaper Inference provider.
 */

import { CheaperInferenceProvider } from '../providers/cheaperInference.js';

const args = process.argv.slice(2);
const prompt = args.join(' ').trim();

if (!prompt) {
  console.error('Error: Prompt cannot be empty. Usage: npm run ai -- "<prompt>"');
  process.exit(1);
}

const provider = new CheaperInferenceProvider();

const configCheck = provider.validateConfig();
if (!configCheck.valid) {
  console.error(`Error: Configuration error: ${configCheck.error}`);
  console.error('Please configure CHEAPER_INFERENCE_API_KEY and CHEAPER_INFERENCE_MODEL in your environment.');
  process.exit(1);
}

try {
  const result = await provider.generate(prompt);

  if (result.success) {
    console.log(result.text);
    process.exit(0);
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: Unexpected failure: ${err.message}`);
  process.exit(1);
}
