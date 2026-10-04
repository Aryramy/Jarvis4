/**
 * Minimal deterministic text request/response core for JARVIS4 (Brick 1).
 *
 * Receives text input, validates, normalizes surrounding whitespace,
 * and produces a deterministic structured response.
 *
 * NOTE: As per Brick 1 rules, there is NO AI, LLM, or external processing.
 */

/**
 * Handles text input deterministically.
 *
 * @param {unknown} input - Raw text input to process
 * @returns {{ success: boolean, input?: string, response?: string, error?: string }}
 */
export function handleText(input) {
  if (typeof input !== 'string') {
    return {
      success: false,
      error: 'Input must be a string',
      input
    };
  }

  const normalized = input.trim();

  if (normalized.length === 0) {
    return {
      success: false,
      error: 'Input cannot be empty',
      input
    };
  }

  return {
    success: true,
    input: normalized,
    response: `JARVIS received: ${normalized}`
  };
}

export default {
  handleText
};
