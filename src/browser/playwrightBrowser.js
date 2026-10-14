/**
 * Playwright Browser Adapter for JARVIS4 (Brick 26).
 * Direct integration with playwright-core using system browser channels (default: msedge).
 * 
 * Strict invariants:
 * - Uses playwright-core (never bundled browser download).
 * - System channel only (default: msedge).
 * - No persistent profile, no userDataDir, no cookies/history access.
 * - Blank page only (about:blank). No page.goto.
 */

import { chromium } from 'playwright-core';

/**
 * Default Playwright launcher using playwright-core.
 * Launches a browser using the configured channel, headless setting, and timeout.
 *
 * @param {Object} options
 * @param {string} [options.channel='msedge']
 * @param {boolean} [options.headless=false]
 * @param {number} [options.timeout=15000]
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function defaultPlaywrightLauncher(options = {}) {
  const {
    channel = 'msedge',
    headless = false,
    timeout = 15000,
    args = []
  } = options;

  return await chromium.launch({
    channel,
    headless,
    timeout,
    args
  });
}

export { chromium };
