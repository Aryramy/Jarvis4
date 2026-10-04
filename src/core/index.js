/**
 * Core entry point for JARVIS4 (Brick 0 Foundation).
 *
 * NOTE: As per Brick 0 rules, no AI, voice, automation, or provider
 * capabilities are implemented here.
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const FOUNDATION_INFO = Object.freeze({
  name: 'JARVIS4',
  brick: 0,
  brickName: 'BRICK-000 — Project Foundation',
  status: 'FOUNDATION',
  nodeVersion: process.version
});

export function getSystemStatus() {
  return {
    ...FOUNDATION_INFO,
    config: {
      nodeEnv: config.nodeEnv,
      logLevel: config.logLevel
    },
    timestamp: new Date().toISOString()
  };
}

export { config, logger };

export default {
  FOUNDATION_INFO,
  getSystemStatus,
  config,
  logger
};
