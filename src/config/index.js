/**
 * Configuration module for JARVIS4 (Brick 0 Foundation).
 * Safely loads and validates configuration without requiring external keys.
 */

const VALID_ENVIRONMENTS = ['development', 'test', 'production'];
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Loads and validates current configuration.
 * @param {Object} [overrides={}] - Optional manual overrides for testing
 * @returns {Readonly<{nodeEnv: string, logLevel: string, isProduction: boolean, isTest: boolean}>}
 */
export function loadConfig(overrides = {}) {
  const nodeEnv = (overrides.NODE_ENV || process.env.NODE_ENV || 'development').toLowerCase().trim();
  const logLevel = (overrides.LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase().trim();

  if (!VALID_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: "${nodeEnv}". Allowed values: ${VALID_ENVIRONMENTS.join(', ')}`);
  }

  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: "${logLevel}". Allowed values: ${VALID_LOG_LEVELS.join(', ')}`);
  }

  return Object.freeze({
    nodeEnv,
    logLevel,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test'
  });
}

export const config = loadConfig();

export default config;
