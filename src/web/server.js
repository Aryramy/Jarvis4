/**
 * Minimal local HTTP web server for JARVIS4 (Brick 2).
 * Serves the web interface and routes /api/text requests to handleText().
 */

import { createServer as createHttpServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleText } from '../core/textCore.js';
import { CheaperInferenceProvider } from '../providers/cheaperInference.js';
import { ConversationSession } from '../core/conversationSession.js';
import { ConversationStore } from '../core/conversationStore.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HTML_FILE_PATH = join(__dirname, 'index.html');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

/**
 * Creates the HTTP request listener.
 * @param {Object} [options]
 * @param {import('../providers/cheaperInference.js').CheaperInferenceProvider} [options.provider]
 * @param {import('../core/conversationSession.js').ConversationSession} [options.session]
 * @returns {import('node:http').RequestListener}
 */
export function createRequestListener(options = {}) {
  let htmlContent = '';
  if (existsSync(HTML_FILE_PATH)) {
    htmlContent = readFileSync(HTML_FILE_PATH, 'utf8');
  }

  const store = options.store !== undefined
    ? options.store
    : (options.session ? null : new ConversationStore());
  const session = options.session || new ConversationSession();

  // Restore persisted messages on startup if session is not already populated
  if (store && session.size === 0) {
    try {
      const persisted = store.load();
      if (Array.isArray(persisted) && persisted.length > 0) {
        session.load(persisted);
      }
    } catch {
      // Safe fallback
    }
  }

  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Route: GET /
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(htmlContent);
      return;
    }

    // Route: /api/text (Brick 2 deterministic endpoint)
    if (url.pathname === '/api/text') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          // 1MB limit for safety
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const input = parsedBody.input;
        const result = handleText(input);

        const statusCode = result.success ? 200 : 400;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });

      return;
    }

    // Route: /api/ai/stream (Brick 5 streaming AI endpoint & Brick 7 streaming conversation context)
    if (url.pathname === '/api/ai/stream') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const input = parsedBody.input;
        if (typeof input !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input must be a string' }));
          return;
        }

        const trimmedInput = input.trim();
        if (trimmedInput.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input cannot be empty' }));
          return;
        }

        const provider = options.provider || new CheaperInferenceProvider();

        const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
        if (!configCheck.valid) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Configuration error: ${configCheck.error}`
          }));
          return;
        }

        let userTurnAdded = false;
        let streamCompletedCleanly = false;
        let accumulatedText = '';
        let clientDisconnected = false;

        const rollbackUserTurn = () => {
          if (userTurnAdded && !streamCompletedCleanly) {
            session.pop();
            userTurnAdded = false;
          }
        };

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Transfer-Encoding': 'chunked'
        });

        res.on('close', () => {
          if (!res.writableEnded) {
            clientDisconnected = true;
            rollbackUserTurn();
          }
        });

        try {
          // Add user message to session context
          session.addUserMessage(trimmedInput);
          userTurnAdded = true;

          const messages = session.getMessages();

          const streamSource = typeof provider.streamMessages === 'function'
            ? provider.streamMessages(messages)
            : provider.stream(trimmedInput);

          for await (const delta of streamSource) {
            if (clientDisconnected || res.destroyed || res.writableEnded) {
              break;
            }
            accumulatedText += delta;
            res.write(JSON.stringify({ type: 'delta', text: delta }) + '\n');
          }

          if (!res.writableEnded && !clientDisconnected) {
            streamCompletedCleanly = true;
            // Store accumulated assistant response only after clean completion
            session.addAssistantMessage(accumulatedText);

            if (store) {
              try {
                store.save(session.getMessages());
              } catch {
                // Safe fallback
              }
            }

            res.write(JSON.stringify({ type: 'done' }) + '\n');
            res.end();
          } else {
            rollbackUserTurn();
            if (!res.writableEnded) {
              res.end();
            }
          }
        } catch (err) {
          // Stream error occurred: roll back user turn to keep conversation state uncorrupted
          rollbackUserTurn();

          if (!res.writableEnded && !clientDisconnected) {
            let safeError = err.message || 'Stream request failed';
            const apiKeyToRedact = provider.apiKey || process.env.CHEAPER_INFERENCE_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }
            res.write(JSON.stringify({ type: 'error', message: safeError }) + '\n');
            res.end();
          }
        }
      });

      return;
    }

    // Route: /api/conversation/clear (Brick 6 clear conversation endpoint)
    if (url.pathname === '/api/conversation/clear') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      req.on('data', () => {});
      req.on('end', () => {
        session.clear();
        if (store) {
          try {
            store.clear();
          } catch {
            // Safe fallback
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      return;
    }

    // Route: /api/ai (Brick 4 real AI endpoint & Brick 6 conversation context)
    if (url.pathname === '/api/ai') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
        return;
      }

      let body = '';
      let isTooLarge = false;

      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          isTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        if (isTooLarge) return;

        let parsedBody;
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const input = parsedBody.input;
        if (typeof input !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input must be a string' }));
          return;
        }

        const trimmedInput = input.trim();
        if (trimmedInput.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Input cannot be empty' }));
          return;
        }

        let userTurnAdded = false;

        try {
          const provider = options.provider || new CheaperInferenceProvider();

          const configCheck = provider.validateConfig ? provider.validateConfig() : { valid: true };
          if (!configCheck.valid) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `Configuration error: ${configCheck.error}`
            }));
            return;
          }

          // Add user message to session context
          session.addUserMessage(trimmedInput);
          userTurnAdded = true;

          const messages = session.getMessages();

          const result = typeof provider.generateMessages === 'function'
            ? await provider.generateMessages(messages)
            : await provider.generate(trimmedInput);

          if (result.success) {
            // Store assistant response in session context
            session.addAssistantMessage(result.text);

            if (store) {
              try {
                store.save(session.getMessages());
              } catch {
                // Safe fallback
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              response: result.text
            }));
          } else {
            // Provider failed: roll back user turn so context remains clean and uncorrupted
            if (userTurnAdded) {
              session.pop();
            }

            let safeError = result.error || 'Provider request failed';
            const apiKeyToRedact = provider.apiKey || process.env.CHEAPER_INFERENCE_API_KEY;
            if (apiKeyToRedact) {
              safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
            }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: safeError
            }));
          }
        } catch (err) {
          // Exception occurred: roll back user turn so context remains clean and uncorrupted
          if (userTurnAdded) {
            session.pop();
          }

          let safeError = err.message || 'Internal server error';
          const apiKeyToRedact = (options.provider && options.provider.apiKey) || process.env.CHEAPER_INFERENCE_API_KEY;
          if (apiKeyToRedact) {
            safeError = safeError.replaceAll(apiKeyToRedact, '[REDACTED]');
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: safeError
          }));
        }
      });

      return;
    }

    // Route: 404 Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not Found' }));
  };
}

/**
 * Creates the HTTP server instance.
 * @param {Object} [options]
 * @returns {import('node:http').Server}
 */
export function createServer(options = {}) {
  return createHttpServer(createRequestListener(options));
}

/**
 * Starts the server on the specified port and host.
 * @param {number} [port]
 * @param {string} [host]
 * @param {Object} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(port = Number(process.env.PORT) || DEFAULT_PORT, host = DEFAULT_HOST, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(options);

    server.once('error', (err) => {
      rejectPromise(err);
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      console.log(`JARVIS4 web interface running at http://${host}:${actualPort}`);
      resolvePromise(server);
    });
  });
}

// Start server if executed directly
const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start web server:', err.message);
    process.exit(1);
  });
}

export default {
  createServer,
  startServer,
  createRequestListener
};
