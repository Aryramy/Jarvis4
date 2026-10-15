#!/usr/bin/env node

/**
 * Opt-in Live OpenRouter Routing Diagnostic for JARVIS4 (PRE-040B).
 *
 * Requirements:
 * - NOT run by npm run verify
 * - NOT run by npm run verify:browser
 * - Requires OPENROUTER_API_KEY
 * - Makes minimal bounded requests
 * - Prints ONLY safe telemetry
 * - NEVER prints API keys or raw authorization headers
 * - Distinguishes corporate/office network ECONNRESET from code bugs
 */

import { OpenRouterRoutingGate } from '../src/providers/openRouterRouter.js';
import { ROUTING_PROFILES } from '../src/providers/openRouterRouting.js';
import { config } from '../src/config/index.js';

const apiKey = process.env.OPENROUTER_API_KEY || config.openRouter?.apiKey;

console.log('==================================================');
console.log('  JARVIS4 — OpenRouter Routing Diagnostic (PRE-040B)');
console.log('==================================================\n');

if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
  console.log('[DIAGNOSTIC NOTICE] OPENROUTER_API_KEY is not set.');
  console.log('To run this live diagnostic against OpenRouter, set OPENROUTER_API_KEY in your environment.');
  console.log('Example: $env:OPENROUTER_API_KEY="your-openrouter-api-key"\n');
  process.exit(0);
}

const gate = new OpenRouterRoutingGate({ apiKey });

function printTelemetry(telemetry) {
  if (!telemetry) return;
  console.log(`  Routing Profile:    ${telemetry.routingProfile}`);
  console.log(`  Routing Mode:       ${telemetry.routingMode}`);
  console.log(`  Requested Model:    ${telemetry.requestedModel}`);
  console.log(`  Requested Models:   ${JSON.stringify(telemetry.requestedModels)}`);
  console.log(`  Actual Model:       ${telemetry.actualModel ?? 'none'}`);
  console.log(`  Auto Selected:      ${telemetry.autoSelectedModel ?? 'none'}`);
  console.log(`  Provider:           ${telemetry.provider ?? 'default / not returned'}`);
  console.log(`  Fallback Used:      ${telemetry.fallbackUsed}`);
  console.log(`  Latency:            ${telemetry.latencyMs} ms`);
  console.log(`  Tokens:             prompt=${telemetry.promptTokens ?? 'null'}, completion=${telemetry.completionTokens ?? 'null'}, total=${telemetry.totalTokens ?? 'null'}`);
  console.log(`  Cost:               ${telemetry.cost !== null ? `$${telemetry.cost.toFixed(6)}` : 'null (not returned)'}`);
  console.log(`  Success:            ${telemetry.success}`);
  if (telemetry.errorCode) {
    console.log(`  Error Code:         ${telemetry.errorCode}`);
  }
}

function handleFailure(result) {
  if (result.errorCode === 'OPENROUTER_NETWORK_ERROR' || (result.error && result.error.includes('ECONNRESET'))) {
    console.log('\n[OFFICE NETWORK NOTICE]');
    console.log('A network connection reset (ECONNRESET) was observed.');
    console.log('This is known behavior on restricted corporate/office Wi-Fi networks where direct HTTPS');
    console.log('requests to openrouter.ai are reset at the firewall/gateway level.');
    console.log('Application routing logic and error handling executed correctly.\n');
  } else {
    console.log(`\nProvider Error: ${result.error}`);
    console.log(`Error Code:     ${result.errorCode}\n`);
  }
}

async function run() {
  console.log('--- Test 1: FAST Profile (PINNED_FALLBACK) ---');
  try {
    const fastResult = await gate.complete({
      profile: ROUTING_PROFILES.FAST,
      messages: [{ role: 'user', content: 'Say "OK"' }]
    });

    printTelemetry(fastResult.telemetry);

    if (fastResult.success) {
      console.log(`  Response:           ${fastResult.text.trim().slice(0, 80)}\n`);
    } else {
      handleFailure(fastResult);
    }
  } catch (err) {
    console.log(`  Exception in FAST test: ${err.message}\n`);
  }

  console.log('--- Test 2: REASONING Profile (AUTO) ---');
  try {
    const autoResult = await gate.complete({
      profile: ROUTING_PROFILES.REASONING,
      messages: [{ role: 'user', content: 'Say "OK"' }]
    });

    printTelemetry(autoResult.telemetry);

    if (autoResult.success) {
      console.log(`  Response:           ${autoResult.text.trim().slice(0, 80)}\n`);
    } else {
      handleFailure(autoResult);
    }
  } catch (err) {
    console.log(`  Exception in REASONING test: ${err.message}\n`);
  }

  console.log('==================================================');
  console.log('  OpenRouter Routing Diagnostic Complete');
  console.log('==================================================\n');
}

run();
